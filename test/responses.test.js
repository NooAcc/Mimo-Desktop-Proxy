import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createProxyServer, readConfig } from "../mimo_server.js";
import { buildResponsesRequest } from "../lib/responses.js";
import { readSSE } from "../lib/sse.js";
import { listenForFetch } from "../scripts/http_fixture.js";

const input = { model: "mimo-pro", input: "你好" };
const echo = { type: "function", name: "echo", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
const searchTypes = ["web_search", "web_search_2025_08_26", "web_search_preview", "web_search_preview_2025_03_11"];
const chunk = (delta, finish_reason = null, extra = {}) => "data: " + JSON.stringify({
  id: "upstream-test", model: "served-model", created: 123,
  choices: [{ index: 0, delta, finish_reason }], ...extra
}) + "\n\n";
const done = "data: [DONE]\n\n";
const sse = text => new Response(text, { headers: { "content-type": "text/event-stream" } });
const complete = chunk({ role: "assistant", content: "你好" }, "stop") + done;

async function app(t, fetchImpl = async () => sse(complete), overrides = {}) {
  const server = createProxyServer({
    config: readConfig({}), ...overrides, logger: { info() {}, warn() {}, error() {} },
    fetchImpl, authProvider: async () => new Headers({ cookie: "mock-cookie" })
  });
  await listenForFetch(server);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    base,
    post: (body = input, endpoint = "/v1/responses", headers = {}) => fetch(base + endpoint, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
    })
  };
}

async function events(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const result = [];
  for await (const event of readSSE(response.body)) {
    assert.notEqual(event.data, "[DONE]");
    const data = JSON.parse(event.data);
    assert.equal(event.event, data.type);
    assert.equal(data.sequence_number, result.length);
    result.push(data);
  }
  return result;
}

const outputText = response => response.output.filter(item => item.type === "message").flatMap(item => item.content).filter(part => part.type === "output_text").map(part => part.text).join("");

test("Responses request accepts SDK defaults and translates generation parameters without leaking hints", () => {
  const body = { ...input, store: true, include: ["reasoning.encrypted_content"], stream_options: { include_obfuscation: true },
    prompt_cache_key: "cache-key", safety_identifier: "test", metadata: { session: "a" },
    instructions: "Speak Chinese", temperature: 0.2, max_output_tokens: 128, reasoning: { effort: "xhigh", summary: "auto" },
    text: { verbosity: "low", format: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true } } };
  const copy = structuredClone(body);
  const { request } = buildResponsesRequest(body);
  assert.deepEqual(body, copy);
  assert.deepEqual(request.messages, [{ role: "system", content: "Speak Chinese" }, { role: "user", content: "你好" }]);
  assert.equal(request.reasoning_effort, "high");
  assert.equal(request.max_tokens, 128);
  assert.equal(request.temperature, 0.2);
  assert.deepEqual(request.stream_options, { include_usage: true });
  assert.deepEqual(request.response_format, { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" }, strict: true } });
  for (const key of ["input", "store", "include", "metadata", "text", "prompt_cache_key", "safety_identifier"]) assert.equal(request[key], undefined);
});

test("Responses content preserves developer priority, assistant text and image URL data", () => {
  const { request } = buildResponsesRequest({ input: [
    { role: "developer", content: [{ type: "input_text", text: "Follow this instruction" }] },
    { type: "message", role: "assistant", id: "msg_old", status: "completed", content: [{ type: "output_text", text: "Earlier answer", annotations: [] }] },
    { role: "user", content: [{ type: "input_text", text: "Look" }, { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "original" }] }
  ] });
  assert.deepEqual(request.messages, [
    { role: "system", content: "Follow this instruction" },
    { role: "assistant", content: "Earlier answer" },
    { role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "high" } }] }
  ]);
});

test("Responses history groups parallel calls and keeps their results adjacent with reasoning", () => {
  const { request } = buildResponsesRequest({ input: [
    { role: "user", content: "Call tools" },
    { type: "reasoning", summary: [{ type: "summary_text", text: "Think" }], encrypted_content: "opaque" },
    { type: "function_call", call_id: "call_a", name: "echo", arguments: '{"text":"A"}' },
    { type: "function_call", call_id: "call_b", name: "echo", arguments: { text: "B" } },
    { role: "user", content: "Then summarize" },
    { type: "function_call_output", call_id: "call_b", output: [{ type: "input_text", text: "B" }] },
    { type: "function_call_output", call_id: "call_a", output: { result: "A" } }
  ], tools: [echo] });
  assert.deepEqual(request.messages.map(message => message.role), ["user", "assistant", "tool", "tool", "user"]);
  assert.equal(request.messages[1].reasoning_content, "Think");
  assert.deepEqual(request.messages[1].tool_calls.map(call => call.id), ["call_a", "call_b"]);
  assert.equal(request.messages[1].tool_calls[1].function.arguments, '{"text":"B"}');
  assert.equal(request.messages[2].tool_call_id, "call_b");
  assert.equal(request.messages[3].content, '{"result":"A"}');
});

