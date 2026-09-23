import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProxyServer, createAuthHeaders, getAuthHeaders, readConfig } from "../mimo_server.js";
import { listenForFetch } from "../scripts/http_fixture.js";

const message = {messages: [{role: "user", content: "你好"}]};
const event = (delta, finish_reason = null, extra = {}) => "data: " + JSON.stringify({
  id: "captured-test-id", model: "served-model", created: 123,
  choices: [{index: 0, delta, finish_reason}], ...extra
}) + "\n\n";
const complete = event({role: "assistant", content: "你好"}, "stop") + "data: [DONE]\n\n";
const response = text => new Response(text, {headers: {"content-type": "text/event-stream"}});

async function withServer(t, {fetchImpl = async () => response(complete), authProvider, ...options} = {}) {
  const server = createProxyServer({
    config: readConfig({}), ...options, fetchImpl, logger: {info() {}, warn() {}, error() {}},
    authProvider: authProvider || (async () => new Headers({"cookie": "mock-cookie", "content-type": "application/json"}))
  });
  await listenForFetch(server);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  return {server, base, post: (body = message, extra = {}) => fetch(base + "/v1/chat/completions", {
    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body), ...extra
  })};
}

test("LAN routes work without an API key and accept client placeholder keys", async t => {
  let calls = 0;
  const app = await withServer(t, {fetchImpl: async (url, init) => {
    calls++;
    assert.equal(init.headers.get("authorization"), null);
    return response(complete);
  }});
  assert.equal((await fetch(app.base + "/health?probe=1")).status, 200);
  const options = await fetch(app.base + "/any", {method: "OPTIONS"});
  assert.equal(options.status, 204);
  assert.match(options.headers.get("access-control-allow-headers"), /Authorization/);
  const models = await fetch(app.base + "/v1/models");
  assert.equal(models.status, 200);
  const data = await models.json();
  assert.deepEqual(data.data.map(model => model.id), ["mimo-v2.6-pro", "mimo-v2.6-flash"]);
  assert.ok(data.data[0].created < 1e11);
  assert.equal(calls, 0);
  assert.equal((await app.post()).status, 200);
  assert.equal((await app.post(message, {headers: {authorization: "Bearer local"}})).status, 200);
  assert.equal(calls, 2);
});

test("Optional proxy authentication protects API routes while health and preflight stay available", async t => {
  let calls = 0;
  const app = await withServer(t, { config: readConfig({ apiKey: "configured-key" }),
    fetchImpl: async () => { calls++; return response(complete); } });
  assert.equal((await fetch(app.base + "/health")).status, 200);
  assert.equal((await fetch(app.base + "/v1/responses", { method: "OPTIONS" })).status, 204);
  for (const endpoint of ["/v1/models", "/v1/chat/completions", "/chat/completions", "/v1/responses", "/responses"]) {
    const method = endpoint === "/v1/models" ? "GET" : "POST";
    const body = method === "GET" ? undefined : JSON.stringify(endpoint.includes("responses") ? { input: "hello" } : message);
    for (const key of [undefined, "wrong-key", "configured-key"]) {
      const headers = { "content-type": "application/json", ...(key ? { authorization: "Bearer " + key } : {}) };
      const result = await fetch(app.base + endpoint, { method, body, headers });
      assert.equal(result.status, key === "configured-key" ? 200 : 401);
      if (result.status === 401) assert.equal((await result.json()).error.type, "authentication_error");
      else await result.text();
    }
  }
  assert.equal(calls, 4);
});

