import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createLogger } from "../lib/logger.js";
import { createProxyServer, readConfig, ProxyError } from "../mimo_server.js";
import { listenForFetch } from "../scripts/http_fixture.js";

const chunk = (finish = null) => "data: " + JSON.stringify({
  choices: [{ index: 0, delta: { content: "private-answer" }, finish_reason: finish }]
}) + "\n\n";
const sse = body => new Response(body, { headers: { "content-type": "text/event-stream" } });
const terminal = entries => entries.filter(entry => ["request.completed", "request.failed", "request.aborted"].includes(entry.message));

async function app(t, { fetchImpl = async () => sse(chunk("stop") + "data: [DONE]\n\n"), authProvider, output, ...options } = {}) {
  const entries = [], events = new EventEmitter();
  const record = line => {
    const entry = JSON.parse(line);
    entries.push(entry);
    events.emit(entry.message, entry);
  };
  const logger = createLogger({ console: output || { log: record, error: record } });
  const server = createProxyServer({
    config: readConfig({}), ...options, fetchImpl, logger,
    authProvider: authProvider || (async () => new Headers({ cookie: "private-upstream-cookie" }))
  });
  await listenForFetch(server);
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await logger.close();
  });
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    entries, events, logger, server, base,
    post: (protocol = "chat", stream = false, init = {}) => fetch(base + (protocol === "chat" ? "/v1/chat/completions" : "/v1/responses") + "?api_key=private-query", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer private-key", "x-request-id": "private-client-id" },
      body: JSON.stringify({ model: "mimo-pro", stream, ...(protocol === "chat" ? { messages: [{ role: "user", content: "private-prompt" }] } : { input: "private-prompt" }) }),
      ...init
    })
  };
}

test("Chat and Responses logs correlate each JSON/SSE request without recording credentials or content", async t => {
  const instance = await app(t);
  const ids = new Set();
  for (const protocol of ["chat", "responses"]) for (const stream of [false, true]) {
    const response = await instance.post(protocol, stream);
    assert.equal(response.status, 200);
    await response.text();
    const requestId = response.headers.get("x-request-id");
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    assert.match(response.headers.get("access-control-expose-headers"), /X-Request-Id/);
    ids.add(requestId);
    const entries = instance.entries.filter(entry => entry.requestId === requestId);
    assert.deepEqual(entries.map(entry => entry.message), ["request.completed"]);
    const completed = terminal(entries)[0];
    assert.equal(completed.level, "info");
    assert.equal(completed.status, 200);
    assert.equal(completed.upstreamStatus, 200);
    assert.equal(completed.protocol, protocol);
    assert.equal(completed.model, "mimo-pro");
    assert.equal(completed.stream, stream);
    assert.ok(completed.durationMs >= 0);
  }
  assert.equal(ids.size, 4);
  assert.equal(JSON.stringify(instance.entries).includes("private-"), false);
});

test("Validation, authentication, routing, and upstream failures record their status and safe diagnostics", async t => {
  const cases = [
    { init: { body: "{private-malformed-json" }, status: 400, type: "invalid_request_error" },
    { fetchImpl: async () => new Response(null, { status: 304 }), status: 304, type: "upstream_error" },
    { fetchImpl: async () => Response.json({ error: { message: "private-upstream-error" } }, { status: 429 }), status: 429, type: "upstream_error" },
    { authProvider: async () => { throw new ProxyError(503, "auth_error", "private-auth-error"); }, status: 503, type: "auth_error" },
    { fetchImpl: async () => { throw new Error("private-network-error", { cause: { code: "ECONNRESET" } }); }, status: 502, type: "upstream_error", code: "ECONNRESET" }
  ];
  for (const scenario of cases) {
    const instance = await app(t, scenario);
    const response = await instance.post("chat", false, scenario.init);
    assert.equal(response.status, scenario.status);
    await response.text();
    const [entry] = terminal(instance.entries);
    assert.equal(terminal(instance.entries).length, 1);
    assert.equal(entry.message, "request.failed");
    assert.equal(entry.status, scenario.status);
    assert.equal(entry.errorStatus, scenario.status);
    assert.equal(entry.errorType, scenario.type);
    assert.equal(entry.level, scenario.status >= 500 ? "error" : "warn");
    if (scenario.code) assert.equal(entry.errorCode, scenario.code);
    assert.equal(JSON.stringify(instance.entries).includes("private-"), false);
  }
  const instance = await app(t);
  const response = await fetch(instance.base + "/not-found?token=private-query");
  assert.equal(response.status, 404);
  await response.text();
  assert.equal(terminal(instance.entries)[0].path, "/not-found");
  assert.equal(terminal(instance.entries)[0].level, "warn");
});