for (const type of ["function_call", "custom_tool_call"]) {
  test("Responses " + type + " moves image results into a following user message", () => {
    const body = { input: [
      { role: "user", content: "Look at the image" },
      { type, name: "view_image", call_id: "call_image", ...(type === "function_call" ? { arguments: "{}" } : { input: "image.png" }) },
      { type: type + "_output", call_id: "call_image", output: [
        { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "original" }
      ] }
    ] };
    const copy = structuredClone(body);
    const { messages } = buildResponsesRequest(body).request;
    assert.deepEqual(body, copy);
    assert.deepEqual(messages.map(message => message.role), ["user", "assistant", "tool", "user"]);
    assert.equal(messages[2].tool_call_id, "call_image");
    assert.equal(typeof messages[2].content, "string");
    assert.ok(messages[2].content);
    assert.match(messages[3].content[1].text, /view_image.*call_image/);
    assert.deepEqual(messages[3].content[2], { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "high" } });
  });
}

test("Responses video frame results retain timestamps, captions and image order", () => {
  const output = [
    { type: "input_text", text: "Frame at 0s: " },
    { type: "input_image", image_url: "https://example.com/frame-0.png" },
    { type: "input_text", text: "Frame at 2s: " },
    { type: "input_image", image_url: "https://example.com/frame-2.png", detail: "low" },
    { type: "input_text", text: "Frame at 4s: " },
    { type: "image_url", image_url: { url: "https://example.com/frame-4.png", detail: "high" } },
    { type: "input_text", text: "End of clip." }
  ];
  const body = { input: [
    { role: "user", content: "Describe the clip" },
    { type: "function_call", name: "read_frames", call_id: "call_video", arguments: "{}" },
    { type: "function_call_output", call_id: "call_video", output }
  ] };
  const copy = structuredClone(body);
  const { messages } = buildResponsesRequest(body).request;
  assert.deepEqual(body, copy);
  assert.equal(messages[2].content, "Frame at 0s: Frame at 2s: Frame at 4s: End of clip.");
  assert.deepEqual(messages[3].content.slice(2), [
    { type: "text", text: "Frame at 0s: " },
    { type: "image_url", image_url: { url: "https://example.com/frame-0.png" } },
    { type: "text", text: "Frame at 2s: " },
    { type: "image_url", image_url: { url: "https://example.com/frame-2.png", detail: "low" } },
    { type: "text", text: "Frame at 4s: " },
    { type: "image_url", image_url: { url: "https://example.com/frame-4.png", detail: "high" } },
    { type: "text", text: "End of clip." }
  ]);
});

test("Responses attaches media after all parallel tool results, including reordered histories", () => {
  const { messages } = buildResponsesRequest({ input: [
    { role: "user", content: "Inspect both images and the text" },
    { type: "reasoning", summary: [{ type: "summary_text", text: "Compare" }] },
    ...["a", "b", "c"].map(id => ({ type: "function_call", name: "read", call_id: "call_" + id, arguments: "{}" })),
    { role: "user", content: "Then summarize" },
    { type: "function_call_output", call_id: "call_b", output: "Text result" },
    { type: "function_call_output", call_id: "call_c", output: [{ type: "input_image", image_url: "https://example.com/c.png" }] },
    { type: "function_call_output", call_id: "call_a", output: [{ type: "input_image", image_url: "https://example.com/a.png" }] }
  ] }).request;
  assert.deepEqual(messages.map(message => message.role), ["user", "assistant", "tool", "tool", "tool", "user", "user"]);
  assert.equal(messages[1].reasoning_content, "Compare");
  assert.deepEqual(messages.slice(2, 5).map(message => message.tool_call_id), ["call_b", "call_c", "call_a"]);
  assert.equal(messages[2].content, "Text result");
  assert.ok(messages.slice(2, 5).every(message => typeof message.content === "string"));
  assert.match(messages[5].content[1].text, /call_c/);
  assert.match(messages[5].content[3].text, /call_a/);
  assert.deepEqual(messages[5].content.filter(part => part.type === "image_url").map(part => part.image_url.url), ["https://example.com/c.png", "https://example.com/a.png"]);
  assert.equal(messages[6].content, "Then summarize");
});

test("Responses replay keeps media attached to its own tool turn without duplication", () => {
  const input = [{ role: "user", content: "Inspect the first image" }];
  for (const id of ["first", "second"]) {
    input.push(
      { type: "function_call", name: "read", call_id: id, arguments: "{}" },
      { type: "function_call_output", call_id: id, output: [{ type: "input_image", image_url: "https://example.com/" + id + ".png" }] },
      { role: "assistant", content: "Inspected " + id },
      { role: "user", content: "Continue after " + id }
    );
  }
  const { messages } = buildResponsesRequest({ input }).request;
  const attached = messages.filter(message => message.role === "user" && Array.isArray(message.content));
  assert.equal(attached.length, 2);
  for (const [index, id] of ["first", "second"].entries()) {
    const position = messages.indexOf(attached[index]);
    assert.equal(messages[position - 1].role, "tool");
    assert.equal(messages[position - 1].tool_call_id, id);
    assert.equal(messages[position + 1].content, "Inspected " + id);
    assert.deepEqual(attached[index].content.filter(part => part.type === "image_url").map(part => part.image_url.url), ["https://example.com/" + id + ".png"]);
  }
});