test("Configured Cookie, upstream, headers and model list apply to Chat and Responses", async t => {
  const sent = [];
  const app = await withServer(t, {
    config: readConfig({ cookie: "environment=mock", models: [" custom-model", "second-model", "custom-model"],
      clientVersion: "custom-version", source: "custom-source",
      upstreamUrl: "https://upstream.example.test/chat" }),
    authProvider: getAuthHeaders,
    fetchImpl: async (url, { headers, body }) => {
      assert.equal(url, "https://upstream.example.test/chat");
      assert.equal(headers.get("cookie"), "environment=mock");
      assert.equal(headers.get("x-client-version"), "custom-version");
      assert.equal(headers.get("x-mimo-source"), "custom-source");
      assert.equal(headers.get("authorization"), null);
      sent.push(JSON.parse(body).model);
      return response(complete);
    }
  });
  assert.equal((await app.post()).status, 200);
  assert.equal((await app.post({ ...message, model: "second-model" })).status, 200);
  assert.equal((await app.post({ ...message, model: "mimo-flash" })).status, 200);
  for (const model of [undefined, "second-model"]) {
    const result = await fetch(app.base + "/v1/responses", {
      method: "POST", body: JSON.stringify({ input: "hello", model }), headers: { "content-type": "application/json" }
    });
    assert.equal(result.status, 200);
    await result.text();
  }
  assert.deepEqual(sent, ["custom-model", "second-model", "mimo-flash", "custom-model", "second-model"]);
  const models = await (await fetch(app.base + "/v1/models")).json();
  assert.deepEqual(models.data.map(model => model.id), ["custom-model", "second-model"]);
});

test("A single configured model replaces the built-in model list", async t => {
  const app = await withServer(t, { config: readConfig({ models: "single-model" }) });
  const models = await (await fetch(app.base + "/v1/models")).json();
  assert.deepEqual(models.data.map(model => model.id), ["single-model"]);
});

test("HTTP request maps legacy options and preserves extra request fields", async t => {
  let sent;
  const app = await withServer(t, {fetchImpl: async (url, init) => {
    sent = JSON.parse(init.body); return response(complete);
  }});
  const tools = [{type: "function", function: {name: "echo", parameters: {type: "object"}}}];
  const r = await app.post({...message, model: "mimo-auto", thinking: true, stream: false, temperature: 0.2, tools, tool_choice: "auto", response_format: {type: "json_object"}});
  assert.equal(r.status, 200);
  await r.json();
  assert.equal(sent.stream, true);
  assert.equal(sent.model, "mimo-pro");
  assert.equal(sent.reasoning_effort, "high");
  assert.equal(sent.thinking, undefined);
  assert.equal(sent.temperature, 0.2);
  assert.deepEqual(sent.tools, tools);
  assert.deepEqual(sent.response_format, {type: "json_object"});
});

test("HTTP body preserves a Chinese character split between TCP writes", async t => {
  let received;
  const app = await withServer(t, {fetchImpl: async (url, init) => {received = JSON.parse(init.body); return response(complete);}});
  const bytes = Buffer.from(JSON.stringify(message));
  const split = bytes.indexOf(Buffer.from("你")) + 1;
  const result = await new Promise((resolve, reject) => {
    const req = http.request(app.base + "/chat/completions", {method: "POST"}, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", chunk => body += chunk);
      res.on("end", () => resolve({status: res.statusCode, body}));
    });
    req.on("error", reject);
    req.write(bytes.subarray(0, split));
    setTimeout(() => req.end(bytes.subarray(split)), 15);
  });
  assert.equal(result.status, 200);
  assert.equal(received.messages[0].content, "你好");
});

test("Malformed JSON, empty messages, and string stream flags return 400 before authentication", async t => {
  let calls = 0;
  const app = await withServer(t, {authProvider: async () => {calls++; return new Headers();}});
  const invalid = await app.post({}, {body: "{invalid"});
  assert.equal(invalid.status, 400);
  for (const body of [null, [], {}, {messages: []}, {...message, stream: "false"}, {...message, model: 1}]) {
    const r = await app.post(body);
    assert.equal(r.status, 400);
    await r.text();
  }
  assert.equal(calls, 0);
});

test("Oversized request receives 413 while the server remains healthy", async t => {
  const app = await withServer(t, { maxBodyBytes: 64 });
  const r = await app.post({messages: [{role: "user", content: "x".repeat(256)}]});
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error.type, "invalid_request_error");
  assert.equal((await fetch(app.base + "/health")).status, 200);
});

