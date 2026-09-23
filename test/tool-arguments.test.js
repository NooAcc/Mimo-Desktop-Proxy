import test from "node:test";
import assert from "node:assert/strict";
import {
  ToolCallFilter, escapeRawControls, parseTextToolCalls, repairToolArguments,
  serializeTextToolCall, stripTextToolCallFragments
} from "../lib/tool-arguments.js";

const meta = { id: "upstream", model: "served-model", created: 1 };
const choice = (delta, finish_reason = null) => ({ ...meta, choices: [{ index: 0, delta, finish_reason }] });
const CTRL_C = "\u0003";
const textCall = name => "<tool_call><function=" + name + "><parameter=session_id>70855</parameter>" +
  "<parameter=chars>" + CTRL_C + "</parameter><parameter=yield_time_ms>1000</parameter>" +
  "<parameter=max_output_tokens>1000</parameter></function></tool_call>";
const deltas = chunks => chunks.flatMap(chunk => chunk.choices.map(choice => choice.delta));
const finishReasons = chunks => chunks.flatMap(chunk => chunk.choices.map(choice => choice.finish_reason)).filter(reason => reason !== null);

test("escapeRawControls escapes control characters inside strings only", () => {
  assert.equal(escapeRawControls('{"text":"' + CTRL_C + '"}'), '{"text":"\\u0003"}');
  assert.equal(escapeRawControls('{"text":"a\u0000b\u001fc"}'), '{"text":"a\\u0000b\\u001fc"}');
  assert.equal(escapeRawControls('["\u0009",\t"ok"]'), '["\\u0009",\t"ok"]');
  assert.equal(escapeRawControls('{"text":"\\u0003"}'), '{"text":"\\u0003"}');
  assert.equal(escapeRawControls('{"text":"plain"}'), '{"text":"plain"}');
});

test("repairToolArguments escapes raw controls and rejects truncated JSON", () => {
  assert.deepEqual(repairToolArguments('{"text":"OK"}'), {arguments: '{"text":"OK"}', repaired: false, reason: undefined});
  assert.deepEqual(repairToolArguments(''), {arguments: "{}", repaired: false, reason: "empty"});
  const repaired = repairToolArguments('{"chars":"' + CTRL_C + '","size":512}');
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.reason, "raw_control_character");
  assert.deepEqual(JSON.parse(repaired.arguments), {chars: CTRL_C, size: 512});
  assert.equal(repairToolArguments('{"session_id": 70855, "chars": '), null);
  assert.equal(repairToolArguments('{"cmd": "rg -a -i -o \'StrictMosaic[^'), null);
});

test("parseTextToolCalls reads MiMo text tool calls including raw control characters", () => {
  const [call] = parseTextToolCalls(textCall("write_stdin"));
  assert.equal(call.name, "write_stdin");
  assert.deepEqual(call.parameters, {session_id: "70855", chars: CTRL_C, yield_time_ms: "1000", max_output_tokens: "1000"});
  assert.deepEqual(JSON.parse(call.arguments), call.parameters);
  assert.deepEqual(parseTextToolCalls("<tool_call><function=echo><parameter=text>hi</parameter></function></tool_call>")
    .map(item => item.name), ["echo"]);
  assert.deepEqual(parseTextToolCalls("<tool_call><function=echo></function></tool_call>").map(item => item.arguments), ["{}"]);
  assert.deepEqual(parseTextToolCalls("no tool call here"), []);
  assert.deepEqual(parseTextToolCalls("<tool_call>unterminated"), []);
});

test("serializeTextToolCall restores declared parameter types", () => {
  const schema = {type: "object", properties: {session_id: {type: "integer"}, chars: {type: "string"},
    yield_time_ms: {type: "integer"}, options: {type: "object"}, tags: {type: "array"}}};
  const call = {name: "write_stdin", parameters: {session_id: "70855", chars: CTRL_C, yield_time_ms: "1000",
    options: '{"force":true}', tags: '["a"]'}};
  assert.deepEqual(JSON.parse(serializeTextToolCall(call, schema)),
    {session_id: 70855, chars: CTRL_C, yield_time_ms: 1000, options: {force: true}, tags: ["a"]});
  assert.deepEqual(JSON.parse(serializeTextToolCall({name: "echo", parameters: {text: "1000"}}, undefined)), {text: "1000"});
  assert.deepEqual(JSON.parse(serializeTextToolCall({name: "echo", parameters: {count: "12"}},
    {properties: {count: {type: "integer"}}})), {count: 12});
});

