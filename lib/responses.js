import { createHash } from "node:crypto";
import { ProxyError } from "./errors.js";
import { stripTextToolCallFragments } from "./tool-arguments.js";

// Codex advertises hosted web search by default, but the MiMo bridge cannot execute it.
const HOSTED_WEB_SEARCH_TYPES = new Set([
  "web_search", "web_search_2025_08_26", "web_search_preview", "web_search_preview_2025_03_11"
]);
const DEFERRED_TOOL_SEARCH_TYPE = "tool_search";

function invalid(param, message, code = "invalid_parameter") {
  throw new ProxyError(400, "invalid_request_error", message, param, code);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function string(value, param, empty = false) {
  if (typeof value !== "string" || (!empty && !value.trim())) invalid(param, param + " must be a string" + (empty ? "" : " with a value"));
  return value;
}

function array(value, param) {
  if (!Array.isArray(value)) invalid(param, param + " must be an array");
  return value;
}

function chatName(name, namespace = "") {
  if (!namespace && /^[a-zA-Z0-9_-]{1,64}$/.test(name)) return name;
  const identity = JSON.stringify([namespace, name]);
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 10);
  return (namespace ? namespace + "__" + name : name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 53) + "_" + suffix;
}

function convertTools(body, items) {
  const roots = [...(body.tools == null ? [] : array(body.tools, "tools"))];
  for (const item of items) {
    if (item?.type === "additional_tools") roots.push(...array(item.tools, "input.additional_tools.tools"));
  }
  const declarations = new Map();
  function visit(tools, namespace = "") {
    const supported = [];
    for (const tool of tools) {
      if (!object(tool)) invalid("tools", "Every tool must be an object");
      if (tool.type === "namespace") {
        const name = string(tool.name, "tools.name");
        const nested = visit(array(tool.tools, "tools.tools"), namespace ? namespace + "." + name : name);
        if (nested.length) supported.push({ ...tool, tools: nested });
        continue;
      }
      const type = tool.type || "function";
      if (HOSTED_WEB_SEARCH_TYPES.has(type)) continue;
      // Codex advertises deferred tool discovery alongside the tools themselves.
      // This proxy forwards those tools directly, so the search indirection is
      // unnecessary and cannot be represented in Chat Completions.
      if (type === DEFERRED_TOOL_SEARCH_TYPE) continue;
      if (!["function", "custom"].includes(type)) invalid("tools", "Unsupported tool type: " + type + ". Use function or custom tools executed by the client.", "unsupported_tool");
      supported.push(tool);
      const definition = object(tool.function) ? tool.function : tool;
      const name = string(definition.name, "tools.name");
      const upstreamName = chatName(name, namespace);
      const existing = declarations.get(upstreamName);
      if (existing) {
        if (existing.name !== name || existing.namespace !== namespace) invalid("tools", "Tool names collide after conversion");
        continue; // Top-level declarations take precedence over additional_tools.
      }
      const parameters = type === "custom"
        ? { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false }
        : definition.parameters ?? definition.input_schema ?? { type: "object", properties: {} };
      if (!object(parameters)) invalid("tools.parameters", "Function parameters must be a JSON schema object");
      const fn = { name: upstreamName, parameters };
      if (definition.description != null) fn.description = string(definition.description, "tools.description", true);
      if (type === "custom") {
        fn.description = (fn.description || "") + "\nPass the tool's complete free-form text as the input string.";
        if (tool.format?.type === "grammar" && typeof tool.format.definition === "string") {
          fn.description += "\nThe input should follow this grammar:\n" + tool.format.definition;
        }
      }
      if (definition.strict != null) {
        if (typeof definition.strict !== "boolean") invalid("tools.strict", "strict must be a boolean");
        fn.strict = definition.strict;
      }
      declarations.set(upstreamName, { name, namespace, type, chatName: upstreamName, tool: { type: "function", function: fn } });
    }
    return supported;
  }
  return { roots: visit(roots), declarations };
}