for (const stream of [false, true]) {
  test("Responses " + (stream ? "SSE" : "JSON") + " video tool loop follows the captured MiMo media message layout", async t => {
    const fixture = JSON.parse(await fs.readFile(new URL("./fixtures/client-media-request.json", import.meta.url), "utf8"));
    const expected = fixture.messages;
    const calls = expected[0].tool_calls;
    const pictures = expected.at(-1).content.filter(part => part.type === "image_url");
    const tools = [{ type: "function", name: "read", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } }];
    let turn = 0;
    const instance = await app(t, async (url, init) => {
      const body = JSON.parse(init.body);
      if (++turn === 1) return sse(chunk({ content: expected[0].content }) + chunk({ tool_calls: calls.map((call, index) => ({ ...call, index })) }, "tool_calls") + done);
      // Chat tool messages must be text; all media follow the completed call group.
      const history = body.messages.slice(1);
      assert.deepEqual(history.map(message => message.role), expected.map(message => message.role));
      assert.deepEqual(history[0], expected[0]);
      assert.deepEqual(history.slice(1, -1).map(message => message.tool_call_id), calls.map(call => call.id));
      assert.ok(history.slice(1, -1).every(message => typeof message.content === "string" && message.content.length));
      assert.deepEqual(history.at(-1), expected.at(-1));
      return sse(chunk({ content: "Video frames received" }, "stop") + done);
    });
    const user = { role: "user", content: "Describe these video frames" };
    const first = await (await instance.post({ model: "mimo-v2.6-pro", tools, input: [user] })).json();
    const response = await instance.post({ model: "mimo-v2.6-pro", tools, stream, input: [user, ...first.output,
      ...calls.map((call, index) => ({ type: "function_call_output", call_id: call.id, output: [{ type: "input_image", image_url: pictures[index].image_url.url }] }))
    ] });
    const final = stream ? (await events(response)).at(-1).response : await response.json();
    assert.equal(final.status, "completed");
    assert.equal(outputText(final), "Video frames received");
    assert.equal(turn, 2);
  });
}

test("Responses tools merge namespace and additional_tools declarations with stable names", () => {
  const custom = { type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "grammar", syntax: "lark", definition: "start: text" } };
  const body = { input: [
    { type: "additional_tools", tools: [echo, { type: "custom", name: "echo" }] },
    { role: "user", content: "Edit a file" }
  ], tools: [echo, { type: "namespace", name: "functions", tools: [custom] }], tool_choice: { type: "custom", name: "apply_patch", namespace: "functions" } };
  const converted = buildResponsesRequest(body);
  assert.equal(converted.request.tools.length, 2);
  assert.equal(converted.tools.get("echo").type, "function");
  const tool = converted.request.tools[1].function;
  assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.deepEqual(tool.parameters.required, ["input"]);
  assert.match(tool.description, /start: text/);
  assert.equal(converted.request.tool_choice.function.name, tool.name);
  assert.equal(buildResponsesRequest(body).request.tools[1].function.name, tool.name);
});

test("Responses ignores Codex tool_search declarations while forwarding client tools", () => {
  const custom = { type: "custom", name: "apply_patch", description: "Apply a patch" };
  const body = { model: "mimo-v2.6-pro", input: [
    { type: "additional_tools", tools: [{ type: "tool_search" }] },
    { role: "user", content: "Edit a file" }
  ], tools: [
    { type: "namespace", name: "functions", description: "Client tools", tools: [
      echo,
      custom,
      { type: "tool_search", execution: "client" }
    ] },
    { type: "tool_search" }
  ], tool_choice: "auto", parallel_tool_calls: true };
  const copy = structuredClone(body);
  const converted = buildResponsesRequest(body);

  assert.deepEqual(body, copy);
  assert.equal(converted.request.tools.length, 2);
  assert.ok(converted.request.tools.every(tool => tool.type === "function"));
  assert.equal(converted.tools.size, 2);
  assert.equal(converted.request.tool_choice, "auto");
  assert.equal(converted.request.parallel_tool_calls, true);
  assert.deepEqual(converted.responseTools, [
    { type: "namespace", name: "functions", description: "Client tools", tools: [echo, custom] }
  ]);
  const allowed = buildResponsesRequest({ ...input, tools: [echo, { type: "tool_search" }],
    tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "tool_search" }, { type: "function", name: "echo" }] } });
  assert.deepEqual(allowed.request.tools.map(tool => tool.function.name), ["echo"]);
  assert.throws(
    () => buildResponsesRequest({ ...input, tools: [echo, { type: "tool_search" }], tool_choice: { type: "tool_search" } }),
    /Deferred tool search is not supported/
  );
});

test("Responses tool choice accepts common object forms and allowed_tools", () => {
  for (const type of ["auto", "none", "required", "tool"]) {
    const converted = buildResponsesRequest({ ...input, tools: [echo], tool_choice: { type } });
    assert.equal(converted.request.tool_choice, type === "tool" ? "required" : type);
  }
  const converted = buildResponsesRequest({ ...input, tools: [echo, { ...echo, name: "other" }],
    tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "echo" }] } });
  assert.deepEqual(converted.request.tools.map(tool => tool.function.name), ["echo"]);
  assert.equal(converted.request.tool_choice, "required");
});