test("Non-stream HTTP response preserves upstream ID, model, reasoning, usage, and length finish", async t => {
  const app = await withServer(t, {fetchImpl: async () => response(
    event({role: "assistant", reasoning_content: "想"}) +
    event({content: "答"}, "length") +
    'data: {"id":"captured-test-id","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n' +
    "data: [DONE]\n\n"
  )});
  const r = await app.post();
  const data = await r.json();
  assert.equal(data.id, "captured-test-id");
  assert.equal(data.model, "served-model");
  assert.equal(data.created, 123);
  assert.equal(data.choices[0].finish_reason, "length");
  assert.equal(data.choices[0].message.reasoning_content, "想");
  assert.equal(data.choices[0].message.content, "答");
  assert.equal(data.usage.total_tokens, 6);
});

test("Streaming HTTP response retains role, tool calls, and usage-only chunks", async t => {
  const tool = {index: 0, id: "call_1", type: "function", function: {name: "echo", arguments: "{}"}};
  const app = await withServer(t, {fetchImpl: async () => response(
    event({role: "assistant", tool_calls: [tool]}, "tool_calls") +
    'data: {"choices":[],"usage":{"total_tokens":7}}\n\n' +
    "data: [DONE]\n\n"
  )});
  const r = await app.post({...message, stream: true});
  const text = await r.text();
  const chunks = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(5)));
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.deepEqual(chunks[0].choices[0].delta.tool_calls, [{...tool, function: {name: "echo", arguments: ""}}]);
  assert.equal(chunks[0].choices[0].finish_reason, null);
  assert.deepEqual(chunks[1].choices[0].delta.tool_calls, [{index: 0, function: {arguments: "{}"}}]);
  assert.equal(chunks[2].choices[0].finish_reason, "tool_calls");
  assert.equal(chunks[3].usage.total_tokens, 7);
  assert.equal(chunks[0].id, chunks[3].id);
  const argumentsText = chunks.flatMap(chunk => chunk.choices).flatMap(choice => choice.delta?.tool_calls || []).map(call => call.function.arguments).join("");
  assert.deepEqual(JSON.parse(argumentsText), {});
});

test("Chat stream repairs a truncated text tool call and hidden XML dialect", async t => {
  const writeStdin = { type: "function", function: { name: "write_stdin", parameters: { type: "object", properties: {
    session_id: { type: "integer" }, chars: { type: "string" }, yield_time_ms: { type: "integer" } } } } };
  const app = await withServer(t, {fetchImpl: async () => response(
    event({role: "assistant", content: "<tool_call><function=write_stdin><parameter=session_id>70855</parameter><parameter=chars>"}) +
    event({content: "\u0003</parameter><parameter=yield_time_ms>1000</parameter></function></tool_call>"}) +
    event({tool_calls: [{index: 0, id: "call_truncated", type: "function",
      function: {name: "write_stdin", arguments: '{"session_id": 70855, "chars": '}}]}) +
    event({}, "tool_calls") +
    "data: [DONE]\n\n"
  )});
  const r = await app.post({...message, stream: true, tools: [writeStdin]});
  assert.equal(r.status, 200);
  const chunks = (await r.text()).split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(5)));
  const text = chunks.flatMap(chunk => chunk.choices).map(choice => choice.delta?.content || "").join("");
  assert.equal(text, "");
  const calls = chunks.flatMap(chunk => chunk.choices).flatMap(choice => choice.delta?.tool_calls || []);
  assert.deepEqual(calls.map(call => call.function.arguments).join(""), '{"session_id":70855,"chars":"\\u0003","yield_time_ms":1000}');
  assert.deepEqual(JSON.parse(calls.map(call => call.function.arguments).join("")), {session_id: 70855, chars: "\u0003", yield_time_ms: 1000});
  assert.deepEqual(chunks.flatMap(chunk => chunk.choices).map(choice => choice.finish_reason).filter(Boolean), ["tool_calls"]);
});

