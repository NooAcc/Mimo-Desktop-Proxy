import test from "node:test";
import assert from "node:assert/strict";
import { readSSE } from "../lib/sse.js";
import { CompletionAccumulator } from "../lib/completion.js";

function stream(chunks, cancel = () => {}) {
  return new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : chunk); controller.close(); },
    cancel
  });
}

test("SSE reconstructs Chinese UTF-8 split at every byte and CRLF split across chunks", async () => {
  const bytes = Buffer.from(': ping\r\nevent: message\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"你好"}}]}\r\n\r\n');
  const events = [];
  for await (const event of readSSE(stream([...bytes].map(byte => Uint8Array.of(byte))))) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0].data).choices[0].delta.content, "你好");
});

test("SSE handles lone CR, LF, comments, event names, and event IDs", async () => {
  const events = [];
  for await (const event of readSSE(stream(['id: 7\revent: error\rdata: {"error":"test"}\r\r: ping\n\ndata: [DONE]\n\n']))) events.push(event);
  assert.deepEqual(events, [{event: "error", id: "7", data: '{"error":"test"}'}, {event: "message", id: "7", data: "[DONE]"}]);
});

test("SSE rejects incomplete events rather than silently dropping the tail", async () => {
  await assert.rejects(async () => { for await (const event of readSSE(stream(['data: {"content":"tail"}']))) void event; }, /incomplete event/);
});

test("SSE rejects invalid UTF-8 and oversized events", async () => {
  await assert.rejects(async () => { for await (const event of readSSE(stream([Buffer.from([0xff])]))) void event; }, /invalid UTF-8/);
  await assert.rejects(async () => { for await (const event of readSSE(stream(["data: " + "x".repeat(64)]), {maxEventBytes: 32})) void event; }, /too large/);
});

test("Stopping an SSE consumer cancels an open upstream body", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from("data: [DONE]\n\n")); },
    cancel() { cancelled = true; }
  });
  for await (const event of readSSE(body)) { assert.equal(event.data, "[DONE]"); break; }
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("Aggregation preserves upstream metadata, reasoning, usage, and real finish reasons", () => {
  const result = new CompletionAccumulator("requested-model");
  const first = result.add({id: "upstream-id", model: "served-model", created: 123, choices: [{index: 0, delta: {role: "assistant", reasoning_content: "思考"}, finish_reason: null}]});
  result.add({choices: [{index: 0, delta: {content: "答"}, finish_reason: null}]});
  const last = result.add({choices: [{index: 0, delta: {content: "案"}, finish_reason: "length"}], usage: {prompt_tokens: 3, completion_tokens: 2, total_tokens: 5}});
  assert.equal(first.id, last.id);
  assert.equal(result.finished, true);
  assert.deepEqual(result.result(), {
    usage: {prompt_tokens: 3, completion_tokens: 2, total_tokens: 5},
    id: "upstream-id", created: 123, model: "served-model", object: "chat.completion",
    choices: [{index: 0, message: {role: "assistant", content: "答案", reasoning_content: "思考"}, finish_reason: "length"}]
  });
});

test("Aggregation reconstructs parallel tool calls with fragmented function arguments", () => {
  const result = new CompletionAccumulator("model");
  result.add({choices: [{index: 0, delta: {role: "assistant", tool_calls: [
    {index: 0, id: "call_a", type: "function", function: {name: "weather", arguments: '{"city":"'}},
    {index: 1, id: "call_b", type: "function", function: {name: "time", arguments: "{"}}
  ]}, finish_reason: null}]});
  result.add({choices: [{index: 0, delta: {tool_calls: [
    {index: 1, function: {arguments: '"zone":"UTC"}'}},
    {index: 0, function: {arguments: '北京"}'}}
  ]}, finish_reason: "tool_calls"}]});
  const choice = result.result().choices[0];
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.content, null);
  assert.deepEqual(choice.message.tool_calls, [
    {id: "call_a", type: "function", function: {name: "weather", arguments: '{"city":"北京"}'}},
    {id: "call_b", type: "function", function: {name: "time", arguments: '{"zone":"UTC"}'}}
  ]);
});

test("Aggregation keeps multiple choices separate and does not invent a stop reason", () => {
  const result = new CompletionAccumulator("model");
  result.add({choices: [{index: 1, delta: {content: "B"}, finish_reason: "stop"}, {index: 0, delta: {content: "A"}, finish_reason: null}]});
  assert.equal(result.finished, false);
  assert.deepEqual(result.result().choices.map(choice => [choice.index, choice.message.content, choice.finish_reason]), [[0, "A", null], [1, "B", "stop"]]);
});
