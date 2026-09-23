import { randomUUID } from "node:crypto";

function mergeFunction(target, delta) {
  for (const [key, value] of Object.entries(delta || {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && (key === "name" || key === "arguments")) {
      target[key] = (target[key] || "") + value;
    } else {
      target[key] = value;
    }
  }
}

export class CompletionAccumulator {
  constructor(model, { aggregate = true } = {}) {
    this.metadata = { id: "chatcmpl-" + randomUUID(), created: Math.floor(Date.now() / 1000), model };
    this.started = false;
    this.choices = new Map();
    this.extra = {};
    this.aggregate = aggregate;
  }

  add(chunk) {
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk) || !Array.isArray(chunk.choices)) {
      throw new Error("Upstream SSE data is not a chat completion chunk");
    }
    if (!this.started) {
      for (const key of ["id", "created", "model"]) {
        if (chunk[key] !== undefined && chunk[key] !== null) this.metadata[key] = chunk[key];
      }
      this.started = true;
    }

    for (const [key, value] of Object.entries(chunk)) {
      if (!["id", "object", "created", "model", "choices"].includes(key)) this.extra[key] = value;
    }

    const choices = chunk.choices.map((choice, position) => {
      const index = Number.isInteger(choice.index) ? choice.index : position;
      const delta = choice.delta ?? choice.message ?? {};
      if (!delta || typeof delta !== "object" || Array.isArray(delta)) {
        throw new Error("Upstream choice delta must be an object");
      }
      let state = this.choices.get(index);
      if (!state) {
        state = { index, message: { role: "assistant", content: null }, finish_reason: null, tools: new Map() };
        this.choices.set(index, state);
      }

      for (const [key, value] of this.aggregate ? Object.entries(delta) : []) {
        if (["content", "reasoning_content", "reasoning", "refusal"].includes(key) && typeof value === "string") {
          state.message[key] = (state.message[key] || "") + value;
        } else if (key === "tool_calls") {
          // MiMo explicitly sends tool_calls: null on ordinary text chunks.
          if (value === null || value === undefined) continue;
          if (!Array.isArray(value)) throw new Error("Upstream tool_calls must be an array");
          for (const toolDelta of value) {
            const toolIndex = toolDelta.index ?? 0;
            let tool = state.tools.get(toolIndex);
            if (!tool) { tool = {}; state.tools.set(toolIndex, tool); }
            for (const [field, item] of Object.entries(toolDelta)) {
              if (field === "index" || item === null || item === undefined) continue;
              if (field === "function") {
                tool.function ||= {};
                mergeFunction(tool.function, item);
              } else if (field === "id" && tool.id && item !== tool.id) {
                tool.id += item;
              } else {
                tool[field] = item;
              }
            }
          }
        } else if (key === "function_call" && value) {
          state.message.function_call ||= {};
          mergeFunction(state.message.function_call, value);
        } else if (Array.isArray(value)) {
          state.message[key] = [...(state.message[key] || []), ...value];
        } else if (value !== null || state.message[key] === undefined) {
          state.message[key] = value;
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        state.finish_reason = choice.finish_reason;
      }
      if (this.aggregate && choice.logprobs) {
        state.logprobs ||= {};
        for (const [key, value] of Object.entries(choice.logprobs)) {
          state.logprobs[key] = Array.isArray(value) ? [...(state.logprobs[key] || []), ...value] : value;
        }
      }
      const normalized = { ...choice, index, delta };
      delete normalized.message;
      return normalized;
    });

    return { ...chunk, ...this.metadata, object: "chat.completion.chunk", choices };
  }

  get finished() {
    return this.choices.size > 0 && [...this.choices.values()].every(choice => choice.finish_reason !== null);
  }

  result() {
    return {
      ...this.extra,
      ...this.metadata,
      object: "chat.completion",
      choices: [...this.choices.values()].sort((a, b) => a.index - b.index).map(state => ({
        index: state.index,
        message: {
          ...state.message,
          ...(state.tools.size ? { tool_calls: [...state.tools.entries()].sort((a, b) => a[0] - b[0]).map(([, tool]) => tool) } : {})
        },
        finish_reason: state.finish_reason,
        ...(state.logprobs ? { logprobs: state.logprobs } : {})
      }))
    };
  }
}
