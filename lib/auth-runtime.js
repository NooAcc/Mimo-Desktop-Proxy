import fs from "node:fs/promises";
import path from "node:path";

export function parseCookieNames(cookie) {
  return String(cookie || "")
    .split(";")
    .map(part => part.trim().split("=")[0])
    .filter(Boolean);
}

/** Multi-account packs are only named auth-<userId>.json (no legacy auth.json). */
export const AUTH_ACCOUNT_FILENAME_RE = /^auth-.+\.json$/i;

/** Per-account auth pack name: auth-<userId>.json. */
export function authFileNameForUserId(userId) {
  const id = String(userId || "").trim().replace(/[^\w.-]+/g, "_");
  if (!id) throw new Error("userId is required to name an auth pack (auth-<userId>.json)");
  return `auth-${id}.json`;
}

function accountIdFromFileName(fileName) {
  const match = /^auth-(.+)\.json$/i.exec(String(fileName || ""));
  return match ? match[1] : null;
}

/**
 * Discover multi-account credential packs in configRoot.
 * Only auth-*.json files are recognized; returns [] when the directory is missing.
 * Order is stable: userId (or filename) ascending.
 */
export async function discoverAuthAccounts(configRoot) {
  if (!configRoot) return [];
  let entries;
  try {
    entries = await fs.readdir(configRoot);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const accounts = [];
  for (const fileName of entries) {
    if (!AUTH_ACCOUNT_FILENAME_RE.test(fileName)) continue;
    if (fileName.toLowerCase().includes(".bak")) continue;
    const file = path.join(configRoot, fileName);
    let data = null;
    try {
      data = await readAuthFile(file);
    } catch {
      data = null;
    }
    const fromFile = String(data?.passUserId || data?.userId || "").trim();
    const fromName = accountIdFromFileName(fileName) || "";
    const userId = fromFile || fromName;
    accounts.push({
      id: userId || fileName,
      userId: userId || null,
      file,
      fileName,
      hasCookie: Boolean(data?.cookie),
      hasPassToken: Boolean(data?.passToken && (data?.passUserId || data?.userId)),
      passTokenExpiresAt: data?.passTokenExpiresAt || null,
    });
  }
  accounts.sort((a, b) => {
    const left = a.userId || a.fileName;
    const right = b.userId || b.fileName;
    return left.localeCompare(right, "en") || a.fileName.localeCompare(b.fileName, "en");
  });
  return accounts;
}

/**
 * Assign listen ports: basePort, basePort+1, ... in account order.
 * basePort 0 means OS-assigned ephemeral port for every account.
 */
export function planAccountPorts(accounts, basePort = 3000) {
  const base = Number(basePort);
  if (!Number.isInteger(base) || base < 0 || base > 65535) {
    throw new Error("port must be an integer between 0 and 65535");
  }
  return accounts.map((account, index) => {
    const port = base === 0 ? 0 : base + index;
    if (port > 65535) {
      throw new Error(`Port ${port} for account ${account.id} exceeds 65535; lower the base port or reduce accounts`);
    }
    return { ...account, port };
  });
}

export function createAuthRuntime(initial = {}) {
  let cookie = typeof initial.cookie === "string" ? initial.cookie.trim() : "";
  let clientVersion = typeof initial.clientVersion === "string" ? initial.clientVersion.trim() : "";
  let source = typeof initial.source === "string" ? initial.source.trim() : "";
  let passToken = typeof initial.passToken === "string" ? initial.passToken.trim() : "";
  let passUserId = typeof initial.passUserId === "string" ? initial.passUserId.trim() : "";
  let passCUserId = typeof initial.passCUserId === "string" ? initial.passCUserId.trim() : "";
  let sid = typeof initial.sid === "string" ? initial.sid.trim() : "";
  let passTokenExpiresAt = initial.passTokenExpiresAt || null;
  let updatedAt = initial.updatedAt || null;
  let cookieRefreshedAt = initial.cookieRefreshedAt || null;
  let lastSsoAt = initial.lastSsoAt || null;
  let clientVersionUpdatedAt = initial.clientVersionUpdatedAt || null;
  let lastClientVersionCheckAt = initial.lastClientVersionCheckAt || null;
  let clientVersionSource = initial.clientVersionSource || null;

  const snapshot = () => {
    const cookieNames = parseCookieNames(cookie);
    const expiresMs = passTokenExpiresAt ? Date.parse(passTokenExpiresAt) : NaN;
    return {
      hasCookie: Boolean(cookie),
      cookieNames,
      hasServiceToken: cookieNames.includes("serviceToken"),
      clientVersion,
      source,
      updatedAt,
      cookieRefreshedAt,
      lastSsoAt,
      clientVersionUpdatedAt,
      lastClientVersionCheckAt,
      clientVersionSource,
      hasPassToken: Boolean(passToken && passUserId),
      passUserId: passUserId || null,
      sid: sid || null,
      passTokenExpiresAt: passTokenExpiresAt || null,
      passTokenDaysLeft: Number.isFinite(expiresMs)
        ? Math.round((expiresMs - Date.now()) / 86400000 * 10) / 10
        : null,
    };
  };

  return {
    get cookie() { return cookie; },
    get clientVersion() { return clientVersion; },
    get source() { return source; },
    get passToken() { return passToken; },
    get passUserId() { return passUserId; },
    get passCUserId() { return passCUserId; },
    get sid() { return sid; },
    get passTokenExpiresAt() { return passTokenExpiresAt; },
    get updatedAt() { return updatedAt; },
    get cookieRefreshedAt() { return cookieRefreshedAt; },
    get lastSsoAt() { return lastSsoAt; },
    get clientVersionUpdatedAt() { return clientVersionUpdatedAt; },
    get lastClientVersionCheckAt() { return lastClientVersionCheckAt; },
    get clientVersionSource() { return clientVersionSource; },
    get snapshot() { return snapshot(); },
    toJSON() {
      return {
        cookie,
        clientVersion,
        source,
        passToken,
        userId: passUserId,
        cUserId: passCUserId,
        sid,
        passTokenExpiresAt,
        cookieRefreshedAt,
        lastSsoAt,
        clientVersionUpdatedAt,
        lastClientVersionCheckAt,
        clientVersionSource,
        updatedAt,
      };
    },
    apply(update) {
      const changed = [];
      if (update.cookie !== undefined) {
        cookie = update.cookie;
        changed.push("cookie");
      }
      if (update.clientVersion !== undefined) {
        clientVersion = update.clientVersion;
        changed.push("clientVersion");
      }
      if (update.source !== undefined) {
        source = update.source;
        changed.push("source");
      }
      if (update.passToken !== undefined) {
        passToken = update.passToken;
        changed.push("passToken");
      }
      if (update.passUserId !== undefined) {
        passUserId = update.passUserId;
        changed.push("passUserId");
      }
      if (update.passCUserId !== undefined) {
        passCUserId = update.passCUserId;
        changed.push("passCUserId");
      }
      if (update.sid !== undefined) {
        sid = update.sid;
        changed.push("sid");
      }
      if (update.passTokenExpiresAt !== undefined) {
        passTokenExpiresAt = update.passTokenExpiresAt || null;
        changed.push("passTokenExpiresAt");
      }
      if (update.cookieRefreshedAt !== undefined) {
        cookieRefreshedAt = update.cookieRefreshedAt;
        changed.push("cookieRefreshedAt");
      }
      if (update.lastSsoAt !== undefined) {
        lastSsoAt = update.lastSsoAt;
        changed.push("lastSsoAt");
      }
      if (update.clientVersionUpdatedAt !== undefined) {
        clientVersionUpdatedAt = update.clientVersionUpdatedAt || null;
        changed.push("clientVersionUpdatedAt");
      }
      if (update.lastClientVersionCheckAt !== undefined) {
        lastClientVersionCheckAt = update.lastClientVersionCheckAt || null;
        changed.push("lastClientVersionCheckAt");
      }
      if (update.clientVersionSource !== undefined) {
        clientVersionSource = update.clientVersionSource || null;
        changed.push("clientVersionSource");
      }
      if (update.updatedAt !== undefined) {
        updatedAt = update.updatedAt;
      } else if (changed.length) {
        updatedAt = new Date().toISOString();
      }
      return { changed, snapshot: snapshot() };
    },
    applyTo(baseConfig = {}) {
      return {
        ...baseConfig,
        cookie: cookie || baseConfig.cookie || "",
        clientVersion: clientVersion || baseConfig.clientVersion,
        source: source || baseConfig.source,
        passToken: passToken || baseConfig.passToken || "",
        passUserId: passUserId || baseConfig.passUserId || "",
        passCUserId: passCUserId || baseConfig.passCUserId || "",
        sid: sid || baseConfig.sid || "",
        cookieRefreshedAt: cookieRefreshedAt || baseConfig.cookieRefreshedAt || null,
        passTokenExpiresAt: passTokenExpiresAt || baseConfig.passTokenExpiresAt || null,
        lastSsoAt: lastSsoAt || baseConfig.lastSsoAt || null,
        clientVersionUpdatedAt: clientVersionUpdatedAt || baseConfig.clientVersionUpdatedAt || null,
        lastClientVersionCheckAt: lastClientVersionCheckAt || baseConfig.lastClientVersionCheckAt || null,
        clientVersionSource: clientVersionSource || baseConfig.clientVersionSource || null,
      };
    },
  };
}

/** Read one per-account credential pack (auth-<userId>.json). */
export async function readAuthFile(file) {
  if (!file) return null;
  try {
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return {
      cookie: typeof data.cookie === "string" ? data.cookie.trim() : "",
      clientVersion: typeof data.clientVersion === "string" ? data.clientVersion.trim() : "",
      source: typeof data.source === "string" ? data.source.trim() : "",
      passToken: typeof data.passToken === "string" ? data.passToken.trim() : "",
      passUserId: String(data.userId || data.passUserId || data.userid || "").trim(),
      passCUserId: String(data.cUserId || data.passCUserId || data.cuserid || "").trim(),
      sid: typeof data.sid === "string" ? data.sid.trim() : "",
      passTokenExpiresAt: data.passTokenExpiresAt || data.expiresAt || null,
      cookieRefreshedAt: data.cookieRefreshedAt || null,
      lastSsoAt: data.lastSsoAt || null,
      clientVersionUpdatedAt: data.clientVersionUpdatedAt || null,
      lastClientVersionCheckAt: data.lastClientVersionCheckAt || null,
      clientVersionSource: data.clientVersionSource || null,
      updatedAt: data.updatedAt || null,
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    const { ProxyError } = await import("./errors.js");
    throw new ProxyError(500, "auth_error", "Cannot read auth pack " + file + ": " + (error.code || error.message));
  }
}

export function runtimeToAuthJson(authRuntime) {
  const snap = authRuntime.snapshot || {};
  // Account credentials only. sid/clientVersion/source live in config.toml [auth].
  return {
    cookie: authRuntime.cookie || "",
    passToken: authRuntime.passToken || "",
    userId: authRuntime.passUserId || "",
    cUserId: authRuntime.passCUserId || "",
    passTokenExpiresAt: authRuntime.passTokenExpiresAt || null,
    cookieRefreshedAt: authRuntime.cookieRefreshedAt || null,
    lastSsoAt: authRuntime.lastSsoAt || null,
    updatedAt: authRuntime.updatedAt || new Date().toISOString(),
    _note: snap.hasServiceToken === false && snap.hasPassToken
      ? "cookie empty; proxy will SSO-refresh from passToken"
      : undefined,
  };
}

/** Write the per-account credential pack auth-<userId>.json (account secrets only). */
export async function writeAuthFile(file, authRuntime) {
  const target = file;
  if (!target) throw new Error("auth pack path is required");
  const payload = runtimeToAuthJson(authRuntime);
  delete payload._note;
  const ordered = {
    cookie: payload.cookie,
    passToken: payload.passToken,
    userId: payload.userId,
    cUserId: payload.cUserId,
    passTokenExpiresAt: payload.passTokenExpiresAt,
    cookieRefreshedAt: payload.cookieRefreshedAt,
    lastSsoAt: payload.lastSsoAt,
    updatedAt: payload.updatedAt,
  };
  await fs.mkdir(path.dirname(target), { recursive: true }).catch(() => {});
  await fs.writeFile(target, JSON.stringify(ordered, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return { target, path: target };
}

export async function hydrateAuthRuntime(config) {
  // Identity (sid/clientVersion/source) always comes from config.toml via config object.
  // Auth packs supply account credentials only; any identity keys inside old packs are ignored.
  const runtime = createAuthRuntime({
    clientVersion: config.clientVersion,
    source: config.source,
    sid: config.sid,
  });
  const fromFile = config.authFile ? await readAuthFile(config.authFile) : null;
  if (fromFile) {
    runtime.apply({
      ...(fromFile.cookie ? { cookie: fromFile.cookie } : {}),
      ...(fromFile.passToken ? { passToken: fromFile.passToken } : {}),
      ...(fromFile.passUserId ? { passUserId: fromFile.passUserId } : {}),
      ...(fromFile.passCUserId ? { passCUserId: fromFile.passCUserId } : {}),
      ...(fromFile.passTokenExpiresAt ? { passTokenExpiresAt: fromFile.passTokenExpiresAt } : {}),
      ...(fromFile.cookieRefreshedAt ? { cookieRefreshedAt: fromFile.cookieRefreshedAt } : {}),
      ...(fromFile.lastSsoAt ? { lastSsoAt: fromFile.lastSsoAt } : {}),
      ...(fromFile.updatedAt ? { updatedAt: fromFile.updatedAt } : {}),
    });
  }
  return runtime;
}

export async function persistAuthUpdate({ config, authRuntime }) {
  const warnings = [];
  const authFile = config.authFile;
  if (!authFile) {
    warnings.push({ target: "authFile", error: "missing per-account authFile path" });
    return warnings;
  }
  try {
    await writeAuthFile(authFile, authRuntime);
  } catch (error) {
    warnings.push({ target: authFile, error: error.code || error.message });
  }
  return warnings;
}

export function publicAuthStatus(config, authRuntime) {
  const snap = authRuntime.snapshot;
  return {
    accountId: config.accountId || null,
    accountUserId: config.accountUserId || authRuntime.passUserId || null,
    port: config.port ?? null,
    authFile: config.authFile || null,
    configFile: config.configTomlFile || null,
    identitySource: "config.toml",
    sid: config.sid || authRuntime.sid || null,
    // Runtime may hold a cloud-synced clientVersion newer than config.toml.
    clientVersion: authRuntime.clientVersion || config.clientVersion,
    source: authRuntime.source || config.source,
    upstreamUrl: config.upstreamUrl,
    updatedAt: authRuntime.updatedAt,
    cookieRefreshedAt: authRuntime.cookieRefreshedAt || null,
    lastSsoAt: authRuntime.lastSsoAt || null,
    hasRuntimeCookie: Boolean(authRuntime.cookie),
    cookieNames: authRuntime.cookie ? parseCookieNames(authRuntime.cookie) : null,
    hasServiceToken: Boolean(snap.hasServiceToken),
    hasPassToken: Boolean(authRuntime.passToken && authRuntime.passUserId),
    passUserId: authRuntime.passUserId || null,
    autoRefresh: config.autoRefresh !== false,
    clientVersionRefresh: config.clientVersionRefresh !== false,
    passTokenExpiresAt: authRuntime.passTokenExpiresAt || null,
    passTokenDaysLeft: snap.passTokenDaysLeft,
    clientVersionUpdatedAt: authRuntime.clientVersionUpdatedAt || null,
    lastClientVersionCheckAt: authRuntime.lastClientVersionCheckAt || null,
    clientVersionSource: authRuntime.clientVersionSource || null,
    clientVersionManifestUrl: config.clientVersionManifestUrl || null,
    clientVersionRefreshIntervalMs: config.clientVersionRefreshIntervalMs ?? null,
    clientVersionRefreshJitterMs: config.clientVersionRefreshJitterMs ?? null,
  };
}