function resolveTool(value, declarations, param) {
  const name = string(value.name ?? value.function?.name, param + ".name");
  const namespace = value.namespace || "";
  const direct = declarations.get(chatName(name, namespace));
  if (direct) return direct;
  const candidates = [...declarations.values()].filter(tool => tool.name === name && (!namespace || tool.namespace === namespace));
  if (candidates.length === 1) return candidates[0];
  invalid(param, "Unknown or ambiguous tool: " + name);
}

function convertContent(content, param) {
  if (typeof content === "string") return content;
  const parts = array(content, param).map((part, index) => {
    const location = param + "[" + index + "]";
    if (typeof part === "string") return { type: "text", text: part };
    if (!object(part)) invalid(location, "Content parts must be objects or strings");
    if (["input_text", "output_text", "text"].includes(part.type) || (!part.type && typeof part.text === "string")) {
      return { type: "text", text: string(part.text, location + ".text", true) };
    }
    if (part.type === "refusal") return { type: "text", text: string(part.refusal, location + ".refusal", true) };
    if (part.type === "input_image" || part.type === "image_url") {
      const source = part.image_url;
      const url = typeof source === "string" ? source : source?.url;
      if (!url && part.file_id) invalid(location, "Image file_id is not supported; provide image_url or a data URL", "unsupported_parameter");
      const image = { url: string(url, location + ".image_url") };
      const detail = part.detail ?? source?.detail;
      if (detail != null) image.detail = detail === "original" ? "high" : detail;
      return { type: "image_url", image_url: image };
    }
    invalid(location, "Unsupported content type: " + part.type, "unsupported_parameter");
  });
  return parts.every(part => part.type === "text") ? parts.map(part => part.text).join("") : parts;
}

function reasoningText(item) {
  const content = (Array.isArray(item.content) ? item.content : []).filter(part => typeof part?.text === "string").map(part => part.text).join("");
  return content || (Array.isArray(item.summary) ? item.summary : []).filter(part => typeof part?.text === "string").map(part => part.text).join("");
}

function toolOutput(value, param) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return convertContent(value, param);
  if (value === undefined) invalid(param, "Tool results must contain output");
  return JSON.stringify(value);
}

// Place a parallel call group's results next to its assistant message, preserving
// result order. Attach images only after every tool has replied: Chat tool messages
// accept text, while Responses tool outputs can contain images (including video frames).
function orderToolResults(messages) {
  const ordered = [];
  const consumed = new Set();
  for (let i = 0; i < messages.length; i++) {
    if (consumed.has(i)) continue;
    const message = messages[i];
    if (message.role === "tool") invalid("input", "Tool output has no matching function call. Send the full conversation history.", "missing_tool_call");
    ordered.push(message);
    if (!message.tool_calls?.length) continue;
    const awaiting = new Set(message.tool_calls.map(tool => tool.id));
    if (awaiting.size !== message.tool_calls.length) invalid("input", "Duplicate tool call IDs in an assistant turn");
    const attachments = [];
    for (let j = i + 1; j < messages.length && awaiting.size; j++) {
      const result = messages[j];
      if (!consumed.has(j) && result.role === "tool" && awaiting.delete(result.tool_call_id)) {
        if (Array.isArray(result.content)) {
          const text = result.content.filter(part => part.type === "text").map(part => part.text).join("");
          const call = message.tool_calls.find(tool => tool.id === result.tool_call_id);
          ordered.push({ ...result, content: text || "Image content is attached in the following user message." });
          attachments.push({ type: "text", text: "Tool " + JSON.stringify(call.function.name) + " call " + result.tool_call_id + " completed:" });
          // Keep captions and timestamps beside their images, in their original order.
          for (const part of result.content) attachments.push(part);
        } else {
          ordered.push(result);
        }
        consumed.add(j);
      }
    }
    if (awaiting.size) invalid("input", "Missing tool result for call_id: " + [...awaiting].join(", "), "missing_tool_output");
    if (attachments.length) ordered.push({ role: "user", content: [{ type: "text", text: "Attached file(s) from tool result:" }, ...attachments] });
  }
  return ordered;
}

