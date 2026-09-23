import { randomUUID } from "node:crypto";
import { ProxyError } from "./errors.js";

// MiMo sometimes renders a tool call as text instead of native tool_calls, and the
// upstream gateway turns that text into JSON arguments by stopping at the first raw
// control character. Everything here keeps such payloads usable for the client:
// raw control characters are escaped, recoverable arguments are rebuilt from the
// text call, and only unrepairable JSON is reported as an error.
const OPEN_TAG = "<tool_call>";
const CLOSE_TAG = "</tool_call>";
const MAX_ARGUMENT_BYTES = Number.POSITIVE_INFINITY;
const MAX_HELD_TEXT_BYTES = Number.POSITIVE_INFINITY;
const META_FIELDS = ["id", "object", "created", "model"];

function invalidToolArguments(name, raw) {
  return new ProxyError(502, "upstream_error",
    "Upstream returned invalid JSON arguments for tool " + JSON.stringify(name || "") +
    " (" + Buffer.byteLength(raw, "utf8") + " bytes). The upstream parser truncated the arguments.",
    undefined, "invalid_tool_arguments");
}

function looksLikeJson(text) {
  return /^\s*[[{]/.test(text);
}

function mergeFragment(current, value) {
  return current && current !== value ? current + value : value;
}

// Longest suffix that may still become a "<tool_call>" opening tag.
function trailingTagPrefix(text) {
  const maximum = Math.min(text.length, OPEN_TAG.length - 1);
  for (let length = maximum; length > 0; length--) {
    if (text.endsWith(OPEN_TAG.slice(0, length))) return OPEN_TAG.slice(0, length);
  }
  return "";
}

function metadata(chunk) {
  const meta = {};
  for (const field of META_FIELDS) if (chunk[field] !== undefined) meta[field] = chunk[field];
  return meta;
}

function chunkFor(meta, index, delta, finishReason = null) {
  return { ...meta, choices: [{ index, delta, finish_reason: finishReason }] };
}

// JSON strings may not contain raw C0 control characters, but the upstream can emit
// them (Ctrl+C, NUL, ESC). Escape every such character that sits inside a string.
export function escapeRawControls(text) {
  if (typeof text !== "string" || !/[\u0000-\u001f]/.test(text)) return text;
  let result = "";
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) { escaped = false; result += character; continue; }
      if (character === "\\") { escaped = true; result += character; continue; }
      if (character === "\"") { inString = false; result += character; continue; }
      if (character.codePointAt(0) <= 0x1f) {
        result += "\\u" + character.codePointAt(0).toString(16).padStart(4, "0");
        continue;
      }
      result += character;
      continue;
    }
    if (character === "\"") inString = true;
    result += character;
  }
  return result;
}

// Returns null when the text cannot be turned into valid JSON at all.
export function repairToolArguments(raw) {
  if (typeof raw !== "string") return null;
  if (!raw.trim()) return { arguments: "{}", repaired: false, reason: "empty" };
  try {
    JSON.parse(raw);
    return { arguments: raw, repaired: false, reason: undefined };
  } catch { /* Try to repair raw control characters below. */ }
  const escaped = escapeRawControls(raw);
  if (escaped !== raw) {
    try {
      JSON.parse(escaped);
      return { arguments: escaped, repaired: true, reason: "raw_control_character" };
    } catch { /* Still truncated or otherwise broken. */ }
  }
  return null;
}

// Parses the MiMo text dialect:
//   <tool_call><function=name><parameter=key>value</parameter></function></tool_call>
export function parseTextToolCalls(text) {
  const calls = [];
  if (typeof text !== "string" || !text.includes(OPEN_TAG)) return calls;
  for (const block of text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)) {
    for (const fn of block[1].matchAll(/<function\s*=\s*"?([^<>\s"]+)"?\s*>([\s\S]*?)<\/function>/g)) {
      const parameters = {};
      for (const parameter of fn[2].matchAll(/<parameter\s*=\s*"?([^<>\s"]+)"?\s*>([\s\S]*?)<\/parameter>/g)) {
        parameters[parameter[1]] = parameter[2];
      }
      if (!fn[1]) continue;
      calls.push({ name: fn[1], parameters, arguments: JSON.stringify(parameters) });
    }
  }
  return calls;
}