test("DONE cancels a still-open upstream connection without waiting for EOF", async t => {
  let cancelled = false;
  const app = await withServer(t, {fetchImpl: async () => new Response(new ReadableStream({
    start(controller) {controller.enqueue(Buffer.from(complete));},
    cancel() {cancelled = true;}
  }), {headers: {"content-type": "text/event-stream"}})});
  const r = await app.post({...message, stream: true});
  assert.match(await r.text(), /data: \[DONE\]\n\n$/);
  assert.equal(cancelled, true);
});

test("A complete finish chunk can terminate at EOF without a DONE marker", async t => {
  const app = await withServer(t, {fetchImpl: async () => response(event({content: "ok"}, "stop"))});
  const r = await app.post();
  assert.equal(r.status, 200);
  assert.equal((await r.json()).choices[0].finish_reason, "stop");
});

test("Incomplete generation is reported as an error instead of a false success", async t => {
  const app = await withServer(t, {fetchImpl: async () => response(event({content: "partial"}))});
  const r = await app.post();
  assert.equal(r.status, 502);
  assert.match((await r.json()).error.message, /before completion/);
});

test("Multi-line data events work through HTTP", async t => {
  const app = await withServer(t, {fetchImpl: async () => response(
    'data: {"choices":\r\ndata: [{"index":0,"delta":{"content":"多行"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n'
  )});
  const r = await app.post();
  assert.equal((await r.json()).choices[0].message.content, "多行");
});

test("HTTP 200 SSE errors and malformed JSON become 502 before output starts", async t => {
  for (const payload of ['event: error\ndata: {"error":{"message":"quota exceeded"}}\n\n', "data: malformed\n\n"]) {
    const app = await withServer(t, {fetchImpl: async () => response(payload)});
    const r = await app.post({...message, stream: true});
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error.type, "upstream_error");
  }
});

test("Mid-stream read failure returns an SSE error and does not crash the HTTP server", async t => {
  const app = await withServer(t, {fetchImpl: async () => {
    let sent = false;
    return new Response(new ReadableStream({
      async pull(controller) {
        if (!sent) {sent = true; controller.enqueue(Buffer.from(event({content: "partial"}))); return;}
        await new Promise(resolve => setTimeout(resolve, 10));
        controller.error(new Error("simulated connection loss"));
      }
    }), {headers: {"content-type": "text/event-stream"}});
  }});
  const r = await app.post({...message, stream: true});
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /partial/);
  assert.match(text, /"error":/);
  assert.match(text, /simulated connection loss/);
  assert.match(text, /data: \[DONE\]/);
  assert.equal((await fetch(app.base + "/health")).status, 200);
});

test("Upstream status codes and JSON error messages are retained", async t => {
  const app = await withServer(t, {fetchImpl: async () => new Response('{"error":{"message":"rate limited"}}', {
    status: 429, headers: {"content-type": "application/json"}
  })});
  const r = await app.post();
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.message, "rate limited");
});

test("A JSON completion returned by upstream can be aggregated or streamed", async t => {
  const app = await withServer(t, {fetchImpl: async () => Response.json({
    id: "json-id", model: "actual-model", choices: [{index: 0, message: {role: "assistant", content: "ok"}, finish_reason: "stop"}], usage: {total_tokens: 3}
  })});
  const r = await app.post();
  assert.equal((await r.json()).choices[0].message.content, "ok");
  const streamed = await app.post({...message, stream: true});
  const text = await streamed.text();
  assert.match(text, /"delta":\{"role":"assistant","content":"ok"\}/);
  assert.match(text, /"usage":\{"total_tokens":3\}/);
});

test("Upstream deadline cancels fetch and returns 504", async t => {
  const app = await withServer(t, {config: readConfig({timeoutMs: 25}), fetchImpl: async (url, {signal}) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {once: true});
  })});
  const r = await app.post();
  assert.equal(r.status, 504);
  assert.equal((await r.json()).error.type, "upstream_timeout");
});