function convertInput(items, declarations) {
  const messages = [];
  let pendingReasoning = "";
  const attachReasoning = message => {
    if (pendingReasoning) {
      message.reasoning_content = pendingReasoning + (message.reasoning_content || "");
      pendingReasoning = "";
    }
  };
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const param = "input[" + i + "]";
    if (!object(item)) invalid(param, "Input items must be objects");
    const type = item.type || (item.role ? "message" : "");
    if (type === "additional_tools") continue;
    if (type === "reasoning") {
      pendingReasoning += reasoningText(item); // Opaque encrypted_content cannot be replayed to MiMo.
      continue;
    }
    if (type === "message") {
      const role = item.role === "developer" ? "system" : item.role;
      if (!["system", "user", "assistant"].includes(role)) invalid(param + ".role", "Unsupported message role: " + item.role);
      let content = convertContent(item.content ?? (role === "assistant" ? "" : undefined), param + ".content");
      // A truncated upstream turn leaves its text tool call in the transcript; replaying
      // it teaches the model to keep using that dialect instead of native tool calls.
      if (role === "assistant" && typeof content === "string") content = stripTextToolCallFragments(content);
      const message = { role, content };
      if (role === "assistant") {
        if (typeof item.reasoning_content === "string") message.reasoning_content = item.reasoning_content;
        attachReasoning(message);
      } else if (pendingReasoning) {
        // A reasoning-only previous turn has no visible content.
        messages.push({ role: "assistant", content: "", reasoning_content: pendingReasoning });
        pendingReasoning = "";
      }
      messages.push(message);
    } else if (type === "function_call" || type === "custom_tool_call") {
      const name = string(item.name, param + ".name");
      const namespace = item.namespace || "";
      const descriptor = declarations.get(chatName(name, namespace));
      const call = {
        id: string(item.call_id ?? item.id, param + ".call_id"),
        type: "function",
        function: {
          name: descriptor?.chatName || chatName(name, namespace),
          arguments: type === "custom_tool_call"
            ? JSON.stringify({ input: string(item.input, param + ".input", true) })
            : typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})
        }
      };
      let message = messages.at(-1);
      if (message?.role !== "assistant") {
        message = { role: "assistant", content: null };
        messages.push(message);
      }
      attachReasoning(message);
      (message.tool_calls ||= []).push(call);
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      messages.push({ role: "tool", tool_call_id: string(item.call_id, param + ".call_id"), content: toolOutput(item.output, param + ".output") });
    } else {
      invalid(param, "Unsupported input item type: " + type, "unsupported_parameter");
    }
  }
  if (pendingReasoning) messages.push({ role: "assistant", content: "", reasoning_content: pendingReasoning });
  return orderToolResults(messages);
}