test("Responses omits optional hosted search declarations without changing client tools or input", () => {
  const clientTools = [echo, { ...echo, name: "web_search" }, { type: "custom", name: "web_search_preview" }];
  for (const type of searchTypes) {
    const body = { ...input, tools: [{ type, search_context_size: "medium", external_web_access: false }, ...clientTools],
      tool_choice: "auto", parallel_tool_calls: true };
    const copy = structuredClone(body);
    const converted = buildResponsesRequest(body);
    assert.deepEqual(body, copy);
    assert.deepEqual(converted.request.tools.map(tool => tool.function.name), ["echo", "web_search", "web_search_preview"]);
    assert.equal(converted.tools.size, 3);
    assert.equal(converted.tools.get("web_search_preview").type, "custom");
    assert.equal(converted.request.tool_choice, "auto");
    assert.equal(converted.request.parallel_tool_calls, true);
    assert.deepEqual(converted.responseTools, clientTools);
  }
});

test("Responses omits tool fields when only optional hosted search is advertised", () => {
  for (const type of searchTypes) {
    for (const choice of [undefined, "auto", "none", { type: "auto" }, { type: "none" }]) {
      const converted = buildResponsesRequest({ ...input, tools: [{ type }], tool_choice: choice, parallel_tool_calls: true });
      for (const field of ["tools", "tool_choice", "parallel_tool_calls"]) assert.equal(field in converted.request, false);
      assert.equal(converted.tools.size, 0);
      assert.deepEqual(converted.responseTools, []);
    }
  }
});

test("Responses filters hosted search from nested namespaces and additional_tools", () => {
  const custom = { type: "custom", name: "apply_patch" };
  const body = { tools: [
    { type: "namespace", name: "functions", description: "Client tools", tools: [
      { type: "namespace", name: "edits", tools: [custom, { type: "web_search" }] },
      { type: "web_search_preview" }
    ] },
    { type: "namespace", name: "search_only", tools: [{ type: "web_search" }] }
  ], input: [
    { type: "additional_tools", tools: [{ type: "web_search_preview" }, echo] },
    { role: "user", content: "Edit a file" }
  ] };
  const copy = structuredClone(body);
  const converted = buildResponsesRequest(body);
  assert.deepEqual(body, copy);
  assert.equal(converted.request.tools.length, 2);
  assert.deepEqual([...converted.tools.values()].map(tool => [tool.namespace, tool.name]), [["functions.edits", "apply_patch"], ["", "echo"]]);
  assert.deepEqual(converted.responseTools, [
    { type: "namespace", name: "functions", description: "Client tools", tools: [
      { type: "namespace", name: "edits", tools: [custom] }
    ] }, echo
  ]);
  assert.deepEqual(converted.request.messages, [{ role: "user", content: "Edit a file" }]);
});

test("Responses allowed_tools filters hosted search and preserves the remaining selection", () => {
  for (const type of searchTypes) {
    for (const mode of ["auto", "required"]) {
      const converted = buildResponsesRequest({ ...input, tools: [echo, { ...echo, name: "other" }, { type }],
        tool_choice: { type: "allowed_tools", mode, tools: [{ type }, { type: "function", name: "echo" }] } });
      assert.deepEqual(converted.request.tools.map(tool => tool.function.name), ["echo"]);
      assert.equal(converted.request.tool_choice, mode);
    }
    const converted = buildResponsesRequest({ ...input, tools: [echo, { type }],
      tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type }] } });
    assert.equal(converted.request.tools, undefined);
    assert.equal(converted.request.tool_choice, undefined);
  }
});

test("Responses rejects forced hosted search and unsatisfiable required choices before upstream access", async t => {
  let calls = 0;
  const instance = await app(t, async () => { calls++; return sse(complete); });
  for (const type of searchTypes) {
    for (const [tools, tool_choice, code] of [
      [[echo, { type }], { type }, "unsupported_tool"],
      [[{ type }], "required", "invalid_parameter"],
      [[{ type }], { type: "required" }, "invalid_parameter"],
      [[{ type }], { type: "tool" }, "invalid_parameter"],
      [[echo, { type }], { type: "allowed_tools", mode: "required", tools: [{ type }] }, "invalid_parameter"]
    ]) {
      const response = await instance.post({ ...input, tools, tool_choice, stream: true });
      assert.equal(response.status, 400);
      const error = (await response.json()).error;
      assert.equal(error.type, "invalid_request_error");
      assert.equal(error.param, "tool_choice");
      assert.equal(error.code, code);
      if (code === "unsupported_tool") assert.match(error.message, /web search/i);
    }
  }
  assert.equal(calls, 0);
});

for (const stream of [false, true]) {
  test("Responses " + (stream ? "SSE" : "JSON") + " accepts Codex default search declarations and reports available tools", async t => {
    let sent;
    const instance = await app(t, async (url, init) => { sent = JSON.parse(init.body); return sse(complete); });
    const search = { type: "web_search", external_web_access: false };
    for (const tools of [[search], [echo, search]]) {
      const response = await instance.post({ ...input, stream, tools, tool_choice: "auto", parallel_tool_calls: true });
      assert.equal(response.status, 200);
      const snapshots = stream ? (await events(response)).filter(event => event.response).map(event => event.response) : [await response.json()];
      const available = tools.length === 1 ? [] : [echo];
      for (const snapshot of snapshots) assert.deepEqual(snapshot.tools, available);
      assert.equal(snapshots.at(-1).status, "completed");
      assert.equal(outputText(snapshots.at(-1)), "你好");
      if (available.length) {
        assert.deepEqual(sent.tools.map(tool => tool.function.name), ["echo"]);
        assert.equal(sent.tool_choice, "auto");
        assert.equal(sent.parallel_tool_calls, true);
      } else {
        for (const field of ["tools", "tool_choice", "parallel_tool_calls"]) assert.equal(field in sent, false);
      }
    }
  });
}