test("Disconnecting a streaming client aborts the upstream request", async t => {
  let abortSeen;
  const aborted = new Promise(resolve => abortSeen = resolve);
  const app = await withServer(t, {fetchImpl: async (url, {signal}) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(event({content: "first"})));
      signal.addEventListener("abort", () => {abortSeen(); controller.error(signal.reason);}, {once: true});
    }
  }), {headers: {"content-type": "text/event-stream"}})});
  const r = await app.post({...message, stream: true});
  const reader = r.body.getReader();
  await reader.read();
  await reader.cancel();
  await Promise.race([aborted, new Promise((resolve, reject) => {const timer = setTimeout(() => reject(new Error("Upstream was not cancelled")), 1000); timer.unref();})]);
});

async function authJsonPath(t) {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, "mimo-auth-test-"));
  assert.equal(path.dirname(directory), root);
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return path.join(directory, "auth.json");
}

async function writeAuthJson(file, fields) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    cookie: "", passToken: "", userId: "", cUserId: "", sid: "mimopc",
    clientVersion: "", source: "", ...fields,
  }));
}

test("Cookie sources take precedence and MITM lookup only runs when explicitly enabled", async t => {
  const file = await authJsonPath(t);
  const config = readConfig({ authFile: file });
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("Unexpected capture request"); };
  await assert.rejects(getAuthHeaders(config, { fetchImpl }), { status: 503 });
  assert.equal(calls, 0);
  await writeAuthJson(file, { cookie: "file=mock" });
  const captureConfig = { ...config, mitmUrl: "http://capture.example.test/flows" };
  assert.equal((await getAuthHeaders(captureConfig, { fetchImpl })).get("cookie"), "file=mock");
  assert.equal((await getAuthHeaders({ ...captureConfig, cookie: "environment=mock" }, { fetchImpl })).get("cookie"), "environment=mock");
  assert.equal(calls, 0);
  await fs.unlink(file);
  const target = new URL(config.upstreamUrl);
  const flow = (host, cookie, status = 200) => ({
    request: { host, path: target.pathname, headers: [["cookie", cookie], ["cookie", "second=mock"], ["host", host], ["content-length", "99"], [":authority", host]] },
    response: { status_code: status }
  });
  const headers = await getAuthHeaders({ ...captureConfig, mitmAuth: "Bearer capture-key" }, {
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, captureConfig.mitmUrl);
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer capture-key");
      return Response.json([
        flow(target.hostname, "old=mock"), flow(target.hostname, "latest=mock"),
        flow("unrelated.example.test", "wrong=mock"), flow(target.hostname, "failed=mock", 401)
      ]);
    }
  });
  assert.equal(calls, 1);
  assert.equal(headers.get("cookie"), "latest=mock; second=mock");
  assert.equal(headers.get("accept"), "text/event-stream");
  for (const key of ["host", "content-length", "authorization"]) assert.equal(headers.get(key), null);
  assert.equal([...headers.keys()].some(key => key.startsWith(":")), false);
});

test("An explicitly configured capture timeout fails cleanly and keeps the server healthy", async t => {
  const app = await withServer(t, {
    config: readConfig({ authFile: await authJsonPath(t), mitmUrl: "http://capture.example.test/flows", authTimeoutMs: 25 }),
    authProvider: getAuthHeaders,
    fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  });
  const result = await app.post();
  assert.equal(result.status, 503);
  assert.equal((await result.json()).error.type, "auth_error");
  assert.equal((await fetch(app.base + "/health")).status, 200);
});

test("Requests reread auth.json and use the verified MiMo gateway headers", async t => {
  const file = await authJsonPath(t);
  const cookies = [];
  const app = await withServer(t, {
    authProvider: () => getAuthHeaders(file),
    fetchImpl: async (url, {headers}) => {
      assert.equal(url, "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions");
      assert.equal(headers.get("content-type"), "application/json");
      assert.equal(headers.get("accept"), "text/event-stream");
      assert.equal(headers.get("accept-encoding"), "identity");
      assert.equal(headers.get("x-mimo-source"), "mimocode-cli-free");
      assert.equal(headers.get("x-client-version"), "26.914.142245");
      cookies.push(headers.get("cookie"));
      return response(complete);
    }
  });
  await writeAuthJson(file, { cookie: "first=mock" });
  assert.equal((await app.post()).status, 200);
  await writeAuthJson(file, { cookie: "second=mock" });
  assert.equal((await app.post()).status, 200);
  assert.deepEqual(cookies, ["first=mock", "second=mock"]);
});

