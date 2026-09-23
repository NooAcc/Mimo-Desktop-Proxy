/**
 * Live test: cookie missing / stale -> proxy auto SSO refresh + successful chat.
 * Usage: node scripts/test_auto_refresh.js
 * Does not require MiMo client CDP. Never prints passToken/cookie secrets.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { createProxyServer, loadConfig, hydrateAuthRuntime } from "../mimo_server.js";
import { readAuthFile } from "../lib/auth-runtime.js";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

function cookieNames(cookie) {
  return String(cookie || "")
    .split(";")
    .map(part => part.trim().split("=")[0])
    .filter(Boolean);
}

function redactAuth(auth) {
  if (!auth) return null;
  return {
    hasCookie: Boolean(auth.cookie),
    cookieNames: cookieNames(auth.cookie),
    hasServiceToken: cookieNames(auth.cookie).includes("serviceToken"),
    hasPassToken: Boolean(auth.passToken && (auth.userId || auth.passUserId)),
    sid: auth.sid || null,
    passTokenExpiresAt: auth.passTokenExpiresAt || null,
    cookieRefreshedAt: auth.cookieRefreshedAt || null,
    lastSsoAt: auth.lastSsoAt || null,
    updatedAt: auth.updatedAt || null,
    cookieLen: auth.cookie ? auth.cookie.length : 0,
  };
}

async function writeAuthFile(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

async function chatOnce(base, { model }) {
  const body = {
    model,
    messages: [{ role: "user", content: "请只回复 OK。" }],
    stream: false,
    max_tokens: 32,
    temperature: 0,
  };
  const started = Date.now();
  const res = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
  const content = data?.choices?.[0]?.message?.content;
  return {
    status: res.status,
    ms: Date.now() - started,
    content: typeof content === "string" ? content.trim() : content,
    model: data?.model,
    error: data?.error || (data?.raw ? { type: "invalid_json", message: data.raw } : undefined),
  };
}

async function authStatus(base) {
  const res = await fetch(base + "/auth/status");
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function runScenario({ name, authFile, mutate, configOverrides = {} }) {
  const before = await readAuthFile(authFile);
  const backup = JSON.parse(JSON.stringify(before || {}));
  const mut = mutate(structuredClone(backup));
  await writeAuthFile(authFile, mut);
  const fileAfterMutate = await readAuthFile(authFile);

  const config = await loadConfig({
    host: "127.0.0.1",
    port: 0,
    apiKey: "",
    autoRefresh: true,
    // Keep real upstream; only override host/port/apiKey.
    ...configOverrides,
  });
  const authRuntime = await hydrateAuthRuntime(config);
  const runtimeSnapBefore = authRuntime.snapshot;

  const server = createProxyServer({
    config,
    authRuntime,
    logger: {
      info(...args) { console.log("[info]", JSON.stringify(args[0])); },
      warn(...args) { console.log("[warn]", JSON.stringify(args[0])); },
      error(...args) { console.log("[error]", JSON.stringify(args[0])); },
      debug() {},
      close: async () => {},
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;

  let statusBefore, chat, statusAfter, fileAfter;
  try {
    statusBefore = await authStatus(base);
    chat = await chatOnce(base, { model: config.defaultModel });
    statusAfter = await authStatus(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
  fileAfter = await readAuthFile(authFile);

  const refreshed =
    Boolean(fileAfter?.cookie) &&
    cookieNames(fileAfter.cookie).includes("serviceToken") &&
    Boolean(fileAfter?.cookieRefreshedAt || fileAfter?.lastSsoAt) &&
    fileAfter.cookie !== mut.cookie;

  const statusAuthAfter = statusAfter?.body?.auth || statusAfter?.body || null;
  const ok =
    chat.status === 200 &&
    !chat.error &&
    String(chat.content || "").trim().toUpperCase().startsWith("OK") &&
    refreshed &&
    (statusAuthAfter?.hasServiceToken === true);

  const report = {
    scenario: name,
    ok,
    passCriteria: {
      http200: chat.status === 200,
      contentOk: String(chat.content || "").trim().toUpperCase().startsWith("OK"),
      cookieRefreshed: refreshed,
      statusHasServiceToken: (statusAfter?.body?.auth || statusAfter?.body)?.hasServiceToken === true,
    },
    authBefore: redactAuth(before),
    authMutated: redactAuth(fileAfterMutate || mut),
    runtimeBefore: {
      hasCookie: runtimeSnapBefore.hasCookie,
      hasServiceToken: runtimeSnapBefore.hasServiceToken,
      hasPassToken: runtimeSnapBefore.hasPassToken,
      passTokenDaysLeft: runtimeSnapBefore.passTokenDaysLeft,
    },
    statusBefore: statusBefore?.body,
    chat: {
      status: chat.status,
      ms: chat.ms,
      content: chat.content,
      model: chat.model,
      error: chat.error,
    },
    authAfter: redactAuth(fileAfter),
    statusAfter: statusAfter?.body,
  };
  console.log("\n=== " + name + " ===");
  console.log(JSON.stringify(report, null, 2));
  return report;
}

const authFile = path.join(PROJECT_DIR, "config", "auth.json");
const backupFile = authFile + ".bak-expiry-test";
const original = await fs.readFile(authFile, "utf8");
await fs.writeFile(backupFile, original, { mode: 0o600 });
console.log("Backup written:", backupFile);

const originalJson = JSON.parse(original);
const results = [];

try {
  // Scenario A: cookie cleared, passToken intact -> proactive SSO before request.
  results.push(await runScenario({
    name: "A_missing_cookie",
    authFile,
    mutate(auth) {
      return {
        ...auth,
        cookie: "",
        cookieRefreshedAt: null,
        lastSsoAt: null,
        updatedAt: new Date().toISOString(),
      };
    },
  }));

  // Scenario B: cookie looks present but serviceToken is garbage -> upstream 401 -> SSO retry.
  const stale = structuredClone(originalJson);
  stale.cookie = [
    "serviceToken=EXPIRED_TEST_TOKEN_NOT_VALID",
    "userId=" + (stale.userId || "2386469077"),
    'mimopc_slh=""',
    "mimopc_ph=deadbeefdeadbeef",
  ].join("; ");
  stale.cookieRefreshedAt = null;
  stale.lastSsoAt = null;
  stale.updatedAt = new Date().toISOString();
  results.push(await runScenario({
    name: "B_stale_cookie_upstream_401",
    authFile,
    mutate(auth) {
      return {
        ...auth,
        cookie: stale.cookie,
        cookieRefreshedAt: null,
        lastSsoAt: null,
        updatedAt: new Date().toISOString(),
      };
    },
  }));

  // Leave a known-good refreshed credential state (from last successful SSO).
  const finalAuth = await readAuthFile(authFile);
  if (!finalAuth?.cookie || !cookieNames(finalAuth.cookie).includes("serviceToken")) {
    await writeAuthFile(authFile, originalJson);
    console.log("Restored original auth.json because last scenario left no serviceToken.");
  } else {
    console.log("Keeping refreshed auth.json from successful SSO.");
  }
} catch (error) {
  console.error("Live test failed:", error);
  await writeAuthFile(authFile, originalJson).catch(() => {});
  process.exitCode = 1;
} finally {
  // Keep .bak for the user; they can delete it.
  const allOk = results.length === 2 && results.every(r => r.ok);
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify({
    allOk,
    scenarios: results.map(r => ({ name: r.scenario, ok: r.ok, chatStatus: r.chat?.status, content: r.chat?.content })),
  }, null, 2));
  if (!allOk) process.exitCode = 1;
}