test("Mid-stream Chat and Responses failures are errors even though HTTP headers already say 200", async t => {
  for (const protocol of ["chat", "responses"]) {
    const instance = await app(t, { fetchImpl: async () => sse(chunk() + 'event: error\ndata: {"error":{"message":"private-stream-error"}}\n\n') });
    const response = await instance.post(protocol, true);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /private-stream-error/);
    const entries = terminal(instance.entries);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].message, "request.failed");
    assert.equal(entries[0].level, "error");
    assert.equal(entries[0].status, 200);
    assert.equal(entries[0].errorStatus, 502);
    assert.equal(entries[0].errorType, "upstream_error");
    assert.equal(JSON.stringify(instance.entries).includes("private-"), false);
  }
});

test("Timeout logs retain 504 before output and during an HTTP 200 stream", async t => {
  for (const started of [false, true]) {
    const instance = await app(t, { timeoutMs: 30, fetchImpl: async (url, { signal }) => {
      if (!started) return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return sse(new ReadableStream({ start(controller) {
        controller.enqueue(Buffer.from(chunk()));
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      } }));
    } });
    const response = await instance.post("responses", true);
    assert.equal(response.status, started ? 200 : 504);
    await response.text();
    const [entry] = terminal(instance.entries);
    assert.equal(entry.level, "error");
    assert.equal(entry.errorStatus, 504);
    assert.equal(entry.errorType, "upstream_timeout");
    assert.equal(entry.status, started ? 200 : 504);
  }
});

test("A disconnected Chat or Responses client produces one aborted record and cancels upstream", { timeout: 3000 }, async t => {
  for (const protocol of ["chat", "responses"]) {
    let abortSeen;
    const upstreamAborted = new Promise(resolve => { abortSeen = resolve; });
    const instance = await app(t, { fetchImpl: async (url, { signal }) => sse(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from(chunk()));
      signal.addEventListener("abort", () => { abortSeen(); controller.error(signal.reason); }, { once: true });
    } })) });
    const response = await instance.post(protocol, true);
    const reader = response.body.getReader();
    await reader.read();
    const aborted = once(instance.events, "request.aborted");
    await reader.cancel();
    const [entry] = await aborted;
    await upstreamAborted;
    assert.equal(entry.level, "warn");
    assert.equal(entry.errorStatus, 499);
    assert.equal(entry.errorType, "client_disconnected");
    assert.equal(entry.requestId, response.headers.get("x-request-id"));
    assert.equal(terminal(instance.entries).length, 1);
  }
});

test("Health, models, and preflight requests also receive terminal records", async t => {
  const instance = await app(t);
  for (const [endpoint, method, status] of [["/health", "GET", 200], ["/v1/models", "GET", 200], ["/v1/responses", "OPTIONS", 204]]) {
    const response = await fetch(instance.base + endpoint, { method });
    assert.equal(response.status, status);
    await response.text();
    const entries = terminal(instance.entries).filter(entry => entry.requestId === response.headers.get("x-request-id"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].method, method);
    assert.equal(entries[0].path, endpoint);
    assert.equal(entries[0].status, status);
  }
  assert.equal(instance.entries.some(entry => entry.message === "upstream.request"), false);
});

test("Server lifecycle logs startup, listen errors, and close", async t => {
  const instance = await app(t);
  const start = instance.entries.find(entry => entry.message === "server.listening");
  assert.equal(start.host, "127.0.0.1");
  assert.equal(start.port, instance.server.address().port);
  const second = createProxyServer({ logger: instance.logger });
  const error = once(second, "error");
  second.listen(start.port, start.host);
  assert.equal((await error)[0].code, "EADDRINUSE");
  assert.equal(instance.entries.find(entry => entry.message === "server.error").errorCode, "EADDRINUSE");
  await new Promise(resolve => instance.server.close(resolve));
  assert.equal(instance.entries.at(-1).message, "server.closed");
  instance.logger.info("still available");
  assert.equal(instance.entries.at(-1).message, "still available");
});

test("Console logging failures do not alter HTTP responses", async t => {
  const fail = () => { throw new Error("Closed console"); };
  const instance = await app(t, { output: { log: fail, error: fail } });
  const response = await instance.post();
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(instance.entries, []);
});

function cliEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(MIMO_|MITM_|LOG_|PROXY_API_KEY$|HOST$|PORT$|UPSTREAM_TIMEOUT_MS$|AUTH_TIMEOUT_MS$|MAX_BODY_BYTES$|MAX_RESPONSE_BYTES$|AUTH_UPDATE_PORT$)/i.test(key)) delete env[key];
  }
  return env;
}

test("CLI rejects an invalid config.toml port with a useful diagnostic and failure exit code", async t => {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, "mimo-cli-invalid-port-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const serviceDirectory = path.join(directory, "service");
  await fs.mkdir(serviceDirectory);
  for (const name of ["mimo_server.js", "package.json"]) {
    await fs.copyFile(new URL("../" + name, import.meta.url), path.join(serviceDirectory, name));
  }
  await fs.cp(new URL("../lib/", import.meta.url), path.join(serviceDirectory, "lib"), { recursive: true });
  await fs.writeFile(path.join(serviceDirectory, "config.toml"), "port = \"not-a-port\"\n");
  const child = spawn(process.execPath, [path.join(serviceDirectory, "mimo_server.js")], {
    cwd: directory,
    env: cliEnv(),
    windowsHide: true
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", text => { stderr += text; });
  const [code] = await once(child, "close");
  assert.equal(code, 1);
  assert.match(stderr, /server.start_failed/);
  assert.match(stderr, /port must be an integer/);
});

const cliFileConfig = `
host = "127.0.0.1"
port = 0
models = ["mimo-flash", "other-file-model"]
apiKey = "file-key"

[auth]
clientVersion = "file-version"
source = "file-source"

[upstream]
url = "https://example.test/from-file"

[logging]
file = "logs/cli.log"
`;
const cliScenarios = [
  { name: "uses LAN defaults and config/auth-*.json", file: "port = 0\n",
    authPack: { cookie: "project=mock", userId: "10001" },
    authName: "auth-10001.json",
    expected: { host: "0.0.0.0", cookie: "project=mock", model: "mimo-v2.6-pro",
      version: "26.914.142245", source: "mimocode-cli-free",
      upstream: "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions" } },
  { name: "automatically loads config.toml and flushes optional file logs", file: cliFileConfig,
    authPack: { cookie: "custom-file=mock", userId: "10002" },
    authName: "auth-10002.json",
    expected: { host: "127.0.0.1", cookie: "custom-file=mock", model: "mimo-flash", version: "file-version",
      source: "file-source", upstream: "https://example.test/from-file", apiKey: "file-key", logFile: "logs/cli.log" } },
];

for (const scenario of cliScenarios) test("CLI " + scenario.name + " from another working directory", { timeout: 5000 }, async t => {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, "mimo-cli-test-"));
  assert.equal(path.dirname(directory), root);
  let child, exited;
  t.after(async () => {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const serviceDirectory = path.join(directory, "service");
  await fs.mkdir(serviceDirectory);
  for (const name of ["mimo_server.js", "package.json"]) {
    await fs.copyFile(new URL("../" + name, import.meta.url), path.join(serviceDirectory, name));
  }
  await fs.cp(new URL("../lib/", import.meta.url), path.join(serviceDirectory, "lib"), { recursive: true });
  // This test isolates CLI configuration. Real TLS/h2 transport is covered in http2-fetch.test.js.
  await fs.writeFile(path.join(serviceDirectory, "lib", "http2-fetch.js"),
    'export const createHttp2Fetch = () => Object.assign((...args) => globalThis.fetch(...args), { close() {} });\n');
  await fs.mkdir(path.join(serviceDirectory, "config"));
  // Multi-account packs sit beside the resolved config.toml (config/ in these scenarios).
  await fs.writeFile(path.join(serviceDirectory, "config", "config.toml"), scenario.file || "port = 0\n");
  await fs.writeFile(path.join(serviceDirectory, "config", scenario.authName), JSON.stringify(scenario.authPack));
  await fs.writeFile(path.join(directory, "auth-99999.json"), JSON.stringify({ cookie: "working-directory=wrong", userId: "99999" }));
  await fs.writeFile(path.join(directory, "config.toml"), "port = 0\n");
  const entry = pathToFileURL(path.join(serviceDirectory, "mimo_server.js"));
  // IPC delivers shutdown on Windows and POSIX; the mocked upstream never uses the network.
  const launcher = [
    "process.argv[1] = " + JSON.stringify(fileURLToPath(entry)) + ";",
    "const expected = " + JSON.stringify(scenario.expected) + ";",
    'process.on("message", () => { process.disconnect(); process.emit("SIGTERM"); });',
    'globalThis.fetch = async (url, { headers, body }) => {',
    '  if (headers.get("cookie") !== expected.cookie) throw new Error("Incorrect Cookie source");',
    '  if (headers.get("x-client-version") !== expected.version || headers.get("x-mimo-source") !== expected.source) throw new Error("Incorrect upstream headers");',
    '  if (url !== expected.upstream || JSON.parse(body).model !== expected.model) throw new Error("Incorrect upstream or model");',
    '  return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });',
    '};',
    "await import(" + JSON.stringify(entry.href) + ");"
  ].join("\n");
  child = spawn(process.execPath, ["--input-type=module", "-e", launcher], {
    cwd: directory,
    env: cliEnv(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true
  });
  exited = once(child, "close");
  let pending = "", stderr = "";
  const records = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", text => { stderr += text; });
  const listening = new Promise(resolve => child.stdout.on("data", text => {
    pending += text;
    let boundary;
    while ((boundary = pending.indexOf("\n")) >= 0) {
      const record = JSON.parse(pending.slice(0, boundary));
      pending = pending.slice(boundary + 1);
      records.push(record);
      if (record.message === "server.listening") resolve(record);
    }
  }));
  const start = await Promise.race([
    listening, exited.then(([code]) => { throw new Error("CLI exited before listening: " + code + " " + stderr); })
  ]);
  assert.equal(start.host, scenario.expected.host);
  assert.equal(start.accountId, scenario.authPack.userId);
  const response = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1", port: start.port, path: "/v1/chat/completions", method: "POST",
      headers: { "content-type": "application/json", ...(scenario.expected.apiKey ? { authorization: "Bearer " + scenario.expected.apiKey } : {}) }
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", text => { body += text; });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, requestId: res.headers["x-request-id"], body }));
    });
    request.on("error", reject);
    request.end(JSON.stringify({ messages: [{ role: "user", content: "hello" }] }));
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).choices[0].message.content, "OK");
  child.send("stop");
  assert.equal((await exited)[0], 0, stderr);
  assert.deepEqual(records.map(record => record.message), ["multi_account.planned", "server.listening", "request.completed", "server.stopping", "server.closed"]);
  assert.equal(records[2].requestId, response.requestId);
  if (scenario.expected.logFile) {
    const saved = await fs.readFile(path.join(serviceDirectory, "config", scenario.expected.logFile), "utf8");
    assert.deepEqual(saved.trim().split("\n").map(JSON.parse), records);
    assert.equal(saved.includes(scenario.expected.cookie), false);
    assert.equal(saved.includes(scenario.expected.apiKey), false);
  }
});

