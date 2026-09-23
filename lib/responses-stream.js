import { randomUUID } from "node:crypto";
import { ProxyError } from "./errors.js";

const id = prefix => prefix + "_" + randomUUID().replaceAll("-", "");
const clone = value => structuredClone(value);

function upstreamError(message) {
  return new ProxyError(502, "upstream_error", message);
}

function textDelta(value, field) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (field === "content" && Array.isArray(value) && value.every(part => typeof part?.text === "string")) {
    return value.map(part => part.text).join("");
  }
  throw upstreamError("Upstream " + field + " must be text");
}

function usage(raw) {
  const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  const input = number(raw.prompt_tokens ?? raw.input_tokens);
  const output = number(raw.completion_tokens ?? raw.output_tokens);
  const inputDetails = raw.prompt_tokens_details ?? raw.input_tokens_details ?? {};
  const outputDetails = raw.completion_tokens_details ?? raw.output_tokens_details ?? {};
  return {
    input_tokens: input,
    input_tokens_details: {
      cached_tokens: number(inputDetails.cached_tokens),
      ...(inputDetails.cache_write_tokens != null ? { cache_write_tokens: number(inputDetails.cache_write_tokens) } : {})
    },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: number(outputDetails.reasoning_tokens) },
    total_tokens: raw.total_tokens == null ? input + output : number(raw.total_tokens)
  };
}

export function encodeResponseEvent(event) {
  return "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n";
}

// Both JSON and SSE use this state machine, so final objects and streamed
// snapshots describe exactly the same output. Only streaming builds events.
export class ResponsesAccumulator {
  constructor({ request, tools, responseTools, model, reasoningEffort, streaming = false, maxBytes = Number.POSITIVE_INFINITY }) {
    this.streaming = streaming;
    this.tools = tools;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.sequence = 0;
    this.started = false;
    this.terminal = false;
    this.finishReason = null;
    this.toolCalls = new Map();
    this.message = null;
    this.reasoning = null;
    this.rawUsage = {};
    this.response = {
      id: id("resp"), object: "response", created_at: Math.floor(Date.now() / 1000),
      status: "in_progress", background: false, error: null, incomplete_details: null,
      model, output: [], instructions: request.instructions ?? null,
      max_output_tokens: request.max_output_tokens ?? request.max_tokens ?? null,
      parallel_tool_calls: request.parallel_tool_calls ?? true,
      previous_response_id: null,
      reasoning: { effort: reasoningEffort ?? null, summary: request.reasoning?.summary ?? null },
      store: false,
      temperature: request.temperature ?? null,
      top_p: request.top_p ?? null,
      text: { format: request.text?.format ?? { type: "text" } },
      tool_choice: request.tool_choice ?? "auto", tools: responseTools,
      truncation: "disabled", usage: null, metadata: request.metadata ?? {}
    };
    this.account(JSON.stringify(this.response));
  }

  account(text) {
    this.bytes += Buffer.byteLength(text, "utf8");
    if (this.bytes > this.maxBytes) throw upstreamError("Responses output exceeded MAX_RESPONSE_BYTES");
  }

  event(events, type, fields) {
    if (this.streaming) events.push({ type, sequence_number: this.sequence++, ...clone(fields) });
  }

  start(events) {
    if (this.started) return;
    this.started = true;
    this.event(events, "response.created", { response: this.response });
    this.event(events, "response.in_progress", { response: this.response });
  }

  addItem(events, item) {
    this.account(JSON.stringify(item));
    const entry = { item, index: this.response.output.length };
    this.response.output.push(item);
    this.event(events, "response.output_item.added", { output_index: entry.index, item });
    return entry;
  }

  addReasoning(events, delta) {
    this.closeMessage(events);
    if (!this.reasoning) {
      this.reasoning = this.addItem(events, { id: id("rs"), type: "reasoning", status: "in_progress", summary: [] });
      const part = { type: "summary_text", text: "" };
      this.reasoning.item.summary.push(part);
      this.event(events, "response.reasoning_summary_part.added", {
        item_id: this.reasoning.item.id, output_index: this.reasoning.index, summary_index: 0, part
      });
    }
    this.account(delta);
    this.reasoning.item.summary[0].text += delta;
    this.event(events, "response.reasoning_summary_text.delta", {
      item_id: this.reasoning.item.id, output_index: this.reasoning.index, summary_index: 0, delta
    });
  }

