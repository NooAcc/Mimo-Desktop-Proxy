import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { connectInspector } from "./cdp.js";
import { createProxyServer, createAuthHeaders, loadConfig } from "../mimo_server.js";
import { readSSE } from "../lib/sse.js";
import { createHttp2Fetch } from "../lib/http2-fetch.js";

const config = await loadConfig();
const inspector = await connectInspector();
let credential;
try {
  credential = await inspector.evaluate('(async () => { const e = process.getBuiltinModule("module").createRequire(process.execPath)("electron"); const cookies = await e.session.fromPartition("persist:xiaomi-account").cookies.get({url:' + JSON.stringify(config.upstreamUrl) + '}); return {cookie:cookies.map(c=>c.name+"="+c.value).join("; "),values:cookies.map(c=>c.value)}; })()');
} finally {inspector.close();}
if (!credential.cookie) throw new Error("The MiMo session has no Cookie for the target service");

const secretValues = credential.values.filter(value => value.length >= 8);
const redact = text => {for (const value of secretValues) text = text.split(value).join("[redacted]"); return text;};
const safeHeaders = headers => Object.fromEntries([...new Headers(headers).entries()].map(([key, value]) => [
  key, ["content-type", "accept", "accept-encoding", "x-client-version", "x-mimo-source", "cache-control"].includes(key) ? value : "[redacted]"
]));
let activeCase, captureTask, upstreamTrace;
const upstreamFetch = createHttp2Fetch();
const server = createProxyServer({
  config: { ...config, apiKey: "" },
  timeoutMs: 60000,
  authProvider: async () => createAuthHeaders(credential.cookie, config),
  logger: { info() {}, warn() {}, error() {} },
  fetchImpl: async (url, init) => {
  const start = Date.now();
  const response = await upstreamFetch(url, init);
  upstreamTrace = {capturedAt: new Date().toISOString(), source: "Live HTTP/2 from the proxy; credentials supplied in memory from the user's MiMo session",
    request: {url, method: init.method, headers: safeHeaders(init.headers), body: JSON.parse(init.body)},
    response: {status: response.status, httpVersion: response.httpVersion, headers: safeHeaders(response.headers), chunks: []}};
  const trace = upstreamTrace;
  const copy = response.clone();
  captureTask = (async () => {
    const reader = copy.body.getReader(), decoder = new TextDecoder();
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {text += decoder.decode(); break;}
      trace.response.chunks.push({elapsedMs: Date.now() - start, bytes: chunk.value.byteLength});
      text += decoder.decode(chunk.value, {stream: true});
    }
    const directory = path.resolve("captures", activeCase);
    await fs.mkdir(directory, {recursive: true});
    await fs.writeFile(path.join(directory, "trace.json"), JSON.stringify(trace, null, 2) + "\n");
    await fs.writeFile(path.join(directory, "response.sse"), redact(text));
  })();
  // Install a rejection handler immediately; the task is awaited below.
  captureTask.catch(() => {});
  return response;
}});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = "http://127.0.0.1:" + server.address().port;
const cases = [
  {name: "proxy-nonstream", body: {messages: [{role: "user", content: "请只回复 OK。"}], stream: false, reasoning_effort: "low", temperature: 0, max_tokens: 64}},
  {name: "proxy-stream", body: {model: "mimo-pro", messages: [{role: "user", content: "请只回复 OK。"}], stream: true, reasoning_effort: "low", stream_options: {include_usage: true}, max_tokens: 64, meta: {session_id: "proxy-check-" + randomUUID()}}},
  {name: "proxy-tools", body: {model: "mimo-pro", messages: [{role: "user", content: 'Call echo with text "OK". Do not answer directly.'}], stream: false, reasoning_effort: "low", max_tokens: 128,
    tools: [{type: "function", function: {name: "echo", description: "Echo test text", parameters: {type: "object", properties: {text: {type: "string"}}, required: ["text"], additionalProperties: false}}}],
    tool_choice: {type: "function", function: {name: "echo"}}}}
];
try {
  for (const scenario of cases.filter(item => !process.argv[2] || item.name === process.argv[2])) {
    activeCase = scenario.name + (process.argv[3] || "");
    captureTask = null; upstreamTrace = null;
    const response = await fetch(base + "/v1/chat/completions", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(scenario.body)});
    const text = await response.text();
    if (captureTask) await captureTask;
    const directory = path.resolve("captures", activeCase);
    await fs.mkdir(directory, {recursive: true});
    await fs.writeFile(path.join(directory, scenario.body.stream ? "proxy-response.sse" : "proxy-response.json"), redact(text));
    const parsed = [];
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      for await (const event of readSSE(new Response(text).body)) if (event.data !== "[DONE]") parsed.push(JSON.parse(event.data));
    } else {try {parsed.push(JSON.parse(text));} catch {}}
    const error = parsed.find(item => item.error)?.error;
    const last = parsed.findLast(item => item.usage) || parsed.at(-1);
    const choices = parsed.flatMap(item => item.choices || []);
    const content = scenario.body.stream ? choices.map(choice => choice.delta?.content || "").join("") : choices[0]?.message?.content;
    const toolCalls = choices[0]?.message?.tool_calls;
    const passed = response.status === 200 && !error && (scenario.name === "proxy-tools" ? toolCalls?.[0]?.function?.name === "echo" : String(content).trim() === "OK");
    console.log(JSON.stringify({case: scenario.name, passed, status: response.status, upstreamStatus: upstreamTrace?.response.status, model: last?.model, content, finishReasons: choices.map(choice => choice.finish_reason).filter(Boolean), usage: last?.usage, toolCalls, error: error ? redact(JSON.stringify(error)) : undefined}));
    if (!passed) process.exitCode = 1;
  }
} finally {
  upstreamFetch.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