test("Missing, empty, and unreadable auth packs fail before any network request", async t => {
  const file = await authJsonPath(t);
  let calls = 0;
  const app = await withServer(t, {
    authProvider: () => getAuthHeaders(file),
    fetchImpl: async () => {calls++; return response(complete);}
  });
  for (const emptyFile of [false, true]) {
    if (emptyFile) await writeAuthJson(file, { cookie: "  " });
    const result = await app.post();
    assert.equal(result.status, 503);
    const {error} = await result.json();
    assert.equal(error.type, "auth_error");
    assert.match(error.message, /auth-<userId>\.json|auth pack/);
    assert.equal((await fetch(app.base + "/health")).status, 200);
  }
  await fs.unlink(file);
  await fs.mkdir(file);
  const result = await app.post();
  assert.equal(result.status, 500);
  assert.equal((await result.json()).error.type, "auth_error");
  assert.equal(calls, 0);
});

test("Malformed credential headers do not expose their values in errors", () => {
  const secret = "mock-secret\nsecond-line";
  assert.throws(() => createAuthHeaders(secret), error => {
    assert.equal(error.type, "auth_error");
    assert.equal(error.message.includes("mock-secret"), false);
    return true;
  });
});

test("Captured MiMo stream accepts null tool_calls and reconstructs the actual answer", async t => {
  const trace = JSON.parse(await fs.readFile(new URL("./fixtures/client-baseline/trace.json", import.meta.url), "utf8"));
  const bytes = await fs.readFile(new URL("./fixtures/client-baseline/response.sse", import.meta.url));
  const chunks = [];
  let position = 0;
  for (const chunk of trace.response.chunks) { chunks.push(bytes.subarray(position, position + chunk.bytes)); position += chunk.bytes; }
  assert.equal(position, bytes.length);
  const app = await withServer(t, {fetchImpl: async () => new Response(new ReadableStream({
    start(controller) {for (const chunk of chunks) controller.enqueue(chunk); controller.close();}
  }), {headers: {"content-type": "text/event-stream"}})});
  const r = await app.post();
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.model, "mimo-x-pro-preview");
  assert.equal(data.choices[0].message.role, "assistant");
  assert.equal(data.choices[0].message.content, "OK");
  assert.equal(data.choices[0].finish_reason, "stop");
  assert.equal(typeof data.choices[0].message.reasoning_content, "string");
  assert.equal(data.choices[0].message.tool_calls, undefined);
  assert.deepEqual(data.usage, {completion_tokens: 14, prompt_tokens: 57, total_tokens: 71, completion_tokens_details: {reasoning_tokens: 0}, prompt_tokens_details: {cached_tokens: 0}});
  const streamed = await app.post({...message, stream: true});
  const text = await streamed.text();
  assert.equal(streamed.status, 200);
  assert.equal(text.includes('"error":'), false);
  assert.match(text, /"tool_calls":null/);
  assert.match(text, /"content":"OK"/);
});

test("Real MiMo tool-call fragments use null for unchanged IDs, names, and other fields", async t => {
  const raw = await fs.readFile(new URL("./fixtures/proxy-tools/response.sse", import.meta.url), "utf8");
  const chunks = raw.split("\n").filter(line => line.startsWith("data:") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(5)));
  const firstTool = chunks.flatMap(chunk => chunk.choices || []).flatMap(choice => choice.delta?.tool_calls || []).find(tool => tool.id);
  assert.ok(firstTool?.id);
  const app = await withServer(t, {fetchImpl: async () => response(raw)});
  const r = await app.post();
  assert.equal(r.status, 200);
  const data = await r.json();
  const choice = data.choices[0];
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.tool_calls[0].id, firstTool.id);
  assert.equal(choice.message.tool_calls[0].type, "function");
  assert.equal(choice.message.tool_calls[0].function.name, "echo");
  assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), {text: "OK"});
  assert.ok(data.usage.total_tokens > 0);
});
