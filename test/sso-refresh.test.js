import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clientSign, parseServiceLoginBody, composeServiceCookie, refreshServiceToken, hasPassCredentials
} from "../lib/sso-refresh.js";
import { createAutoAuthProvider } from "../lib/auto-auth.js";
import { createAuthRuntime, persistAuthUpdate, publicAuthStatus } from "../lib/auth-runtime.js";
import { createProxyServer, getAuthHeaders, readConfig } from "../mimo_server.js";
import { listenForFetch } from "../scripts/http_fixture.js";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function mockResponse({ status = 200, text = "", setCookie = [], contentType = "" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name || "").toLowerCase();
        if (key === "set-cookie") return setCookie.join("\n");
        if (key === "content-type") return contentType || null;
        return null;
      },
      getSetCookie() { return setCookie; },
    },
    async text() { return text; },
    async json() { return JSON.parse(text || "{}"); },
  };
}

test("clientSign and parseServiceLoginBody match Xiaomi SSO shape", () => {
  const nonce = "6119513412345678901";
  const ssecurity = "wbBiJMDYLDgshgJgRjVS0A==";
  const expected = encodeURIComponent(crypto.createHash("sha1").update("nonce=" + nonce + "&" + ssecurity).digest("base64"));
  assert.equal(clientSign(nonce, ssecurity), expected);
  const parsed = parseServiceLoginBody('&&&START&&&{"code":0,"result":"ok","description":"成功","location":"https:\\/\\/mimo-server-cn.xiaomimimo.com\\/api\\/sts?d=abc","nonce":' + nonce + ',"ssecurity":"' + ssecurity + '"}');
  assert.equal(parsed.code, 0);
  assert.equal(parsed.location, "https://mimo-server-cn.xiaomimimo.com/api/sts?d=abc");
  assert.equal(parsed.nonce, nonce);
  assert.equal(parsed.ssecurity, ssecurity);
});

test("composeServiceCookie keeps base64 values that end with =", () => {
  const composed = composeServiceCookie({
    serviceToken: "abc=",
    userId: "42",
    mimopc_slh: "",
    mimopc_ph: "ph==",
  }, { sid: "mimopc", fallbackUserId: "42" });
  assert.equal(composed.cookie, "serviceToken=abc=; userId=42; mimopc_slh=; mimopc_ph=ph==");
  assert.deepEqual(composed.cookieNames, ["serviceToken", "userId", "mimopc_slh", "mimopc_ph"]);
});

test("refreshServiceToken calls phase1/phase2 and returns chat cookie", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    if (String(url).includes("serviceLogin")) {
      const cookieHeader = init.headers?.Cookie || init.headers?.cookie || "";
      assert.match(String(cookieHeader), /passToken=P1/);
      return mockResponse({
        status: 200,
        text: "&&&START&&&" + JSON.stringify({
          code: 0,
          result: "ok",
          location: "https://mimo-server-cn.xiaomimimo.com/api/sts?d=wb",
          nonce: "1234567890123456789",
          ssecurity: "c2VjcmV0",
        }),
        setCookie: ["passToken=P1; Path=/; Max-Age=2592000"],
      });
    }
    assert.match(String(url), /clientSign=/);
    assert.equal(init.headers?.Cookie || init.headers?.cookie, undefined);
    return mockResponse({
      status: 200,
      text: "{}",
      setCookie: [
        "serviceToken=NEW_TOKEN=; Path=/; HttpOnly",
        "userId=99; Path=/",
        "mimopc_slh=; Path=/",
        "mimopc_ph=PHVAL==; Path=/",
      ],
    });
  };
  const result = await refreshServiceToken({
    passToken: "P1",
    userId: "99",
    cUserId: "C1",
    sid: "mimopc",
    fetchImpl,
  });
  assert.equal(result.cookie, "serviceToken=NEW_TOKEN=; userId=99; mimopc_slh=; mimopc_ph=PHVAL==");
  assert.deepEqual(result.cookieNames, ["serviceToken", "userId", "mimopc_slh", "mimopc_ph"]);
  assert.ok(result.passTokenExpiresAt);
  assert.equal(calls.length, 2);
});

test("refreshServiceToken captures ~30d passToken sliding expiry from Max-Age", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("serviceLogin")) {
      return mockResponse({
        status: 200,
        text: "&&&START&&&" + JSON.stringify({
          code: 0,
          location: "https://mimo-server-cn.xiaomimimo.com/api/sts?d=wb",
          nonce: "1234567890123456789",
          ssecurity: "c2VjcmV0",
          passToken: "P1",
          userId: 99,
        }),
        setCookie: [
          "passToken=P1; Path=/; Max-Age=2592000; HttpOnly",
          "userId=99; Path=/; Max-Age=2592000",
          "cUserId=C1; Path=/; Max-Age=2592000",
        ],
      });
    }
    return mockResponse({
      status: 200,
      text: "{}",
      setCookie: ["serviceToken=NEW; Path=/", "userId=99; Path=/", "mimopc_slh=; Path=/", "mimopc_ph=x; Path=/"],
    });
  };
  const result = await refreshServiceToken({
    passToken: "P1", userId: "99", cUserId: "C1", sid: "mimopc", fetchImpl,
  });
  assert.equal(result.passToken, "P1");
  assert.equal(result.passUserId, "99");
  const days = (Date.parse(result.passTokenExpiresAt) - Date.now()) / 86400000;
  assert.ok(days > 29 && days < 31, "expected ~30d Max-Age, got " + days);
});

