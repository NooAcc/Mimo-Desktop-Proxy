/**
 * Export Xiaomi account credentials from a logged-in MiMo client
 * (--inspect=127.0.0.1:9222) into config/auth-<userId>.json.
 *
 * Usage:
 *   node scripts/export_pass_token.js
 *   node scripts/export_pass_token.js --save
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { connectInspector } from "./cdp.js";
import { loadConfig } from "../mimo_server.js";
import {
  authFileNameForUserId,
  createAuthRuntime,
  readAuthFile,
  writeAuthFile,
} from "../lib/auth-runtime.js";

export { authFileNameForUserId };

function parseArgs(argv) {
  const args = { save: false, inspectPort: 9222, help: false };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--save") args.save = true;
    else if (key === "--inspect-port") args.inspectPort = Number(argv[++i]) || 9222;
    else if (key === "-h" || key === "--help") args.help = true;
  }
  return args;
}

const safe = (v, n = 12) => {
  if (!v) return null;
  const s = String(v);
  return s.slice(0, n) + "…" + s.length;
};

async function extract(inspectPort, upstreamUrl) {
  const inspector = await connectInspector(inspectPort);
  try {
    return await inspector.evaluate(`(async () => {
      const e = process.getBuiltinModule("module").createRequire(process.execPath)("electron");
      const s = e.session.fromPartition("persist:xiaomi-account");
      const accountList = await s.cookies.get({ url: "https://account.xiaomi.com" });
      const chat = await s.cookies.get({ url: ${JSON.stringify(upstreamUrl)} });
      const map = Object.fromEntries(accountList.map(c => [c.name, c]));
      chat.sort((a,b)=>(b.path?.length||0)-(a.path?.length||0));
      const pass = map.passToken;
      return {
        passToken: pass?.value || "",
        userId: map.userId?.value || "",
        cUserId: map.cUserId?.value || "",
        deviceId: map.deviceId?.value || "",
        passInfo: map.passInfo?.value || "",
        passTokenExpiresAt: pass?.expirationDate
          ? new Date(pass.expirationDate * 1000).toISOString()
          : null,
        chatCookie: chat.map(c => c.name + "=" + c.value).join("; "),
        chatNames: chat.map(c => c.name),
        appVersion: e.app?.getVersion?.() || null,
      };
    })()`);
  } finally {
    inspector.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Export MiMo credentials from a logged-in client via CDP into config/auth-<userId>.json.

  node scripts/export_pass_token.js [--save] [--inspect-port N]
`);
    return;
  }
  const config = await loadConfig();
  const extracted = await extract(args.inspectPort, config.upstreamUrl);
  if (!extracted.passToken || !extracted.userId) {
    console.log(JSON.stringify({ ok: false, error: "No passToken/userId in client cookie jar; sign in to MiMo first" }, null, 2));
    process.exitCode = 1;
    return;
  }

  const payload = {
    cookie: extracted.chatCookie || "",
    passToken: extracted.passToken,
    userId: extracted.userId,
    cUserId: extracted.cUserId,
    passTokenExpiresAt: extracted.passTokenExpiresAt || null,
  };

  const configRoot = config.configRoot || path.dirname(config.configTomlFile || ".");
  let userAuthFile = null;
  try {
    userAuthFile = path.join(configRoot, authFileNameForUserId(payload.userId));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
    return;
  }
  const report = {
    ok: true,
    extracted: {
      passToken: safe(extracted.passToken),
      userId: extracted.userId,
      cUserId: safe(extracted.cUserId, 8),
      passTokenExpiresAt: extracted.passTokenExpiresAt || null,
      chatNames: extracted.chatNames,
      cookie: extracted.chatCookie ? "[saved " + extracted.chatCookie.length + " chars]" : null,
      appVersion: extracted.appVersion || null,
    },
    identity: {
      source: "config.toml",
      sid: config.sid,
      clientVersion: config.clientVersion,
      sourceName: config.source,
    },
    authFile: userAuthFile,
    savedFiles: [],
    identityUpdated: null,
    saved: false,
  };

  // Shared identity may need a bump when the desktop client version changed.
  if (extracted.appVersion && extracted.appVersion !== config.clientVersion) {
    const { persistSharedIdentity } = await import("../lib/config.js");
    const identityResult = await persistSharedIdentity(config, {
      clientVersion: extracted.appVersion,
      sid: config.sid,
      source: config.source,
    });
    report.identityUpdated = {
      clientVersion: extracted.appVersion,
      previous: config.clientVersion,
      warnings: identityResult.warnings,
    };
  }

  if (args.save) {
    const existing = await readAuthFile(userAuthFile);
    const runtime = createAuthRuntime({
      ...(existing || {}),
      clientVersion: config.clientVersion,
      source: config.source,
      sid: config.sid,
    });
    runtime.apply({
      cookie: payload.cookie,
      passToken: payload.passToken,
      passUserId: payload.userId,
      passCUserId: payload.cUserId,
      passTokenExpiresAt: payload.passTokenExpiresAt,
    });
    await writeAuthFile(userAuthFile, runtime);
    report.savedFiles.push(userAuthFile);
    report.saved = true;
  }

  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }));
    process.exitCode = 1;
  });
}