test("Responses HTTP routes accept ordinary SDK requests and preserve response metadata", async t => {
  let sent;
  const instance = await app(t, async (url, init) => { sent = JSON.parse(init.body); return sse(complete); });
  const response = await instance.post({ ...input, store: true, metadata: { app: "test" } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.object, "response");
  assert.match(data.id, /^resp_/);
  assert.equal(data.model, "served-model");
  assert.equal(data.created_at, 123);
  assert.equal(data.status, "completed");
  assert.equal(data.store, false);
  assert.equal(data.usage, null);
  assert.equal(outputText(data), "你好");
  assert.deepEqual(data.metadata, { app: "test" });
  assert.equal(sent.model, "mimo-pro");
  assert.equal(sent.stream, true);
  assert.equal((await instance.post(input, "/responses?alias=1")).status, 200);
});

for (const [fixture, expectedType, expectedText] of [
  ["client-baseline", "message", "OK"], ["proxy-tools", "function_call", ""]
]) {
  test("Responses JSON and SSE replay the real " + fixture + " stream with tail usage", async t => {
    const raw = await fs.readFile(new URL("./fixtures/" + fixture + "/response.sse", import.meta.url));
    const instance = await app(t, async () => new Response(new ReadableStream({
      start(controller) { for (const byte of raw) controller.enqueue(Uint8Array.of(byte)); controller.close(); }
    }), { headers: { "content-type": "text/event-stream" } }));
    const request = { ...input, tools: [echo] };
    const plain = await (await instance.post(request)).json();
    const stream = await events(await instance.post({ ...request, stream: true }));
    assert.equal(stream[0].type, "response.created");
    assert.deepEqual(stream[0].response.output, []);
    assert.equal(stream[0].response.usage, null);
    assert.equal(stream[1].type, "response.in_progress");
    assert.equal(stream.at(-1).type, "response.completed");
    const final = stream.at(-1).response;
    assert.equal(outputText(final), expectedText);
    assert.deepEqual(final.usage, plain.usage);
    assert.equal(final.model, "mimo-x-pro-preview");
    assert.ok(final.usage.total_tokens > 0);
    const clean = output => output.map(({ id, ...item }) => item);
    assert.deepEqual(clean(final.output), clean(plain.output));
    const items = stream.filter(event => event.type === "response.output_item.added");
    assert.deepEqual(items.map(event => event.output_index), items.map((_, index) => index));
    for (const event of items) assert.equal(event.item.status, "in_progress");
    const finishedItems = stream.filter(event => event.type === "response.output_item.done");
    assert.deepEqual(finishedItems.map(event => event.item), final.output);
    const output = final.output.find(item => item.type === expectedType);
    assert.ok(output);
    if (expectedType === "function_call") {
      assert.equal(output.name, "echo");
      assert.deepEqual(JSON.parse(output.arguments), { text: "OK" });
      const argumentsText = stream.filter(event => event.type === "response.function_call_arguments.delta").map(event => event.delta).join("");
      assert.equal(argumentsText, output.arguments);
      assert.equal(final.output.some(item => item.type === "message"), false);
    } else {
      assert.equal(stream.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join(""), "OK");
    }
  });
}

test("Responses function-call history completes a two-request HTTP tool loop", async t => {
  let turn = 0;
  const tools = [echo, { type: "web_search" }];
  const instance = await app(t, async (url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.tools.map(tool => tool.function.name), ["echo"]);
    if (++turn === 1) return sse(chunk({ reasoning_content: "Use echo" }) + chunk({ tool_calls: [
      { index: 0, id: "call_echo", function: { name: "echo", arguments: '{"text":"OK"}' } }
    ] }, "tool_calls") + done);
    assert.deepEqual(body.messages.map(message => message.role), ["user", "assistant", "tool"]);
    assert.equal(body.messages[1].reasoning_content, "Use echo");
    assert.equal(body.messages[1].tool_calls[0].id, "call_echo");
    assert.equal(body.messages[2].tool_call_id, "call_echo");
    assert.equal(body.messages[2].content, "OK");
    return sse(chunk({ content: "Tool said OK" }, "stop") + done);
  });
  const first = await (await instance.post({ ...input, tools })).json();
  assert.deepEqual(first.tools, [echo]);
  const call = first.output.find(item => item.type === "function_call");
  const second = await (await instance.post({ model: input.model, tools, input: [
    { role: "user", content: input.input }, ...first.output,
    { type: "function_call_output", call_id: call.call_id, output: "OK" }
  ] })).json();
  assert.equal(outputText(second), "Tool said OK");
  assert.equal(turn, 2);
});

