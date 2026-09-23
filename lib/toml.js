// Minimal TOML subset for mimo-proxy config: tables, basic/literal strings,
// integers, booleans, and homogeneous arrays. Zero dependencies.

function fail(message, line) {
  const suffix = line ? " at line " + line : "";
  throw new Error("Invalid TOML syntax" + suffix + (message ? ": " + message : ""));
}

function parseBasicString(raw, line) {
  if (!raw.endsWith('"')) fail("unterminated string", line);
  let body = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") { out += ch; continue; }
    const next = body[++i];
    if (next === undefined) fail("unterminated escape", line);
    const map = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\", b: "\b", f: "\f" };
    if (next === "u" || next === "U") {
      const size = next === "u" ? 4 : 8;
      const hex = body.slice(i + 1, i + 1 + size);
      if (hex.length !== size || !/^[0-9a-fA-F]+$/.test(hex)) fail("invalid unicode escape", line);
      out += String.fromCodePoint(parseInt(hex, 16));
      i += size;
      continue;
    }
    if (!(next in map)) fail("invalid escape \\" + next, line);
    out += map[next];
  }
  return out;
}

function parseLiteralString(raw, line) {
  if (!raw.endsWith("'")) fail("unterminated literal string", line);
  return raw.slice(1, -1);
}

function splitTopLevelArray(text, line) {
  const inner = text.slice(1, -1);
  const parts = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"') { current += inner[++i] ?? ""; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === ",") { parts.push(current); current = ""; continue; }
    current += ch;
  }
  if (quote) fail("unterminated string in array", line);
  if (current.trim() || parts.length) parts.push(current);
  return parts.map(part => part.trim()).filter(part => part !== "");
}

function parseScalar(raw, line) {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith('"')) return parseBasicString(text, line);
  if (text.startsWith("'")) return parseLiteralString(text, line);
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) fail("unterminated array", line);
    return splitTopLevelArray(text, line).map(part => parseScalar(part, line));
  }
  if (/^[+-]?\d+$/.test(text)) return Number(text);
  if (/^[+-]?\d+\.\d+$/.test(text)) return Number(text);
  fail("unsupported value", line);
}

export function parseToml(text) {
  const root = Object.create(null);
  let table = root;
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const lineNo = index + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const tableMatch = /^\[([^\]]+)\]\s*(?:#.*)?$/.exec(trimmed);
    if (tableMatch) {
      const path = tableMatch[1].trim().split(".").map(part => part.trim()).filter(Boolean);
      if (!path.length) fail("empty table name", lineNo);
      table = root;
      for (const key of path) {
        if (!table[key] || typeof table[key] !== "object" || Array.isArray(table[key])) table[key] = Object.create(null);
        table = table[key];
      }
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(trimmed);
    if (!pair) fail("", lineNo);
    let valueRaw = pair[2].trim();
    const hash = findUnquotedHash(valueRaw);
    if (hash >= 0) valueRaw = valueRaw.slice(0, hash).trim();
    if (!valueRaw) fail("missing value for " + pair[1], lineNo);
    table[pair[1]] = parseScalar(valueRaw, lineNo);
  }
  return root;
}

function findUnquotedHash(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "#") return i;
  }
  return -1;
}

export function formatTomlValue(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
  }
  if (Array.isArray(value)) return "[" + value.map(formatTomlValue).join(", ") + "]";
  throw new Error("Unsupported TOML value type");
}