test("stripTextToolCallFragments removes truncated tool-call history", () => {
  assert.equal(stripTextToolCallFragments(textCall("write_stdin")), "");
  assert.equal(stripTextToolCallFragments("<tool_call><function=write_stdin><parameter=chars>" + CTRL_C), "");
  assert.equal(stripTextToolCallFragments("</parameter><parameter=yield_time_ms>1000</parameter></function></tool_call>"), "");
  assert.equal(stripTextToolCallFragments(textCall("write_stdin") + "then continue"), "then continue");
  assert.equal(stripTextToolCallFragments("普通文本"), "普通文本");
  assert.equal(stripTextToolCallFragments("  padded  "), "  padded  ");
});

test("ToolCallFilter holds arguments, repairs raw control characters and keeps metadata", () => {
  const filter = new ToolCallFilter({tools: new Map([["write_stdin", {type: "object"}]])});
  const first = filter.push(choice({role: "assistant", tool_calls: [{index: 0, id: "call_1", type: "function",
    function: {name: "write_stdin", arguments: '{"session_id": 70855, "chars": "'}}]}));
  assert.equal(first.diagnostics.length, 0);
  assert.deepEqual(first.chunks[0].choices[0].delta.tool_calls[0].function, {name: "write_stdin", arguments: ""});
  assert.equal(first.chunks[0].id, "upstream");
  const second = filter.push(choice({tool_calls: [{index: 0, id: null, function: {name: null,
    arguments: CTRL_C + '"}'}}]}));
  assert.equal(second.chunks[0].choices[0].delta.tool_calls[0].function.arguments, "");
  const finish = filter.push(choice({}, "tool_calls"));
  assert.deepEqual(finish.diagnostics.map(item => item.action), ["repaired"]);
  assert.deepEqual(Object.keys(finish.diagnostics[0]).sort(), ["action", "bytes", "reason", "tool"]);
  const repaired = deltas(finish.chunks).flatMap(delta => delta.tool_calls || []);
  assert.equal(repaired.length, 1);
  assert.deepEqual(JSON.parse(repaired[0].function.arguments), {session_id: 70855, chars: CTRL_C});
  assert.equal(finish.chunks.at(-1).choices[0].finish_reason, "tool_calls");
  assert.deepEqual(deltas(filter.flush().chunks), []);
});

