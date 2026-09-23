import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLogConfig } from "./logger.js";
import { parseToml, flattenConfigToml, upsertTomlTable } from "./toml.js";

export const PROJECT_DIR = fileURLToPath(new URL("../", import.meta.url));
export const UPSTREAM_URL = "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions";
export const CONFIG_DIRNAME = "config";
export const CONFIG_FILENAME = "config.toml";
/** Multi-account credential packs: auth-<userId>.json only (legacy auth.json is not loaded). */
export const AUTH_ACCOUNT_FILENAME_RE = /^auth-.+\.json$/i;
export const CLIENT_VERSION = "26.914.142245";
export const DEFAULT_CLIENT_VERSION_MANIFEST_URL =
  "https://mimocode-cdn.xiaomimimo.com/mimocode/mimodesktop/manifest.json";
export const DEFAULT_MODEL = "mimo-v2.6-pro";
export const DEFAULT_MODELS = [DEFAULT_MODEL, "mimo-v2.6-flash"];

function text(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? fallback : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new Error(name + " must be a string");
}

function integer(value, fallback, name, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(name + " must be an integer between " + minimum + " and " + maximum);
  }
  return result;
}

function urlSetting(value, fallback, name) {
  const result = text(value, fallback, name);
  if (!result) return "";
  try {
    if (["http:", "https:"].includes(new URL(result).protocol)) return result;
  } catch { /* Report only the setting name; a URL may contain credentials. */ }
  throw new Error(name + " must be an http:// or https:// URL");
}

function modelList(value) {
  let configured = [];
  if (Array.isArray(value)) {
    configured = [...new Set(value.map(item => String(item).trim()).filter(Boolean))];
  } else if (typeof value === "string") {
    configured = [...new Set(value.split(",").map(item => item.trim()).filter(Boolean))];
  } else if (value !== undefined && value !== null) {
    throw new Error("models must be an array of strings or a comma-separated string");
  }
  return configured.length ? configured : [...DEFAULT_MODELS];
}

async function hasAuthAccountFiles(dir) {
  try {
    const entries = await fs.readdir(dir);
    return entries.some(name => AUTH_ACCOUNT_FILENAME_RE.test(name) && !name.toLowerCase().includes(".bak"));
  } catch {
    return false;
  }
}

/**
 * Resolve config.toml location. Multi-account packs live beside it as auth-*.json.
 * Preferred: config/config.toml + config/auth-*.json
 * Project-root config.toml wins over auth files alone under config/.
 */
export async function resolveConfigPaths(directory = PROJECT_DIR) {
  const nestedDir = path.join(directory, CONFIG_DIRNAME);
  const nestedToml = path.join(nestedDir, CONFIG_FILENAME);
  const rootToml = path.join(directory, CONFIG_FILENAME);

  try {
    await fs.access(nestedToml);
    return { configRoot: nestedDir, configFile: nestedToml, source: "config-dir-file" };
  } catch { /* continue */ }

  try {
    await fs.access(rootToml);
    return { configRoot: directory, configFile: rootToml, source: "project-root-file" };
  } catch { /* continue */ }

  if (await hasAuthAccountFiles(nestedDir)) {
    return { configRoot: nestedDir, configFile: nestedToml, source: "config-dir-auth" };
  }

  if (await hasAuthAccountFiles(directory)) {
    return { configRoot: directory, configFile: rootToml, source: "project-root-auth" };
  }

  try {
    const stat = await fs.stat(nestedDir);
    if (stat.isDirectory()) {
      return { configRoot: nestedDir, configFile: nestedToml, source: "config-dir" };
    }
  } catch { /* continue */ }

  return { configRoot: nestedDir, configFile: nestedToml, source: "config-dir-default" };
}

function boolSetting(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1) return true;
  if (value === "false" || value === 0) return false;
  throw new Error(name + " must be a boolean");
}

