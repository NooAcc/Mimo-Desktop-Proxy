import path from "node:path";
import { connectInspector } from "./cdp.js";
import { readSSE } from "../lib/sse.js";
import { loadConfig, createAuthHeaders } from "../mimo_server.js";
import { createHttp2Fetch } from "../lib/http2-fetch.js";
import { createAuthRuntime, readAuthFile, writeAuthFile, authFileNameForUserId } from "../lib/auth-runtime.js";

const config = await loadConfig();
const target = config.upstreamUrl;
const configRoot = config.configRoot || path.dirname(config.configTomlFile || ".");
const verifyOnly = process.argv.includes("--verify-only");
let output = null;
let session;
if (verifyOnly) {
  const { discoverAuthAccounts } = await import("../lib/auth-runtime.js");
  const accounts = await discoverAuthAccounts(configRoot);
  if (!accounts.length) throw new Error("No auth-<userId>.json found in " + configRoot);
  output = accounts[0].file;
  const stored = await readAuthFile(output);
  const cookie = (stored?.cookie || "").trim();
  session = { cookie, names: cookie.split(";").map(part => part.trim().split("=")[0]).filter(Boolean) };
} else {
  const inspector = await connectInspector();
  try {
    session = await inspector.evaluate('(async () => { const e = process.getBuiltinModule("module").createRequire(process.execPath)("electron"); const s = e.session.fromPartition("persist:xiaomi-account"); const cookies = await s.cookies.get({url:' + JSON.stringify(target) + '}); cookies.sort((a,b)=>(b.path?.length||0)-(a.path?.length||0)); const account = await s.cookies.get({url:"https://account.xiaomi.com"}); const amap = Object.fromEntries(account.map(c => [c.name, c])); const pass = amap.passToken; return {cookie:cookies.map(c=>c.name+"="+c.value).join("; "),names:cookies.map(c=>c.name), passToken: pass?.value || "", userId: amap.userId?.value || "", cUserId: amap.cUserId?.value || "", passTokenExpiresAt: pass?.expirationDate ? new Date(pass.expirationDate*1000).toISOString() : null, clientVersion: e.app?.getVersion?.() || null}; })()');
  } finally {
    inspector.close();
  }
}
if (!session.cookie || !session.names.includes("serviceToken")) {
  throw new Error("No MiMo login Cookie was found; sign in to the desktop client first");
}
if (!verifyOnly) {
  output = path.join(configRoot, authFileNameForUserId(session.userId));
  const existing = await readAuthFile(output);
  const runtime = createAuthRuntime({
    ...(existing || {}),
    clientVersion: config.clientVersion,
    source: config.source,
    sid: config.sid,
  });
  runtime.apply({
    cookie: session.cookie,
    ...(session.passToken ? { passToken: session.passToken } : {}),
    ...(session.userId ? { passUserId: session.userId } : {}),
    ...(session.cUserId ? { passCUserId: session.cUserId } : {}),
    ...(session.passTokenExpiresAt ? { passTokenExpiresAt: session.passTokenExpiresAt } : {}),
  });
  await writeAuthFile(output, runtime);
  if (session.clientVersion && session.clientVersion !== config.clientVersion) {
    const { persistSharedIdentity } = await import("../lib/config.js");
    await persistSharedIdentity(config, {
      clientVersion: session.clientVersion,
      sid: config.sid,
      source: config.source,
    });
  }
}

let validation;
const upstreamFetch = createHttp2Fetch();
try {
  const headers = createAuthHeaders(session.cookie, config);
  const response = await upstreamFetch(target, {
    method: "POST", headers,
    body: JSON.stringify({model: "mimo-pro", messages: [{role: "user", content: "请只回复 OK。"}],
      stream: true, reasoning_effort: "low", max_tokens: 32}),
    signal: AbortSignal.timeout(30000)
  });
  let choiceSeen = false, errorSeen = false, content = "", finishReason = null;
  if (response.ok && response.headers.get("content-type")?.includes("text/event-stream")) {
    for await (const event of readSSE(response.body)) {
      if (event.data.trim() === "[DONE]") break;
      const data = JSON.parse(event.data);
      if (event.event === "error" || data.error) errorSeen = true;
      for (const choice of data.choices || []) {
        choiceSeen = true;
        content += choice.delta?.content || "";
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  }
  validation = {status: response.status, authenticated: response.ok && choiceSeen && !errorSeen, content, finishReason};
} catch (error) {
  validation = {authenticated: false, error: error.cause?.code || error.name};
} finally {
  upstreamFetch.close();
}
console.log(JSON.stringify({
  file: output,
  saved: !verifyOnly,
  cookieNames: session.names,
  hasPassToken: Boolean(session.passToken),
  clientVersion: config.clientVersion,
  validation,
}));
if (!validation.authenticated) process.exitCode = 1;