test("auto provider renews passToken when expiry window is near even if chat cookie works", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-sso-slide-"));
  const authFile = path.join(directory, "auth.json");
  const soon = new Date(Date.now() + 2 * 86400000).toISOString();
  await fs.writeFile(authFile, JSON.stringify({
    cookie: "serviceToken=OLD; userId=1",
    passToken: "P", userId: "1", cUserId: "C", sid: "mimopc",
    passTokenExpiresAt: soon,
  }));
  const config = readConfig({ host: "127.0.0.1", authFile, cookie: "serviceToken=OLD; userId=1" }, directory);
  const authRuntime = createAuthRuntime({
    cookie: "serviceToken=OLD; userId=1",
    passToken: "P",
    passUserId: "1",
    passCUserId: "C",
    passTokenExpiresAt: soon,
  });
  let refreshCount = 0;
  const later = new Date(Date.now() + 30 * 86400000).toISOString();
  const auto = createAutoAuthProvider({
    config,
    authRuntime,
    logger: silentLogger,
    baseAuth: getAuthHeaders,
    refreshImpl: async () => {
      refreshCount += 1;
      return {
        cookie: "serviceToken=NEW; userId=1",
        cookieNames: ["serviceToken", "userId"],
        sid: "mimopc",
        passToken: "P",
        passUserId: "1",
        passTokenExpiresAt: later,
        passTokenRenewed: true,
      };
    },
    persist: async () => [],
  });
  const headers = await auto.auth(config);
  assert.equal(refreshCount, 1);
  assert.equal(headers.get("cookie"), "serviceToken=NEW; userId=1");
  assert.equal(authRuntime.passTokenExpiresAt, later);
  await fs.rm(directory, { recursive: true, force: true });
});

test("createAutoAuthProvider refreshes when serviceToken is missing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-sso-auto-"));
  const authFile = path.join(directory, "auth.json");
  await fs.writeFile(authFile, JSON.stringify({
    cookie: "userId=1",
    passToken: "P", userId: "1", cUserId: "C", sid: "mimopc",
  }));
  const config = readConfig({ host: "127.0.0.1", authFile, cookie: "userId=1" }, directory);
  const authRuntime = createAuthRuntime({ cookie: "userId=1", clientVersion: config.clientVersion });
  let refreshCount = 0;
  const auto = createAutoAuthProvider({
    config,
    authRuntime,
    logger: silentLogger,
    baseAuth: getAuthHeaders,
    refreshImpl: async () => {
      refreshCount += 1;
      return { cookie: "serviceToken=S; userId=1; mimopc_slh=x; mimopc_ph=y", cookieNames: ["serviceToken", "userId", "mimopc_slh", "mimopc_ph"], sid: "mimopc", passToken: "P", passUserId: "1" };
    },
    persist: async ({ config: cfg, authRuntime: runtime }) => {
      const { writeAuthFile } = await import("../lib/auth-runtime.js");
      await writeAuthFile(cfg.authFile, runtime);
      return [];
    },
  });
  const headers = await auto.auth(config);
  assert.equal(refreshCount, 1);
  assert.equal(headers.get("cookie"), "serviceToken=S; userId=1; mimopc_slh=x; mimopc_ph=y");
  const saved = JSON.parse(await fs.readFile(authFile, "utf8"));
  assert.match(saved.cookie, /serviceToken=S/);
  assert.equal(authRuntime.snapshot.hasPassToken, true);
  assert.equal(publicAuthStatus(config, authRuntime).hasServiceToken, true);
  await fs.rm(directory, { recursive: true, force: true });
});