export function readConfig(settings = {}, directory = PROJECT_DIR) {
  const configRoot = settings.configRoot || directory;
  const models = modelList(settings.models);
  // CLI discovers auth-*.json and injects authFile per account. Empty = discovery mode.
  // Explicit authFile remains supported for tests and programmatic single-pack use.
  const authFileSetting = settings.authFile === undefined || settings.authFile === null || settings.authFile === ""
    ? ""
    : text(settings.authFile, "", "auth.authFile");
  return {
    host: text(settings.host, "0.0.0.0", "host"),
    // basePort for multi-account: account i listens on port+index (0 = ephemeral each).
    port: integer(settings.port, 3000, "port", 0, 65535),
    upstreamUrl: urlSetting(settings.upstreamUrl, UPSTREAM_URL, "upstream.url"),
    models,
    defaultModel: models[0],
    // Optional in-memory cookie override (tools/tests). Not loaded from config.toml.
    // Live credentials otherwise come from the per-account auth-*.json pack.
    cookie: typeof settings.cookie === "string" ? settings.cookie.trim() : "",
    clientVersion: text(settings.clientVersion, CLIENT_VERSION, "auth.clientVersion"),
    source: text(settings.source, "mimocode-cli-free", "auth.source"),
    apiKey: text(settings.apiKey, "", "apiKey"),
    mitmUrl: urlSetting(settings.mitmUrl, "", "mitm.url"),
    mitmAuth: text(settings.mitmAuth, "", "mitm.auth"),
    configRoot,
    configTomlFile: path.resolve(settings.configTomlFile || path.join(configRoot, CONFIG_FILENAME)),
    authFile: authFileSetting ? path.resolve(configRoot, authFileSetting) : "",
    accountId: settings.accountId ? String(settings.accountId) : "",
    accountUserId: settings.accountUserId ? String(settings.accountUserId) : "",
    timeoutMs: integer(settings.timeoutMs, 0, "upstream.timeoutMs", 0, 2147483647),
    authTimeoutMs: integer(settings.authTimeoutMs, 5000, "auth.timeoutMs", 1, 2147483647),
    sid: text(settings.sid, "mimopc", "auth.sid"),
    autoRefresh: boolSetting(settings.autoRefresh, true, "auth.autoRefresh"),
    refreshIntervalMs: integer(settings.refreshIntervalMs, 0, "auth.refreshIntervalMs", 0, 2147483647),
    passTokenRenewBeforeMs: integer(settings.passTokenRenewBeforeMs, 7 * 24 * 3600 * 1000, "auth.passTokenRenewBeforeMs", 0, 2147483647),
    // Cloud clientVersion sync (desktop manifest.json). Base 2h, jitter ±1h by default.
    clientVersionRefresh: boolSetting(settings.clientVersionRefresh, true, "auth.clientVersionRefresh"),
    clientVersionRefreshIntervalMs: integer(settings.clientVersionRefreshIntervalMs, 2 * 60 * 60 * 1000, "auth.clientVersionRefreshIntervalMs", 0, 2147483647),
    clientVersionRefreshJitterMs: integer(settings.clientVersionRefreshJitterMs, 60 * 60 * 1000, "auth.clientVersionRefreshJitterMs", 0, 2147483647),
    clientVersionManifestUrl: urlSetting(settings.clientVersionManifestUrl, DEFAULT_CLIENT_VERSION_MANIFEST_URL, "auth.clientVersionManifestUrl"),
    clientVersionTimeoutMs: integer(settings.clientVersionTimeoutMs, 8000, "auth.clientVersionTimeoutMs", 1, 60000),
    ssoUrl: urlSetting(settings.ssoUrl, "https://account.xiaomi.com/pass/serviceLogin", "auth.ssoUrl"),
    ssoUserAgent: text(settings.ssoUserAgent, "MiClaw/1.0", "auth.ssoUserAgent"),
    logging: readLogConfig(settings.logging || {}, configRoot)
  };
}

export async function loadConfig(overrides = {}, directory = PROJECT_DIR) {
  const paths = await resolveConfigPaths(directory);
  let data = Object.create(null);
  try {
    data = parseToml(await fs.readFile(paths.configFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(error.message?.includes("Invalid TOML") ? error.message : "Cannot read config.toml (expected at " + paths.configFile + ")");
    }
  }
  return readConfig({
    ...flattenConfigToml(data),
    configRoot: paths.configRoot,
    configTomlFile: paths.configFile,
    ...overrides,
  }, paths.configRoot);
}

/** Persist account-independent identity fields into config.toml [auth]. */
export async function persistSharedIdentity(config, identity = {}) {
  const file = config?.configTomlFile;
  if (!file) return { warnings: [{ target: "config.toml", error: "configTomlFile missing" }] };
  const updates = {};
  if (identity.sid !== undefined && identity.sid !== null && identity.sid !== "") updates.sid = String(identity.sid);
  if (identity.clientVersion !== undefined && identity.clientVersion !== null && identity.clientVersion !== "") {
    updates.clientVersion = String(identity.clientVersion);
  }
  if (identity.source !== undefined && identity.source !== null && identity.source !== "") updates.source = String(identity.source);
  if (!Object.keys(updates).length) return { warnings: [] };
  try {
    let text = "";
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const next = upsertTomlTable(text, "auth", updates);
    await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
    await fs.writeFile(file, next, "utf8");
    return { warnings: [] };
  } catch (error) {
    return { warnings: [{ target: file, error: error.code || error.message }] };
  }
}