test("CLI fails clearly when no auth-*.json packs exist", { timeout: 5000 }, async t => {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, "mimo-cli-empty-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const serviceDirectory = path.join(directory, "service");
  await fs.mkdir(path.join(serviceDirectory, "config"), { recursive: true });
  for (const name of ["mimo_server.js", "package.json"]) {
    await fs.copyFile(new URL("../" + name, import.meta.url), path.join(serviceDirectory, name));
  }
  await fs.cp(new URL("../lib/", import.meta.url), path.join(serviceDirectory, "lib"), { recursive: true });
  await fs.writeFile(path.join(serviceDirectory, "config", "config.toml"), "port = 0\n");
  await fs.writeFile(path.join(serviceDirectory, "config", "auth.json"), JSON.stringify({ cookie: "legacy=ignored" }));
  const entry = pathToFileURL(path.join(serviceDirectory, "mimo_server.js"));
  const launcher = [
    "process.argv[1] = " + JSON.stringify(fileURLToPath(entry)) + ";",
    "await import(" + JSON.stringify(entry.href) + ");"
  ].join("\n");
  let stderr = "";
  const child = spawn(process.execPath, ["--input-type=module", "-e", launcher], {
    cwd: directory,
    env: cliEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", text => { stderr += text; });
  const [code] = await once(child, "close");
  assert.equal(code, 1);
  assert.match(stderr, /No multi-account credentials/);
  assert.match(stderr, /auth-<userId>\.json/);
});