test("ToolCallFilter recovers truncated arguments from the text tool call", () => {
  const filter = new ToolCallFilter({tools: new Map([["write_stdin", {type: "object",
    properties: {session_id: {type: "integer"}, chars: {type: "string"}, yield_time_ms: {type: "integer"}}}]])});
  const text = textCall("write_stdin").split(CTRL_C);
  const first = filter.push(choice({role: "assistant", content: text[0]}));
  assert.equal(first.chunks[0].choices[0].delta.content, "");
  const second = filter.push(choice({content: CTRL_C + text[1]}));
  assert.equal(second.chunks[0].choices[0].delta.content, "");
  filter.push(choice({tool_calls: [{index: 0, id: "call_truncated", function: {name: "write_stdin",
    arguments: '{"session_id": 70855, "chars": '}}]}));
  const finish = filter.push(choice({}, "tool_calls"));
  assert.deepEqual(finish.diagnostics.map(item => item.action), ["recovered"]);
  const recovered = deltas(finish.chunks).flatMap(delta => delta.tool_calls || [])[0];
  assert.deepEqual(JSON.parse(recovered.function.arguments),
    {session_id: 70855, chars: CTRL_C, yield_time_ms: 1000, max_output_tokens: "1000"});
  assert.equal(finish.chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("ToolCallFilter synthesizes declared text tool calls and keeps undeclared text", () => {
  const filter = new ToolCallFilter({tools: new Map([["write_stdin", {properties: {chars: {type: "string"}}}]])});
  const echoed = filter.push(choice({role: "assistant", content: textCall("write_stdin")}));
  assert.equal(echoed.chunks[0].choices[0].delta.content, "");
  const finish = filter.push(choice({}, "stop"));
  assert.deepEqual(finish.diagnostics.map(item => item.action), ["synthesized"]);
  const call = deltas(finish.chunks).flatMap(delta => delta.tool_calls || [])[0];
  assert.equal(call.id.startsWith("call_"), true);
  assert.equal(call.function.name, "write_stdin");
  assert.deepEqual(JSON.parse(call.function.arguments), {session_id: "70855", chars: CTRL_C, yield_time_ms: "1000", max_output_tokens: "1000"});
  assert.equal(finish.chunks.at(-1).choices[0].finish_reason, "tool_calls");

  const undeclared = new ToolCallFilter({tools: new Map([["echo", undefined]])});
  const kept = undeclared.push(choice({role: "assistant", content: textCall("write_stdin")}));
  assert.equal(kept.chunks[0].choices[0].delta.content, textCall("write_stdin"));
  assert.equal(undeclared.push(choice({}, "stop")).chunks.some(chunk => chunk.choices[0].delta.tool_calls), false);
});

test("ToolCallFilter reports unrepairable JSON and passes free-form input through", () => {
  const filter = new ToolCallFilter({tools: new Map([["apply_patch", undefined]])});
  filter.push(choice({tool_calls: [{index: 0, id: "call_bad", function: {name: "apply_patch",
    arguments: '{"input": "*** Begin Patch'}}]}));
  assert.throws(() => filter.push(choice({}, "tool_calls")), error => {
    assert.equal(error.code, "invalid_tool_arguments");
    assert.equal(error.status, 502);
    return true;
  });

  const freeForm = new ToolCallFilter({tools: new Map([["apply_patch", undefined]])});
  freeForm.push(choice({tool_calls: [{index: 0, id: "call_text", function: {name: "apply_patch",
    arguments: "*** Begin Patch\n*** End Patch"}}]}));
  const finish = freeForm.push(choice({}, "tool_calls"));
  assert.deepEqual(finish.diagnostics.map(item => item.action), ["passthrough"]);
  assert.equal(deltas(finish.chunks).flatMap(delta => delta.tool_calls)[0].function.arguments, "*** Begin Patch\n*** End Patch");
});

test("ToolCallFilter leaves ordinary content and empty arguments untouched", () => {
  const filter = new ToolCallFilter({tools: ["echo"]});
  const plain = choice({role: "assistant", content: "<tool_calls>not a call</tool_calls>"});
  assert.deepEqual(filter.push(plain).chunks, [plain]);
  filter.push(choice({tool_calls: [{index: 0, id: "call_empty", function: {name: "echo", arguments: ""}}]}));
  const finish = filter.push(choice({}, "tool_calls"));
  assert.equal(deltas(finish.chunks).flatMap(delta => delta.tool_calls)[0].function.arguments, "{}");
  assert.equal(finish.chunks.at(-1).choices[0].finish_reason, "tool_calls");
  assert.deepEqual(filter.push({choices: [], usage: {total_tokens: 3}}).chunks, [{choices: [], usage: {total_tokens: 3}}]);
});

test("ToolCallFilter flushes held text and buffered arguments when a stream ends early", () => {
  const filter = new ToolCallFilter({tools: ["echo"]});
  const held = filter.push(choice({role: "assistant", content: "<tool_ca"}));
  assert.equal(held.chunks[0].choices[0].delta.content, "");
  const flushed = filter.flush();
  assert.equal(flushed.chunks[0].choices[0].delta.content, "<tool_ca");
  assert.equal(flushed.chunks.length, 1);
});

test("ToolCallFilter pairs parallel same-name calls with their own text parameters", () => {
  const schema = {properties: {session_id: {type: "integer"}, chars: {type: "string"}}};
  const filter = new ToolCallFilter({tools: new Map([["write_stdin", schema]])});
  const block = (id, char) => "<tool_call><function=write_stdin><parameter=session_id>" + id +
    "</parameter><parameter=chars>" + char + "</parameter></function></tool_call>";
  filter.push(choice({role: "assistant", content: block("1", "a") + block("2", "b")}));
  filter.push(choice({tool_calls: [{index: 0, id: "call_a", function: {name: "write_stdin", arguments: '{"session_id":1,"chars":"a"}'}}]}));
  const finish = filter.push(choice({tool_calls: [{index: 1, id: "call_b", function: {name: "write_stdin", arguments: '{"session_id":2, "chars": '}}]}, "tool_calls"));
  assert.deepEqual(finish.diagnostics.map(item => item.action), ["recovered"]);
  assert.deepEqual(deltas(finish.chunks).flatMap(delta => delta.tool_calls || []).filter(call => call.function.arguments !== "")
    .map(call => JSON.parse(call.function.arguments)), [{session_id: 1, chars: "a"}, {session_id: 2, chars: "b"}]);
  assert.deepEqual(deltas(filter.flush().chunks), []);
});

test("ToolCallFilter synthesizes text tool calls when the stream ends without a finish chunk", () => {
  const filter = new ToolCallFilter({tools: new Map([["echo", {properties: {text: {type: "string"}}}]])});
  filter.push(choice({role: "assistant", content: "<tool_call><function=echo><parameter=text>hi</parameter></function></tool_call>"}));
  const flushed = filter.flush();
  assert.deepEqual(flushed.diagnostics.map(item => item.action), ["synthesized"]);
  const call = deltas(flushed.chunks).flatMap(delta => delta.tool_calls || [])[0];
  assert.deepEqual(JSON.parse(call.function.arguments), {text: "hi"});
  assert.equal(flushed.chunks.at(-1).choices[0].finish_reason, "tool_calls");
  assert.equal(flushed.chunks.at(-1).choices[0].delta.tool_calls, undefined);
});