test("createProxyServer retries once after upstream 401 via SSO refresh", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-sso-401-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const authFile = path.join(directory, "auth.json");
  await fs.writeFile(authFile, JSON.stringify({ cookie: "serviceToken=STALE; userId=1", passToken: "P", userId: "1" }));
  const config = readConfig({ host: "127.0.0.1", authFile, cookie: "serviceToken=STALE; userId=1" }, directory);
  const authRuntime = createAuthRuntime({ cookie: "serviceToken=STALE; userId=1", passToken: "P", passUserId: "1" });
  const upstreamCookies = [];
  let upstreamCalls = 0;
  const event = "data: " + JSON.stringify({
    id: "x", model: "m", created: 1,
    choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  }) + "\n\ndata: [DONE]\n\n";
  const server = createProxyServer({
    config,
    logger: silentLogger,
    authRuntime,
    refreshImpl: async () => ({
      cookie: "serviceToken=FRESH; userId=1",
      cookieNames: ["serviceToken", "userId"],
      sid: "mimopc",
    }),
    fetchImpl: async (url, init) => {
      const cookie = new Headers(init.headers).get("cookie");
      upstreamCookies.push(cookie);
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response(event, { headers: { "content-type": "text/event-stream" } });
    },
  });
  await listenForFetch(server);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const response = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(upstreamCalls, 2);
  assert.equal(upstreamCookies[0], "serviceToken=STALE; userId=1");
  assert.equal(upstreamCookies[1], "serviceToken=FRESH; userId=1");
  const body = await response.text();
  assert.match(body, /OK/);
});

test("public status hides secrets and reports passToken presence", () => {
  const runtime = createAuthRuntime({ passToken: "V1:secret", passUserId: "42", passCUserId: "cu", sid: "mimopc" });
  runtime.apply({ cookie: "serviceToken=T; userId=42" });
  const status = publicAuthStatus({ authFile: "auth.json" }, runtime);
  assert.equal(status.hasPassToken, true);
  assert.equal(status.hasServiceToken, true);
  assert.equal(JSON.stringify(status).includes("V1:secret"), false);
  assert.equal(hasPassCredentials({ passToken: "V1:x", userId: "1" }), true);
});

test("persistAuthUpdate writes account credentials only (identity stays in config.toml)", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-sso-persist-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const authFile = path.join(directory, "auth-1.json");
  const config = readConfig({
    host: "127.0.0.1",
    configRoot: directory,
    authFile,
    sid: "mimopc",
    clientVersion: "26.914.142245",
    source: "mimocode-cli-free",
  }, directory);
  const runtime = createAuthRuntime({
    cookie: "serviceToken=T; userId=1",
    passToken: "V1:keep-out",
    passUserId: "1",
    passCUserId: "c",
    sid: "mimopc",
    clientVersion: "26.914.142245",
    source: "mimocode-cli-free",
  });
  const warnings = await persistAuthUpdate({ config, authRuntime: runtime });
  assert.deepEqual(warnings, []);
  const saved = JSON.parse(await fs.readFile(config.authFile, "utf8"));
  assert.equal(saved.cookie, "serviceToken=T; userId=1");
  assert.equal(saved.passToken, "V1:keep-out");
  assert.equal(saved.userId, "1");
  assert.equal("sid" in saved, false);
  assert.equal("clientVersion" in saved, false);
  assert.equal("source" in saved, false);
});

test("config.toml identity wins over leftover fields in auth packs", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-auth-pack-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "config"), { recursive: true });
  await fs.writeFile(path.join(directory, "config", "config.toml"), [
    "host = \"127.0.0.1\"",
    "port = 0",
    "",
    "[auth]",
    "sid = \"from-toml\"",
    "clientVersion = \"toml-version\"",
    "source = \"toml-source\"",
    "autoRefresh = true",
  ].join("\n"));
  await fs.writeFile(path.join(directory, "config", "auth-1.json"), JSON.stringify({
    cookie: "serviceToken=Pack; userId=1",
    passToken: "V1:pack",
    userId: "1",
    cUserId: "c",
    sid: "pack-sid",
    clientVersion: "pack-version",
    source: "pack-source",
  }, null, 2));

  const { loadConfig } = await import("../lib/config.js");
  const { hydrateAuthRuntime, publicAuthStatus, discoverAuthAccounts } = await import("../lib/auth-runtime.js");
  const { getAuthHeaders } = await import("../mimo_server.js");

  const base = await loadConfig({}, directory);
  const accounts = await discoverAuthAccounts(base.configRoot);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].userId, "1");
  const config = { ...base, authFile: accounts[0].file, accountId: accounts[0].id, accountUserId: "1", port: 3000 };
  const authRuntime = await hydrateAuthRuntime(config);
  assert.equal(authRuntime.sid, "from-toml");
  assert.equal(authRuntime.clientVersion, "toml-version");
  assert.equal(authRuntime.source, "toml-source");

  const live = authRuntime.applyTo({ ...config, authRuntime });
  const headers = await getAuthHeaders(live);
  assert.equal(headers.get("x-client-version"), "toml-version");
  assert.equal(headers.get("x-mimo-source"), "toml-source");
  assert.match(headers.get("cookie"), /serviceToken=Pack/);

  const status = publicAuthStatus(config, authRuntime);
  assert.equal(status.identitySource, "config.toml");
  assert.equal(status.sid, "from-toml");
  assert.equal(status.clientVersion, "toml-version");
  assert.equal(status.source, "toml-source");
});