test("Responses JSON upstream supports parallel tool calls without stream indexes", async t => {
  const instance = await app(t, async () => Response.json({
    id: "json-upstream", model: "served-model", choices: [{ index: 0, finish_reason: "tool_calls", message: {
      role: "assistant", content: null, tool_calls: [
        { id: "call_a", type: "function", function: { name: "echo", arguments: '{"text":"A"}' } },
        { id: "call_b", type: "function", function: { name: "echo", arguments: '{"text":"B"}' } }
      ]
    } }]
  }));
  const stream = await events(await instance.post({ ...input, tools: [echo], stream: true }));
  const calls = stream.at(-1).response.output;
  assert.deepEqual(calls.map(call => call.call_id), ["call_a", "call_b"]);
  assert.deepEqual(calls.map(call => JSON.parse(call.arguments).text), ["A", "B"]);
});

test("Responses namespace custom tools unwrap raw input and replay it through Chat", async t => {
  let turn = 0;
  let upstreamName;
  const rawInput = "第一行\n*** End Patch";
  const tools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "apply_patch" }] }, { type: "web_search_preview" }];
  const instance = await app(t, async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.tools.length, 1);
    upstreamName = body.tools[0].function.name;
    if (++turn === 1) {
      const args = JSON.stringify({ input: rawInput });
      return sse(chunk({ tool_calls: [{ index: 0, id: "custom_call", function: { name: upstreamName, arguments: args.slice(0, 7) } }] }) +
        chunk({ tool_calls: [{ index: 0, id: null, function: { name: null, arguments: args.slice(7) } }] }, "tool_calls") + done);
    }
    assert.equal(body.messages[1].tool_calls[0].function.name, upstreamName);
    assert.deepEqual(JSON.parse(body.messages[1].tool_calls[0].function.arguments), { input: rawInput });
    assert.equal(body.messages[2].content, "Applied");
    return sse(complete);
  });
  const streamed = await events(await instance.post({ ...input, tools, stream: true }));
  const output = streamed.at(-1).response.output;
  assert.equal(output[0].type, "custom_tool_call");
  assert.equal(output[0].name, "apply_patch");
  assert.equal(output[0].namespace, "functions");
  assert.equal(output[0].input, rawInput);
  assert.equal(streamed.filter(event => event.type === "response.custom_tool_call_input.delta").map(event => event.delta).join(""), rawInput);
  assert.equal(streamed.some(event => event.type === "response.function_call_arguments.delta"), false);
  const response = await instance.post({ tools, input: [{ role: "user", content: input.input }, ...output,
    { type: "custom_tool_call_output", call_id: output[0].call_id, output: "Applied" }] });
  assert.equal(response.status, 200);
  assert.equal(turn, 2);
});

test("Responses rejects unavailable execution features and broken histories before upstream access", async t => {
  let calls = 0;
  const instance = await app(t, async () => { calls++; return sse(complete); });
  for (const body of [
    null, [], {}, { ...input, stream: "true" },
    { ...input, previous_response_id: "resp_old" }, { ...input, conversation: "conv_old" },
    { ...input, background: true },
    ...["file_search", "mcp", "code_interpreter", "web_search_unknown"].map(type => ({ ...input, tools: [{ type }] })),
    { input: [{ type: "web_search_call", id: "ws_old", status: "completed", action: { type: "search", query: "example" } }] },
    { input: [{ role: "user", content: [{ type: "input_file", file_id: "file_a" }] }] },
    { input: [{ type: "function_call_output", call_id: "absent", output: "OK" }] },
    { input: [{ type: "function_call", call_id: "call_a", name: "echo", arguments: "{}" }] },
    { ...input, tool_choice: "required" }, { ...input, n: 2 }
  ]) {
    const response = await instance.post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    const error = (await response.json()).error;
    assert.equal(error.type, "invalid_request_error");
    assert.ok(error.message);
  }
  assert.equal(calls, 0);
});

test("Responses endpoints accept LAN requests with or without a placeholder key", async t => {
  const instance = await app(t);
  assert.equal((await instance.post()).status, 200);
  assert.equal((await instance.post(input, "/responses", { authorization: "Bearer local" })).status, 200);
});

test("Responses sends a text delta while the upstream is still open", { timeout: 3000 }, async t => {
  let release;
  let cancelled = false;
  const gate = new Promise(resolve => release = resolve);
  t.after(() => release());
  const instance = await app(t, async () => {
    let first = true;
    return new Response(new ReadableStream({
      async pull(controller) {
        if (first) { first = false; controller.enqueue(Buffer.from(chunk({ content: "early" }))); return; }
        await gate;
        controller.enqueue(Buffer.from(chunk({ content: " late" }, "stop") + done));
        controller.close();
      },
      cancel() { cancelled = true; }
    }), { headers: { "content-type": "text/event-stream" } });
  });
  const response = await instance.post({ ...input, stream: true });
  let early = false;
  let completed;
  for await (const event of readSSE(response.body)) {
    const data = JSON.parse(event.data);
    if (data.type === "response.output_text.delta" && !early) {
      assert.equal(data.delta, "early");
      early = true;
      release();
    }
    if (data.type === "response.completed") completed = data.response;
  }
  assert.equal(early, true);
  assert.equal(outputText(completed), "early late");
  assert.equal(cancelled, false);
});