function coercedValue(raw, property) {
  const declared = Array.isArray(property?.type) ? property.type : [property?.type];
  if (declared.includes("string")) return raw;
  if (declared.includes("integer") || declared.includes("number")) {
    const number = Number(raw.trim());
    return raw.trim() !== "" && Number.isFinite(number) ? number : raw;
  }
  if (declared.includes("boolean")) {
    if (raw.trim() === "true") return true;
    if (raw.trim() === "false") return false;
    return raw;
  }
  if (declared.includes("array") || declared.includes("object")) {
    try {
      const parsed = JSON.parse(raw);
      if (declared.includes("array") && Array.isArray(parsed)) return parsed;
      if (declared.includes("object") && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* Keep the raw text below. */ }
  }
  return raw;
}

// Text parameters are strings; the tool schema tells us which ones are numbers, booleans
// or nested JSON so a recovered call keeps the shape the client expects.
export function serializeTextToolCall(call, schema) {
  const properties = schema?.properties ?? {};
  const parameters = {};
  for (const [key, raw] of Object.entries(call.parameters ?? {})) parameters[key] = coercedValue(raw, properties[key]);
  return JSON.stringify(parameters);
}

// Removes leading text tool calls from a history message, including the fragments an
// upstream truncation leaves behind (an unterminated block, or a stray closing tag).
export function stripTextToolCallFragments(text) {
  if (typeof text !== "string") return text;
  let rest = text.replace(/^\s+/, "");
  let stripped = false;
  for (;;) {
    if (rest.startsWith(OPEN_TAG)) {
      const close = rest.indexOf(CLOSE_TAG);
      if (close < 0) return "";
      rest = rest.slice(close + CLOSE_TAG.length).replace(/^\s+/, "");
      stripped = true;
      continue;
    }
    if (rest.startsWith(CLOSE_TAG) || rest.startsWith("</parameter>") || rest.startsWith("</function>")) return "";
    // Tail of a tool call that the upstream truncated at a control character.
    const endOfCall = rest.indexOf(CLOSE_TAG);
    const firstClose = rest.search(/<\/(?:parameter|function)>/);
    if (endOfCall >= 0 && firstClose >= 0 && firstClose < endOfCall) {
      const value = rest.slice(0, firstClose);
      if (value === "" || /[\u0000-\u001f]/.test(value)) {
        rest = rest.slice(endOfCall + CLOSE_TAG.length).replace(/^\s+/, "");
        stripped = true;
        continue;
      }
    }
    break;
  }
  return stripped ? rest : text;
}

// Buffers tool-call arguments until the call is complete so they can be validated and
// repaired before the client sees them. Text tool calls are consumed as well, both to
// keep them out of the transcript and to recover arguments the upstream truncated.
export class ToolCallFilter {
  constructor({ tools = [], maxArgumentBytes = MAX_ARGUMENT_BYTES, maxHeldTextBytes = MAX_HELD_TEXT_BYTES } = {}) {
    this.schemas = tools instanceof Map ? new Map(tools) : new Map([...tools].map(name => [name, undefined]));
    this.maxArgumentBytes = maxArgumentBytes;
    this.maxHeldTextBytes = maxHeldTextBytes;
    this.choices = new Map();
  }

  declares(name) {
    return this.schemas.has(name);
  }

  recoveredArguments(candidate) {
    return serializeTextToolCall(candidate, this.schemas.get(candidate.name));
  }

  state(index) {
    let state = this.choices.get(index);
    if (!state) {
      state = {
        index, meta: {}, text: "", atStart: true, holdDisabled: false,
        candidates: [], calls: new Map(), order: [], nextToolIndex: 0,
        candidateCursor: 0, synthesized: false, finished: false
      };
      this.choices.set(index, state);
    }
    return state;
  }

  call(state, index, shape) {
    let call = state.calls.get(index);
    if (!call) {
      call = { index, shape, id: "", name: "", parts: [], bytes: 0, flushed: false, passthrough: false };
      state.calls.set(index, call);
      state.order.push(index);
      state.nextToolIndex = Math.max(state.nextToolIndex, index + 1);
    }
    return call;
  }

  bufferArguments(call, value) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof text !== "string") return;
    call.parts.push(text);
    call.bytes += Buffer.byteLength(text, "utf8");
    if (call.bytes > this.maxArgumentBytes) call.passthrough = true;
  }

  takeCandidate(state, name) {
    // Pair candidates with native calls in order so parallel calls with the same tool
    // name keep their own parameters.
    while (state.candidateCursor < state.candidates.length) {
      const candidate = state.candidates[state.candidateCursor++];
      if (candidate.name !== name) continue;
      candidate.paired = true;
      return candidate;
    }
    return undefined;
  }

  scanText(state, text) {
    if (state.holdDisabled) return text;
    state.text += text;
    let output = "";
    while (state.text) {
      const open = state.text.indexOf(OPEN_TAG);
      if (open < 0) {
        const held = trailingTagPrefix(state.text);
        output += state.text.slice(0, state.text.length - held.length);
        state.text = held;
        break;
      }
      output += state.text.slice(0, open);
      state.text = state.text.slice(open);
      const close = state.text.indexOf(CLOSE_TAG);
      if (close < 0) {
        if (state.text.length > this.maxHeldTextBytes) {
          output += state.text;
          state.text = "";
          state.holdDisabled = true;
        }
        break;
      }
      const block = state.text.slice(0, close + CLOSE_TAG.length);
      const parsed = parseTextToolCalls(block);
      state.text = state.text.slice(block.length);
      // Only declared tools can be reconstructed; anything else stays visible text.
      const declared = parsed.length > 0 && parsed.every(call => this.declares(call.name));
      const leading = declared && state.atStart && output.trim() === "";
      if (declared) for (const call of parsed) state.candidates.push({ ...call, leading, consumed: false });
      if (!leading) {
        output += block;
        state.atStart = false;
      }
    }
    if (output.trim() !== "") state.atStart = false;
    return output;
  }

  filterDelta(state, delta) {
    const output = { ...delta };
    if (typeof output.content === "string" && output.content) output.content = this.scanText(state, output.content);
    if (Array.isArray(output.tool_calls) && output.tool_calls.length) {
      output.tool_calls = output.tool_calls.map((item, position) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const index = Number.isInteger(item.index) ? item.index : position;
        const call = this.call(state, index, "tool_calls");
        const forwarded = { ...item };
        if (item.id != null) call.id = mergeFragment(call.id, String(item.id));
        if (item.function && typeof item.function === "object") {
          if (item.function.name != null) call.name = mergeFragment(call.name, String(item.function.name));
          if (item.function.arguments != null) {
            this.bufferArguments(call, item.function.arguments);
            forwarded.function = { ...item.function, arguments: "" };
          }
        }
        return forwarded;
      });
    } else if (output.function_call && typeof output.function_call === "object" && !Array.isArray(output.function_call)) {
      const call = this.call(state, 0, "function_call");
      if (output.function_call.name != null) call.name = mergeFragment(call.name, String(output.function_call.name));
      if (output.function_call.arguments != null) {
        this.bufferArguments(call, output.function_call.arguments);
        output.function_call = { ...output.function_call, arguments: "" };
      }
    }
    return output;
  }

  callChunk(state, call, args, { id, name } = {}) {
    if (call.shape === "function_call") return chunkFor(state.meta, state.index, { function_call: { arguments: args } });
    const tool = { index: call.index, function: { arguments: args, ...(name ? { name } : {}) } };
    if (id) {
      tool.id = id;
      tool.type = "function";
    }
    return chunkFor(state.meta, state.index, { tool_calls: [tool] });
  }

  flushCalls(state, diagnostics) {
    const chunks = [];
    for (const index of state.order) {
      const call = state.calls.get(index);
      if (!call || call.flushed) continue;
      call.flushed = true;
      const raw = call.parts.join("");
      if (call.passthrough) {
        diagnostics.push({ action: "passthrough", tool: call.name, bytes: call.bytes, reason: "arguments_too_large" });
        chunks.push(this.callChunk(state, call, raw));
        continue;
      }
      const candidate = this.takeCandidate(state, call.name);
      const repaired = repairToolArguments(raw);
      if (repaired) {
        if (repaired.repaired) diagnostics.push({ action: "repaired", tool: call.name, bytes: call.bytes, reason: repaired.reason });
        chunks.push(this.callChunk(state, call, repaired.arguments));
        continue;
      }
      if (candidate) {
        candidate.consumed = true;
        diagnostics.push({ action: "recovered", tool: call.name, bytes: call.bytes, reason: "truncated_arguments" });
        chunks.push(this.callChunk(state, call, this.recoveredArguments(candidate)));
        continue;
      }
      if (!looksLikeJson(raw)) {
        // Free-form tool input (custom tools) is not JSON by contract.
        diagnostics.push({ action: "passthrough", tool: call.name, bytes: call.bytes, reason: "free_form_text" });
        chunks.push(this.callChunk(state, call, raw));
        continue;
      }
      diagnostics.push({ action: "invalid", tool: call.name, bytes: call.bytes, reason: "unrecoverable_arguments" });
      throw invalidToolArguments(call.name, raw);
    }
    for (const candidate of state.candidates) {
      if (candidate.paired || candidate.consumed || !candidate.leading || !this.declares(candidate.name)) continue;
      candidate.consumed = true;
      const index = state.nextToolIndex++;
      const args = this.recoveredArguments(candidate);
      const call = { index, shape: "tool_calls", id: "call_" + randomUUID().replaceAll("-", ""), name: candidate.name,
        parts: [args], bytes: 0, flushed: true, passthrough: false };
      state.calls.set(index, call);
      state.order.push(index);
      state.synthesized = true;
      diagnostics.push({ action: "synthesized", tool: candidate.name, bytes: args.length, reason: "text_tool_call" });
      chunks.push(this.callChunk(state, call, args, { id: call.id, name: candidate.name }));
    }
    return chunks;
  }

  finishReason(state, finishReason) {
    state.finished = true;
    return state.synthesized && (finishReason === null || finishReason === "stop") ? "tool_calls" : finishReason;
  }

  push(incoming) {
    if (!incoming || !Array.isArray(incoming.choices) || !incoming.choices.length) {
      return { chunks: incoming ? [incoming] : [], diagnostics: [] };
    }
    const diagnostics = [];
    const pending = [];
    let finishing = false;
    for (const [position, choice] of incoming.choices.entries()) {
      const index = Number.isInteger(choice.index) ? choice.index : position;
      const state = this.state(index);
      state.meta = { ...state.meta, ...metadata(incoming) };
      const raw = choice.delta ?? choice.message ?? {};
      const delta = raw && typeof raw === "object" && !Array.isArray(raw) ? this.filterDelta(state, raw) : raw;
      const finish = choice.finish_reason ?? null;
      if (finish !== null) finishing = true;
      pending.push({ index, choice, delta, finish });
    }
    const chunks = [];
    // Keep the upstream shape (including multiple choices) unless a finish reason forces
    // the arguments to be injected first.
    const carriesDelta = pending.some(item => item.delta && typeof item.delta === "object" && Object.keys(item.delta).length);
    if (!finishing) {
      chunks.push({ ...incoming, choices: pending.map(item => ({ ...item.choice, delta: item.delta })) });
      return { chunks, diagnostics };
    }
    if (carriesDelta) {
      chunks.push({ ...incoming, choices: pending.map(item => ({ ...item.choice, delta: item.delta, finish_reason: null })) });
    }
    for (const item of pending) {
      if (item.finish === null) continue;
      const state = this.state(item.index);
      // The client must not see the finish reason before the repaired arguments.
      if (state.text) {
        chunks.push(chunkFor(state.meta, item.index, { content: state.text }));
        state.text = "";
      }
      chunks.push(...this.flushCalls(state, diagnostics));
      chunks.push({ ...incoming, choices: [{ ...item.choice, delta: {}, finish_reason: this.finishReason(state, item.finish) }] });
    }
    return { chunks, diagnostics };
  }

  flush() {
    const diagnostics = [];
    const chunks = [];
    for (const [index, state] of this.choices) {
      if (state.text) {
        chunks.push(chunkFor(state.meta, index, { content: state.text }));
        state.text = "";
      }
      chunks.push(...this.flushCalls(state, diagnostics));
      if (state.synthesized && !state.finished) chunks.push(chunkFor(state.meta, index, {}, this.finishReason(state, "stop")));
    }
    return { chunks, diagnostics };
  }
}