export function flattenConfigToml(data = {}) {
  const auth = data.auth && typeof data.auth === "object" ? data.auth : {};
  const upstream = data.upstream && typeof data.upstream === "object" ? data.upstream : {};
  const mitm = data.mitm && typeof data.mitm === "object" ? data.mitm : {};
  const logging = data.logging && typeof data.logging === "object" ? data.logging : {};
  const pick = (...values) => {
    for (const value of values) if (value !== undefined) return value;
    return undefined;
  };
  return {
    host: pick(data.host),
    port: pick(data.port),
    models: pick(data.models),
    apiKey: pick(data.apiKey, data.api_key),
    // Account credentials live in auth-<userId>.json packs.
    // Account-independent identity lives in config.toml [auth]: sid / clientVersion / source.
    clientVersion: pick(auth.clientVersion, auth.client_version, data.clientVersion, data.client_version),
    source: pick(auth.source, data.source),
    authTimeoutMs: pick(auth.timeoutMs, auth.timeout_ms, data.authTimeoutMs),
    authFile: pick(auth.authFile, auth.auth_file, data.authFile, data.auth_file),
    sid: pick(auth.sid, data.sid),
    autoRefresh: pick(auth.autoRefresh, auth.auto_refresh, data.autoRefresh),
    refreshIntervalMs: pick(auth.refreshIntervalMs, auth.refresh_interval_ms, data.refreshIntervalMs),
    passTokenRenewBeforeMs: pick(auth.passTokenRenewBeforeMs, auth.pass_token_renew_before_ms, data.passTokenRenewBeforeMs),
    clientVersionRefresh: pick(auth.clientVersionRefresh, auth.client_version_refresh, data.clientVersionRefresh),
    clientVersionRefreshIntervalMs: pick(auth.clientVersionRefreshIntervalMs, auth.client_version_refresh_interval_ms, data.clientVersionRefreshIntervalMs),
    clientVersionRefreshJitterMs: pick(auth.clientVersionRefreshJitterMs, auth.client_version_refresh_jitter_ms, data.clientVersionRefreshJitterMs),
    clientVersionManifestUrl: pick(auth.clientVersionManifestUrl, auth.client_version_manifest_url, data.clientVersionManifestUrl),
    clientVersionTimeoutMs: pick(auth.clientVersionTimeoutMs, auth.client_version_timeout_ms, data.clientVersionTimeoutMs),
    ssoUrl: pick(auth.ssoUrl, auth.sso_url, data.ssoUrl),
    ssoUserAgent: pick(auth.ssoUserAgent, auth.sso_user_agent, data.ssoUserAgent),
    upstreamUrl: pick(upstream.url, data.upstreamUrl, data.upstream_url),
    timeoutMs: pick(upstream.timeoutMs, upstream.timeout_ms, data.timeoutMs),
    mitmUrl: pick(mitm.url, data.mitmUrl),
    mitmAuth: pick(mitm.auth, data.mitmAuth),
    logging,
  };
}

export function upsertTomlTable(text, tableName, updates) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const header = "[" + tableName + "]";
  const tableRe = new RegExp("^\\[" + tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\]\\s*(?:#.*)?$");
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (tableRe.test(trimmed)) { start = i; continue; }
    if (start >= 0 && /^\[/.test(trimmed)) { end = i; break; }
  }

  const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
  if (!entries.length) return text || "";

  if (start < 0) {
    const parts = [];
    const base = (text || "").replace(/\s*$/, "");
    if (base) parts.push(base, "");
    parts.push(header);
    for (const [key, value] of entries) parts.push(key + " = " + formatTomlValue(value));
    return parts.join("\n") + "\n";
  }

  const section = lines.slice(start + 1, end);
  for (const [key, value] of entries) {
    const line = key + " = " + formatTomlValue(value);
    const keyRe = new RegExp("^\\s*" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*=");
    const index = section.findIndex(item => keyRe.test(item));
    if (index >= 0) section[index] = line;
    else {
      let insertAt = section.length;
      while (insertAt > 0 && !section[insertAt - 1].trim()) insertAt--;
      section.splice(insertAt, 0, line);
    }
  }
  const next = [...lines.slice(0, start + 1), ...section, ...lines.slice(end)];
  return next.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function writeTomlFileContent(data = {}) {
  const lines = [];
  lines.push("# mimo-proxy 配置文件");
  lines.push("# 所有配置项均可省略；省略时使用内置默认值。");
  if (data.host !== undefined) lines.push("host = " + formatTomlValue(data.host));
  if (data.port !== undefined) lines.push("port = " + formatTomlValue(data.port));
  if (data.models !== undefined) lines.push("models = " + formatTomlValue(data.models));
  if (data.apiKey !== undefined) lines.push("apiKey = " + formatTomlValue(data.apiKey));
  const auth = {};
  if (data.clientVersion !== undefined) auth.clientVersion = data.clientVersion;
  if (data.source !== undefined) auth.source = data.source;
  if (data.authFile !== undefined) auth.authFile = data.authFile;
  if (data.authTimeoutMs !== undefined) auth.timeoutMs = data.authTimeoutMs;
  if (Object.keys(auth).length) {
    lines.push("");
    lines.push("[auth]");
    for (const [key, value] of Object.entries(auth)) lines.push(key + " = " + formatTomlValue(value));
  }
  if (data.upstreamUrl !== undefined || data.timeoutMs !== undefined) {
    lines.push("");
    lines.push("[upstream]");
    if (data.upstreamUrl !== undefined) lines.push("url = " + formatTomlValue(data.upstreamUrl));
    if (data.timeoutMs !== undefined) lines.push("timeoutMs = " + formatTomlValue(data.timeoutMs));
  }
  return lines.join("\n") + "\n";
}