for (const [finishReason, reason] of [["length", "max_output_tokens"], ["content_filter", "content_filter"]]) {
  test("Responses maps " + finishReason + " to an incomplete response", async t => {
    const instance = await app(t, async () => sse(chunk({ content: "partial" }, finishReason) + done));
    const plain = await (await instance.post()).json();
    assert.equal(plain.status, "incomplete");
    assert.deepEqual(plain.incomplete_details, { reason });
    const stream = await events(await instance.post({ ...input, stream: true }));
    assert.equal(stream.at(-1).type, "response.incomplete");
    assert.equal(stream.at(-1).response.output[0].status, "incomplete");
    assert.equal(stream.some(event => event.type === "response.completed"), false);
  });
}

test("Responses preserves refusal content and an empty successful answer", async t => {
  const instance = await app(t, async () => sse(chunk({ refusal: "Cannot answer" }, "stop") + done));
  const stream = await events(await instance.post({ ...input, stream: true }));
  assert.equal(stream.at(-1).response.output[0].content[0].refusal, "Cannot answer");
  assert.equal(stream.find(event => event.type === "response.refusal.delta").delta, "Cannot answer");
  const empty = await app(t, async () => sse(chunk({ role: "assistant", content: "" }, "stop") + done));
  const result = await (await empty.post()).json();
  assert.equal(result.status, "completed");
  assert.equal(result.output.length, 1);
  assert.equal(outputText(result), "");
});

const writeStdin = { type: "function", name: "write_stdin", parameters: { type: "object", properties: {
  session_id: { type: "integer" }, chars: { type: "string" },
  yield_time_ms: { type: "integer" }, max_output_tokens: { type: "integer" } } } };
const textToolCall = "<tool_call><function=write_stdin><parameter=session_id>70855</parameter><parameter=chars>" +
  "\u0003</parameter><parameter=yield_time_ms>1000</parameter><parameter=max_output_tokens>1000</parameter></function></tool_call>";

test("Responses recovers a truncated text tool call and keeps the dialect out of the transcript", async t => {
  const split = textToolCall.indexOf("\u0003");
  const instance = await app(t, async () => sse(
    chunk({ role: "assistant", content: textToolCall.slice(0, split) }) +
    chunk({ content: textToolCall.slice(split) }) +
    chunk({ tool_calls: [{ index: 0, id: "call_82f375529b9849468057e4ac",
      function: { name: "write_stdin", arguments: '{"session_id": 70855, "chars": ' } }] }) +
    chunk({}, "tool_calls") + done));
  const stream = await events(await instance.post({ ...input, tools: [writeStdin], stream: true }));
  const final = stream.at(-1).response;
  assert.equal(final.status, "completed");
  const call = final.output.find(item => item.type === "function_call");
  assert.equal(call.name, "write_stdin");
  assert.deepEqual(JSON.parse(call.arguments), { session_id: 70855, chars: "\u0003", yield_time_ms: 1000, max_output_tokens: 1000 });
  const streamed = stream.filter(event => event.type === "response.function_call_arguments.delta").map(event => event.delta).join("");
  assert.deepEqual(JSON.parse(streamed), JSON.parse(call.arguments));
  assert.equal(final.output.some(item => item.type === "message"), false);
  assert.equal(stream.some(event => event.type === "response.output_text.delta"), false);
});

test("Responses escapes raw control characters inside native tool arguments", async t => {
  const instance = await app(t, async () => sse(
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_ctrl", function: { name: "write_stdin",
      arguments: '{"session_id": 70855, "chars": "' } }] }) +
    chunk({ tool_calls: [{ index: 0, id: null, function: { name: null, arguments: "\u0003\"}" } }] }) +
    chunk({}, "tool_calls") + done));
  const stream = await events(await instance.post({ ...input, tools: [writeStdin], stream: true }));
  const call = stream.at(-1).response.output.find(item => item.type === "function_call");
  assert.deepEqual(JSON.parse(call.arguments), { session_id: 70855, chars: "\u0003" });
});

test("Responses fails with a typed error when tool arguments stay unrepairable", async t => {
  const instance = await app(t, async () => sse(
    chunk({ tool_calls: [{ index: 0, id: "call_broken", function: { name: "echo", arguments: '{"text": "未' } }] }) +
    chunk({}, "tool_calls") + done));
  const stream = await events(await instance.post({ ...input, tools: [echo], stream: true }));
  assert.equal(stream.at(-2).type, "error");
  assert.equal(stream.at(-2).code, "invalid_tool_arguments");
  assert.equal(stream.at(-1).type, "response.failed");
  assert.equal(stream.at(-1).response.error.code, "invalid_tool_arguments");
  assert.equal(stream.some(event => event.type === "response.completed"), false);
});

test("Responses strips truncated text tool calls from replayed history", async t => {
  let sent;
  const instance = await app(t, async (url, init) => { sent = JSON.parse(init.body); return sse(complete); });
  const split = textToolCall.indexOf("\u0003");
  const response = await instance.post({ model: "mimo-pro", tools: [writeStdin], input: [
    { role: "user", content: "继续" },
    { type: "message", role: "assistant", content: textToolCall.slice(0, split) },
    { type: "message", role: "assistant", content: textToolCall.slice(split) },
    { type: "function_call", call_id: "call_1", name: "write_stdin", arguments: '{"session_id": 70855, "chars": ' },
    { type: "function_call_output", call_id: "call_1", output: "继续" }
  ] });
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(sent).includes("<tool_call>"), false);
  assert.equal(JSON.stringify(sent).includes("<parameter="), false);
  assert.deepEqual(sent.messages.map(message => message.role), ["user", "assistant", "assistant", "tool"]);
});

