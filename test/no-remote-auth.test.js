import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createProxyServer, createAuthRuntime, getAuthHeaders, readConfig
} from "../mimo_server.js";
import { listenForFetch } from "./../scripts/http_fixture.js";

const message = { messages: [{ role: "user", content: "你好" }] };
const complete = "data: " + JSON.stringify({
  id: "t", model: "m", created: 1,
  choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }]
}) + "\n\ndata: [DONE]\n\n";
const response = text => new Response(text, { headers: { "content-type": "text/event-stream" } });
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

test("remote credential update endpoints are gone; /auth/status remains read-only", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-no-remote-auth-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const authFile = path.join(directory, "auth.json");
  await fs.writeFile(authFile, JSON.stringify({ cookie: "serviceToken=local; userId=1" }));
  const config = readConfig({ host: "127.0.0.1", authFile }, directory);
  const authRuntime = createAuthRuntime({ cookie: "serviceToken=local; userId=1", clientVersion: config.clientVersion });
  const seen = [];
  const server = createProxyServer({
    config,
    authRuntime,
    logger: silentLogger,
    fetchImpl: async (url, init) => {
      seen.push(new Headers(init.headers).get("cookie"));
      return response(complete);
    },
    authProvider: getAuthHeaders,
  });
  await listenForFetch(server);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = "http://127.0.0.1:" + server.address().port;

  const status = await fetch(base + "/auth/status");
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.ok, true);
  assert.equal(statusBody.auth.hasServiceToken, true);
  assert.equal(statusBody.auth.authFile, authFile);
  assert.equal(JSON.stringify(statusBody).includes("serviceToken=local"), false);

  for (const path of ["/auth/update", "/auth/update/"]) {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie: "serviceToken=injected" }),
    });
    assert.equal(res.status, 404);
  }

  const chat = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
  });
  assert.equal(chat.status, 200);
  assert.equal(seen.at(-1), "serviceToken=local; userId=1");
  const saved = JSON.parse(await fs.readFile(authFile, "utf8"));
  assert.equal(saved.cookie, "serviceToken=local; userId=1");
});