  closeReasoning(events, status = "completed") {
    if (!this.reasoning) return;
    const { item, index } = this.reasoning;
    const part = item.summary[0];
    const location = { item_id: item.id, output_index: index, summary_index: 0 };
    this.event(events, "response.reasoning_summary_text.done", { ...location, text: part.text });
    this.event(events, "response.reasoning_summary_part.done", { ...location, part });
    item.status = status;
    this.event(events, "response.output_item.done", { output_index: index, item });
    this.reasoning = null;
  }

  addText(events, delta, type = "output_text") {
    this.closeReasoning(events);
    if (!this.message) {
      this.message = this.addItem(events, { id: id("msg"), type: "message", status: "in_progress", role: "assistant", content: [] });
    }
    const { item, index } = this.message;
    let contentIndex = item.content.findIndex(part => part.type === type);
    if (contentIndex < 0) {
      const part = type === "refusal" ? { type, refusal: "" } : { type, text: "", annotations: [], logprobs: [] };
      this.account(JSON.stringify(part));
      contentIndex = item.content.length;
      item.content.push(part);
      this.event(events, "response.content_part.added", { item_id: item.id, output_index: index, content_index: contentIndex, part });
    }
    this.account(delta);
    const field = type === "refusal" ? "refusal" : "text";
    item.content[contentIndex][field] += delta;
    if (delta) this.event(events, "response." + type + ".delta", {
      item_id: item.id, output_index: index, content_index: contentIndex, delta,
      ...(type === "output_text" ? { logprobs: [] } : {})
    });
  }

  closeMessage(events, status = "completed") {
    if (!this.message) return;
    const { item, index } = this.message;
    for (let contentIndex = 0; contentIndex < item.content.length; contentIndex++) {
      const part = item.content[contentIndex];
      const location = { item_id: item.id, output_index: index, content_index: contentIndex };
      this.event(events, "response." + part.type + ".done", {
        ...location, ...(part.type === "refusal" ? { refusal: part.refusal } : { text: part.text, logprobs: part.logprobs })
      });
      this.event(events, "response.content_part.done", { ...location, part });
    }
    item.status = status;
    this.event(events, "response.output_item.done", { output_index: index, item });
    this.message = null;
  }

  addTools(events, deltas) {
    if (deltas == null) return;
    if (!Array.isArray(deltas)) throw upstreamError("Upstream tool_calls must be an array");
    if (!deltas.length) return;
    this.closeReasoning(events);
    this.closeMessage(events);
    for (let position = 0; position < deltas.length; position++) {
      const delta = deltas[position];
      if (!delta || typeof delta !== "object") throw upstreamError("Invalid upstream tool call");
      const index = delta.index ?? position;
      if (!Number.isInteger(index) || index < 0) throw upstreamError("Invalid upstream tool index");
      let call = this.toolCalls.get(index);
      if (!call) {
        this.account(" ".repeat(256));
        call = { sourceId: "", name: "", arguments: "", sent: 0, entry: null };
        this.toolCalls.set(index, call);
      }
      if (delta.id != null && !call.entry) {
        const value = textDelta(delta.id, "tool id");
        if (value !== call.sourceId) { this.account(value); call.sourceId += value; }
      }
      if (delta.function?.name != null) {
        const value = textDelta(delta.function.name, "tool name");
        if (!(call.name === value && (call.entry || this.tools.has(value)))) {
          if (call.entry && value) throw upstreamError("Upstream changed a tool name after its arguments started");
          this.account(value);
          call.name += value;
        }
      }
      const argumentsDelta = delta.function?.arguments;
      if (argumentsDelta != null) {
        const value = typeof argumentsDelta === "string" ? argumentsDelta : JSON.stringify(argumentsDelta);
        this.account(value);
        call.arguments += value;
      }
      this.flushTool(events, call);
    }
  }