test("Responses retains HTTP errors and rejects malformed upstream output before headers", async t => {
  const cases = [
    [() => Response.json({ error: { message: "rate limited" } }, { status: 429 }), 429],
    [() => sse("data: invalid JSON\n\n"), 502],
    [() => sse('event: error\ndata: {"error":{"message":"quota"}}\n\n'), 502],
    [() => sse('data: {"choices":[{"index":0,"delta":{}},{"index":1,"delta":{}}]}\n\n' + done), 502]
  ];
  for (const [makeResponse, status] of cases) {
    const instance = await app(t, async () => makeResponse());
    const response = await instance.post({ ...input, stream: true });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.type, "upstream_error");
  }
});

test("Responses emits typed failure events on malformed or incomplete streams", async t => {
  for (const tail of ["data: malformed\n\n", "", "data: incomplete"]) {
    const instance = await app(t, async () => sse(chunk({ content: "partial" }) + tail));
    const stream = await events(await instance.post({ ...input, stream: true }));
    assert.equal(stream.at(-2).type, "error");
    assert.equal(stream.at(-1).type, "response.failed");
    assert.equal(stream.at(-1).response.status, "failed");
    assert.equal(stream.at(-1).response.output[0].status, "incomplete");
    assert.equal(stream.some(event => event.type === "response.completed"), false);
    assert.equal((await fetch(instance.base + "/health")).status, 200);
  }
});

test("Responses consumes the tail usage and cancels after DONE without waiting for EOF", { timeout: 3000 }, async t => {
  let cancelled = false;
  const instance = await app(t, async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(chunk({ content: "OK" }, "stop") +
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n' + done));
    },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/event-stream" } }));
  const stream = await events(await instance.post({ ...input, stream: true }));
  assert.equal(stream.at(-1).response.usage.total_tokens, 5);
  assert.equal(cancelled, true);
});

test("Responses accepts a finished stream at EOF without DONE", async t => {
  const instance = await app(t, async () => sse(chunk({ content: "OK" }, "stop")));
  const stream = await events(await instance.post({ ...input, stream: true }));
  assert.equal(stream.at(-1).type, "response.completed");
  assert.equal(outputText(stream.at(-1).response), "OK");
});

test("Responses propagates timeouts before and during streaming", { timeout: 3000 }, async t => {
  const before = await app(t, async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), { timeoutMs: 40 });
  const response = await before.post(input);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.type, "upstream_timeout");
  const during = await app(t, async (url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(chunk({ content: "started" })));
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    }
  }), { headers: { "content-type": "text/event-stream" } }), { timeoutMs: 40 });
  const stream = await events(await during.post({ ...input, stream: true }));
  assert.equal(stream.at(-2).code, "upstream_timeout");
  assert.equal(stream.at(-1).type, "response.failed");
});

test("Disconnecting a Responses client cancels its upstream request", { timeout: 3000 }, async t => {
  let observed;
  const cancelled = new Promise(resolve => observed = resolve);
  const instance = await app(t, async (url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(chunk({ content: "started" })));
      signal.addEventListener("abort", () => { controller.error(signal.reason); observed(); }, { once: true });
    }
  }), { headers: { "content-type": "text/event-stream" } }));
  const response = await instance.post({ ...input, stream: true });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await cancelled;
});

test("Responses bounds buffered output and reports the limit as a stream failure", async t => {
  const instance = await app(t, async () => sse(chunk({ content: "started" }) + chunk({ content: "x".repeat(8192) }, "stop") + done), { maxResponseBytes: 4096 });
  const stream = await events(await instance.post({ ...input, stream: true }));
  assert.equal(stream.at(-1).type, "response.failed");
  assert.match(stream.at(-1).response.error.message, /MAX_RESPONSE_BYTES/);
  assert.equal(outputText(stream.at(-1).response), "started");
});

test("Responses handles fragmented tool headers and alternating reasoning/text segments", async t => {
  const instance = await app(t, async () => sse(
    chunk({ reasoning_content: "first thought" }) + chunk({ content: "first answer" }) +
    chunk({ reasoning_content: "second thought" }) + chunk({ content: "second answer" }) +
    chunk({ tool_calls: [{ index: 0, id: "call_", function: { name: "ec", arguments: "" } }] }) +
    chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "ho", arguments: '{"text":"OK"}' } }] }, "tool_calls") + done
  ));
  const stream = await events(await instance.post({ ...input, tools: [echo], stream: true }));
  const output = stream.at(-1).response.output;
  assert.deepEqual(output.map(item => item.type), ["reasoning", "message", "reasoning", "message", "function_call"]);
  assert.equal(output[4].call_id, "call_a");
  assert.equal(output[4].name, "echo");
  assert.deepEqual(JSON.parse(output[4].arguments), { text: "OK" });
});