export function buildResponsesRequest(body) {
  if (!object(body)) invalid(undefined, "Request body must be an object");
  for (const field of ["stream", "store", "background", "parallel_tool_calls"]) {
    if (body[field] != null && typeof body[field] !== "boolean") invalid(field, field + " must be a boolean");
  }
  for (const field of ["previous_response_id", "conversation", "prompt"]) {
    if (body[field] != null && body[field] !== "") invalid(field, field + " is not supported by this stateless proxy; send the full input history", "unsupported_parameter");
  }
  if (body.background === true) invalid("background", "Background execution is not supported", "unsupported_parameter");
  if (body.context_management?.length) invalid("context_management", "Automatic context compaction is not supported", "unsupported_parameter");
  if (body.n != null && body.n !== 1) invalid("n", "Responses supports one generation per request");
  if (body.metadata != null && !object(body.metadata)) invalid("metadata", "metadata must be an object");
  const items = typeof body.input === "string" ? [{ role: "user", content: body.input }]
    : body.input == null ? [] : array(body.input, "input");
  const tools = convertTools(body, items);
  const messages = convertInput(items, tools.declarations);
  if (body.instructions != null) messages.unshift({ role: "system", content: string(body.instructions, "instructions", true) });
  if (!messages.length) invalid("input", "input or instructions must contain a message");
  const request = { messages, stream: true, stream_options: { include_usage: true } };
  if (body.model != null) request.model = string(body.model, "model");
  for (const field of ["temperature", "top_p", "presence_penalty", "frequency_penalty", "seed", "stop", "user"]) {
    if (body[field] != null) request[field] = body[field];
  }
  const maxTokens = body.max_output_tokens ?? body.max_tokens;
  if (maxTokens != null) {
    if (!Number.isInteger(maxTokens) || maxTokens < 1) invalid("max_output_tokens", "max_output_tokens must be a positive integer");
    request.max_tokens = maxTokens;
  }
  const effort = body.reasoning?.effort ?? body.reasoning_effort;
  if (effort != null) {
    const normalized = string(effort, "reasoning.effort").trim().toLowerCase();
    request.reasoning_effort = ({ none: "low", minimal: "low", xhigh: "high", max: "high" })[normalized] || normalized;
  }
  const format = body.text?.format;
  if (format != null) {
    if (!object(format)) invalid("text.format", "text.format must be an object");
    if (format.type === "json_object") request.response_format = { type: "json_object" };
    else if (format.type === "json_schema") {
      if (!object(format.schema)) invalid("text.format.schema", "JSON schema must be an object");
      request.response_format = { type: "json_schema", json_schema: { name: format.name || "response", schema: format.schema } };
      for (const key of ["description", "strict"]) if (format[key] != null) request.response_format.json_schema[key] = format[key];
    } else if (format.type !== "text") invalid("text.format.type", "Unsupported text format: " + format.type);
  }
  let activeTools = [...tools.declarations.values()];
  let choice = body.tool_choice;
  if (object(choice) && choice.type === "allowed_tools") {
    const allowed = new Set(array(choice.tools, "tool_choice.tools")
      .filter(tool => !HOSTED_WEB_SEARCH_TYPES.has(tool?.type) && tool?.type !== DEFERRED_TOOL_SEARCH_TYPE)
      .map(tool => resolveTool(tool, tools.declarations, "tool_choice.tools").chatName));
    activeTools = activeTools.filter(tool => allowed.has(tool.chatName));
    choice = choice.mode || "auto";
  }
  if (object(choice)) {
    if (HOSTED_WEB_SEARCH_TYPES.has(choice.type)) invalid("tool_choice", "Hosted web search is not supported by this proxy. Use a client-executed function or custom tool for search.", "unsupported_tool");
    if (choice.type === DEFERRED_TOOL_SEARCH_TYPE) invalid("tool_choice", "Deferred tool search is not supported by this proxy. Use a client-executed function or custom tool.", "unsupported_tool");
    if (["auto", "none", "required"].includes(choice.type)) choice = choice.type;
    else if (choice.type === "tool" && !choice.name) choice = "required";
    else if (["function", "custom", "tool"].includes(choice.type)) {
      choice = { type: "function", function: { name: resolveTool(choice, tools.declarations, "tool_choice").chatName } };
    } else invalid("tool_choice", "Unsupported tool_choice");
  }
  if (choice != null && typeof choice !== "object" && !["auto", "none", "required"].includes(choice)) invalid("tool_choice", "Unsupported tool_choice");
  if (!activeTools.length && (choice === "required" || object(choice))) invalid("tool_choice", "tool_choice requires available tools");
  if (activeTools.length) {
    request.tools = activeTools.map(tool => tool.tool);
    if (choice != null) request.tool_choice = choice;
    if (body.parallel_tool_calls != null) request.parallel_tool_calls = body.parallel_tool_calls;
  }
  return { request, tools: tools.declarations, responseTools: tools.roots };
}