  flushTool(events, call, final = false) {
    if (!call.entry) {
      // Wait for the name and first arguments, allowing fragmented headers.
      if (!final && (!call.name || !call.arguments || (this.tools.size && !this.tools.has(call.name)))) return;
      if (!call.name) throw upstreamError("Upstream tool call has no function name");
      const definition = this.tools.get(call.name);
      const custom = definition?.type === "custom";
      const item = {
        id: id(custom ? "ctc" : "fc"), type: custom ? "custom_tool_call" : "function_call",
        status: "in_progress", call_id: call.sourceId || id("call"),
        name: definition?.name || call.name,
        ...(definition?.namespace ? { namespace: definition.namespace } : {}),
        ...(custom ? { input: "" } : { arguments: "" })
      };
      call.entry = this.addItem(events, item);
    }
    const { item, index } = call.entry;
    if (item.type === "custom_tool_call") {
      // The upstream uses a JSON wrapper. Emit raw input only once it is
      // complete; exposing fragments of the wrapper would corrupt tool input.
      if (!final) return;
      let input = call.arguments;
      try {
        const decoded = JSON.parse(input);
        if (typeof decoded?.input === "string") input = decoded.input;
      } catch { /* Some compatible providers return free-form text directly. */ }
      item.input = input;
      if (input) this.event(events, "response.custom_tool_call_input.delta", { item_id: item.id, output_index: index, delta: input });
    } else {
      const delta = call.arguments.slice(call.sent);
      item.arguments = call.arguments;
      if (delta) this.event(events, "response.function_call_arguments.delta", { item_id: item.id, output_index: index, delta });
      call.sent = call.arguments.length;
    }
  }

  add(chunk) {
    if (this.terminal) throw upstreamError("Received a chunk after the response ended");
    if (!Array.isArray(chunk.choices) || chunk.choices.length > 1 || chunk.choices.some(choice => choice.index !== 0)) {
      throw upstreamError("Responses requires a single upstream choice");
    }
    const events = [];
    if (typeof chunk.model === "string" && chunk.model) this.response.model = chunk.model;
    if (!this.started && typeof chunk.created === "number") this.response.created_at = chunk.created;
    this.start(events);
    if (chunk.usage && typeof chunk.usage === "object") {
      this.rawUsage = { ...this.rawUsage, ...chunk.usage };
      this.response.usage = usage(this.rawUsage);
    }
    for (const choice of chunk.choices) {
      const delta = choice.delta || {};
      const reasoning = textDelta(delta.reasoning_content ?? delta.reasoning, "reasoning");
      const content = textDelta(delta.content, "content");
      const refusal = textDelta(delta.refusal, "refusal");
      if (reasoning) this.addReasoning(events, reasoning);
      if (content) this.addText(events, content);
      if (refusal) this.addText(events, refusal, "refusal");
      this.addTools(events, delta.tool_calls ?? (delta.function_call ? [{ index: 0, function: delta.function_call }] : null));
      if (choice.finish_reason != null) this.finishReason = choice.finish_reason;
    }
    return events;
  }

  finish() {
    if (this.terminal) return [];
    const events = [];
    this.start(events);
    const reason = ["length", "max_tokens"].includes(this.finishReason) ? "max_output_tokens"
      : this.finishReason === "content_filter" ? "content_filter" : null;
    const status = reason ? "incomplete" : "completed";
    this.closeReasoning(events, status);
    if (!this.toolCalls.size && !this.response.output.some(item => item.type === "message")) this.addText(events, "");
    this.closeMessage(events, status);
    for (const call of this.toolCalls.values()) {
      if (!call.arguments && !reason) call.arguments = "{}";
      this.flushTool(events, call, true);
      const { item, index } = call.entry;
      const custom = item.type === "custom_tool_call";
      this.event(events, custom ? "response.custom_tool_call_input.done" : "response.function_call_arguments.done", {
        item_id: item.id, output_index: index, ...(custom ? { input: item.input } : { arguments: item.arguments, name: item.name })
      });
      item.status = status;
      this.event(events, "response.output_item.done", { output_index: index, item });
    }
    this.response.status = status;
    this.response.incomplete_details = reason ? { reason } : null;
    this.terminal = true;
    this.event(events, "response." + status, { response: this.response });
    return events;
  }

  fail(error) {
    if (this.terminal) return [];
    const events = [];
    this.response.status = "failed";
    this.response.error = { code: error.code || error.type || "upstream_error", message: error.message || "Upstream request failed" };
    for (const item of this.response.output) if (item.status === "in_progress") item.status = "incomplete";
    this.event(events, "error", { ...this.response.error, param: error.param ?? null });
    this.event(events, "response.failed", { response: this.response });
    this.terminal = true;
    return events;
  }

  result() {
    return clone(this.response);
  }
}
