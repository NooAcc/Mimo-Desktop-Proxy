import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import fs from "node:fs/promises";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { createHttp2Fetch } from "../lib/http2-fetch.js";
import { createProxyServer, readConfig } from "../mimo_server.js";
import { readSSE } from "../lib/sse.js";
import { listenForFetch } from "../scripts/http_fixture.js";

const cert = await fs.readFile(new URL("./fixtures/http2/localhost-cert.pem", import.meta.url));
const key = await fs.readFile(new URL("./fixtures/http2/localhost-key.pem", import.meta.url));
const signal = () => AbortSignal.timeout(4000);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const event = (text, finish = null) => "data: " + JSON.stringify({ model: "test-model",
  choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] }) + "\n\n";

async function upstream(t, handler, secure = true) {
  const server = secure ? http2.createSecureServer({ cert, key }) : http2.createServer();
  const sessions = new Set();
  let connections = 0;
  server.on("session", session => {
    connections++;
    sessions.add(session);
    session.on("error", () => {});
    session.once("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => { stream.on("error", () => {}); handler(stream, headers); });
  await listenForFetch(server);
  t.after(async () => {
    for (const session of sessions) session.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, url: (secure ? "https" : "http") + "://127.0.0.1:" + server.address().port,
    connections: () => connections };
}

function client(t) {
  const fetchH2 = createHttp2Fetch({ connectOptions: { ca: cert, servername: "localhost" } });
  t.after(() => fetchH2.close());
  return fetchH2;
}

test("TLS negotiates h2, emits the first bytes before completion, and reuses the connection", async t => {
  const gate = deferred(), seen = [];
  t.after(() => gate.resolve());
  const origin = await upstream(t, (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", part => { body += part; });
    stream.on("end", () => {
      seen.push({ headers, body });
      stream.respond({ ":status": 200, "content-type": "text/event-stream" });
      stream.write("data: first\n\n");
      gate.promise.then(() => { if (!stream.destroyed) stream.end("data: last\n\n"); });
    });
  });
  const fetchH2 = client(t);
  const response = await fetchH2(origin.url + "/chat?test=1", {
    method: "POST", headers: { cookie: "mock=test", connection: "x-drop", "x-drop": "ignored", "content-type": "application/json" },
    body: JSON.stringify({ text: "中文" }), signal: signal()
  });
  assert.equal(response.httpVersion, "h2");
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: first\n\n");
  assert.equal(seen[0].headers[":path"], "/chat?test=1");
  assert.equal(seen[0].headers.cookie, "mock=test");
  assert.equal(seen[0].headers["x-drop"], undefined);
  assert.equal(JSON.parse(seen[0].body).text, "中文");
  gate.resolve();
  let tail = "";
  for (;;) { const part = await reader.read(); if (part.done) break; tail += new TextDecoder().decode(part.value); }
  assert.equal(tail, "data: last\n\n");
  assert.match(await (await fetchH2(origin.url, { signal: signal() })).text(), /last/);
  assert.equal(origin.connections(), 1);
});

test("aborting one multiplexed stream preserves other requests and the shared h2 session", async t => {
  const slowClosed = deferred();
  const origin = await upstream(t, (stream, headers) => {
    stream.respond({ ":status": 200 });
    if (headers[":path"] === "/slow") {
      stream.once("close", () => slowClosed.resolve(stream.rstCode));
      stream.write("first");
    } else stream.end("fast");
  });
  const fetchH2 = client(t), controller = new AbortController();
  const slow = await fetchH2(origin.url + "/slow", { signal: controller.signal });
  const reader = slow.body.getReader();
  await reader.read();
  const fast = fetchH2(origin.url + "/fast", { signal: signal() });
  controller.abort();
  await assert.rejects(reader.read(), { name: "AbortError" });
  assert.equal(await (await fast).text(), "fast");
  assert.equal(await slowClosed.promise, http2.constants.NGHTTP2_CANCEL);
  assert.equal(await (await fetchH2(origin.url + "/fast", { signal: signal() })).text(), "fast");
  assert.equal(origin.connections(), 1);
});

test("body cancellation and abort before headers close only their upstream streams", async t => {
  const awaitingHeaders = deferred(), closed = deferred();
  const origin = await upstream(t, (stream, headers) => {
    if (headers[":path"] === "/headers") {
      awaitingHeaders.resolve();
      stream.once("close", () => closed.resolve());
      return;
    }
    stream.respond({ ":status": 200 });
    if (headers[":path"] === "/cancel") stream.write("first");
    else stream.end("OK");
  });
  const fetchH2 = client(t), controller = new AbortController();
  const pending = fetchH2(origin.url + "/headers", { signal: controller.signal });
  const rejection = assert.rejects(pending, { name: "AbortError" });
  await awaitingHeaders.promise;
  controller.abort();
  await rejection;
  await closed.promise;
  const response = await fetchH2(origin.url + "/cancel", { signal: signal() });
  await response.body.cancel();
  assert.equal(await (await fetchH2(origin.url, { signal: signal() })).text(), "OK");
  assert.equal(origin.connections(), 1);
});

test("HTTP status and compressed error bodies survive the transport", async t => {
  const origin = await upstream(t, stream => {
    stream.respond({ ":status": 429, "content-type": "application/json", "content-encoding": "gzip" });
    stream.end(gzipSync('{"error":{"message":"rate limited"}}'));
  });
  const response = await client(t)(origin.url, { signal: signal() });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.deepEqual(await response.json(), { error: { message: "rate limited" } });
});

test("GOAWAY retires a connection without replaying a POST", async t => {
  let requests = 0;
  const origin = await upstream(t, stream => {
    requests++;
    stream.respond({ ":status": 200 });
    stream.session.goaway();
    stream.end("OK");
  });
  const fetchH2 = client(t);
  for (let i = 0; i < 2; i++) assert.equal(await (await fetchH2(origin.url, { method: "POST", body: "test", signal: signal() })).text(), "OK");
  assert.equal(requests, 2);
  assert.equal(origin.connections(), 2);
});

test("an HTTP/1.1-only TLS server is rejected without sending an HTTP/1.1 request", async t => {
  let requests = 0;
  const server = https.createServer({ cert, key, ALPNProtocols: ["http/1.1"] }, (_request, response) => { requests++; response.end("wrong protocol"); });
  await listenForFetch(server);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(client(t)("https://127.0.0.1:" + server.address().port, { signal: signal() }), failure => {
    assert.ok(["HTTP2_REQUIRED", "ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL"].includes(failure.code), failure.message);
    return true;
  });
  assert.equal(requests, 0);
});

test("the default proxy streams Chat and Responses over h2 while the MITM credential lookup stays HTTP/1.1", async t => {
  let gate, upstreamRequests = 0, credentialRequests = 0;
  const origin = await upstream(t, (stream, headers) => {
    upstreamRequests++;
    assert.equal(headers.cookie, "mock=test");
    stream.respond({ ":status": 200, "content-type": "text/event-stream" });
    stream.write(event("first"));
    gate.promise.then(() => { if (!stream.destroyed) stream.end(event("last", "stop") + "data: [DONE]\n\n"); });
  }, false);
  const lookup = http.createServer((_request, response) => {
    credentialRequests++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([{ request: { host: "127.0.0.1", path: "/chat", headers: [["cookie", "mock=test"]] }, response: { status_code: 200 } }]));
  });
  await listenForFetch(lookup);
  t.after(async () => { lookup.closeAllConnections(); await new Promise(resolve => lookup.close(resolve)); });
  const proxy = createProxyServer({ logger: { info() {}, warn() {}, error() {} },
    config: readConfig({ authFile: "test/fixtures/absent-auth.json", upstreamUrl: origin.url + "/chat", mitmUrl: "http://127.0.0.1:" + lookup.address().port }) });
  await listenForFetch(proxy);
  t.after(async () => { gate?.resolve(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  for (const route of ["chat/completions", "responses"]) {
    gate = deferred();
    const response = await fetch("http://127.0.0.1:" + proxy.address().port + "/v1/" + route, {
      method: "POST", headers: { "content-type": "application/json" }, signal: signal(),
      body: JSON.stringify({ stream: true, ...(route === "responses" ? { input: "hello" } : { messages: [{ role: "user", content: "hello" }] }) })
    });
    assert.equal(response.status, 200);
    let first = false, finished = false;
    for await (const item of readSSE(response.body)) {
      if (item.data === "[DONE]") { finished = true; break; }
      const payload = JSON.parse(item.data);
      if ((payload.choices?.[0]?.delta.content ?? payload.delta) === "first") { first = true; gate.resolve(); }
      if (payload.type === "response.completed") finished = true;
    }
    assert.equal(first, true);
    assert.equal(finished, true);
  }
  assert.equal(upstreamRequests, 2);
  assert.equal(credentialRequests, 2);
  assert.equal(origin.connections(), 1);
});
