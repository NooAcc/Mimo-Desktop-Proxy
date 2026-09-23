import { ProxyError } from "./errors.js";
import { persistSharedIdentity } from "./config.js";

export const DEFAULT_CLIENT_VERSION_MANIFEST_URL =
  "https://mimocode-cdn.xiaomimimo.com/mimocode/mimodesktop/manifest.json";

/** Base interval 2h with ±1h jitter → delay in [1h, 3h]. */
export const DEFAULT_CLIENT_VERSION_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_CLIENT_VERSION_REFRESH_JITTER_MS = 60 * 60 * 1000;

const VERSION_RE = /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;

export function normalizeClientVersion(value) {
  const text = String(value ?? "").trim();
  return VERSION_RE.test(text) ? text : "";
}

export function clientVersionPlatformKey(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "mac-arm64";
  if (platform === "win32" && (arch === "x64" || arch === "ia32")) return "win-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  return null;
}

function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/);
  const pb = String(b).split(/[.-]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number(pa[i] || 0);
    const nb = Number(pb[i] || 0);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    const sa = String(pa[i] || "");
    const sb = String(pb[i] || "");
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return 0;
}

/** Extract latest clientVersion from desktop update manifest.json. */
export function parseClientVersionManifest(manifest, { platformKey } = {}) {
  const platforms = manifest?.platforms;
  if (!platforms || typeof platforms !== "object") {
    return { clientVersion: "", platform: null, source: "manifest" };
  }
  const pick = (key) => {
    const item = platforms[key];
    if (!item || typeof item !== "object") return "";
    return normalizeClientVersion(item.productVersion || item.version);
  };
  const preferred = platformKey ? pick(platformKey) : "";
  if (preferred) return { clientVersion: preferred, platform: platformKey, source: "manifest" };

  let best = { clientVersion: "", platform: null, source: "manifest" };
  for (const [key, item] of Object.entries(platforms)) {
    const version = normalizeClientVersion(item?.productVersion || item?.version);
    if (!version) continue;
    if (!best.clientVersion || compareVersions(version, best.clientVersion) > 0) {
      best = { clientVersion: version, platform: key, source: "manifest" };
    }
  }
  return best;
}

export function nextClientVersionRefreshDelayMs({
  intervalMs = DEFAULT_CLIENT_VERSION_REFRESH_INTERVAL_MS,
  jitterMs = DEFAULT_CLIENT_VERSION_REFRESH_JITTER_MS,
  random = Math.random,
} = {}) {
  const base = Number.isFinite(Number(intervalMs)) ? Number(intervalMs) : DEFAULT_CLIENT_VERSION_REFRESH_INTERVAL_MS;
  const jitter = Number.isFinite(Number(jitterMs)) ? Number(jitterMs) : DEFAULT_CLIENT_VERSION_REFRESH_JITTER_MS;
  const min = Math.max(0, base - jitter);
  const max = Math.max(min, base + jitter);
  if (max === min) return min;
  return Math.floor(min + random() * (max - min + 1));
}

export async function fetchCloudClientVersion({
  manifestUrl = DEFAULT_CLIENT_VERSION_MANIFEST_URL,
  platformKey,
  fetchImpl = fetch,
  signal,
  timeoutMs = 8000,
  userAgent = "MiClaw/1.0",
} = {}) {
  const url = String(manifestUrl || "").trim();
  if (!url) throw new ProxyError(500, "config_error", "auth.clientVersionManifestUrl is empty");
  let response;
  try {
    const timer = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
    const linked = signal && timer ? AbortSignal.any([signal, timer]) : (signal || timer);
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": userAgent },
      redirect: "follow",
      signal: linked,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new ProxyError(502, "client_version_error",
      "clientVersion manifest request failed: " + (error?.message || error));
  }
  if (!response.ok) {
    throw new ProxyError(502, "client_version_error",
      "clientVersion manifest HTTP " + response.status);
  }
  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new ProxyError(502, "client_version_error",
      "clientVersion manifest is not JSON: " + (error?.message || error));
  }
  const parsed = parseClientVersionManifest(data, { platformKey });
  if (!parsed.clientVersion) {
    throw new ProxyError(502, "client_version_error",
      "clientVersion manifest did not include a usable version");
  }
  return parsed;
}

/**
 * Periodically pull cloud clientVersion; force-refresh when cookie SSO succeeds.
 * Identity (sid/clientVersion/source) is shared and persisted to config.toml [auth],
 * not into per-account auth-*.json packs.
 */
export function createClientVersionRefresher({
  config = {},
  authRuntime,
  logger,
  persist = null,
  persistIdentity = persistSharedIdentity,
  fetchImpl = fetch,
  random = Math.random,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!authRuntime) throw new Error("createClientVersionRefresher requires authRuntime");
  const log = logger || { info() {}, warn() {}, error() {}, debug() {} };
  let timer = null;
  let inflight = null;
  let stopped = false;
  let lastCheckAt = null;
  let lastUpdatedAt = null;

  function enabled() {
    return config?.clientVersionRefresh !== false;
  }

  function liveConfig() {
    return typeof authRuntime.applyTo === "function"
      ? authRuntime.applyTo({ ...config })
      : { ...config };
  }

  async function doRefresh({ reason = "interval", force = false } = {}) {
    const cfg = liveConfig();
    if (!force && !enabled()) {
      return { ok: false, skipped: true, reason: "disabled" };
    }
    const platformKey = cfg.clientVersionPlatform
      || clientVersionPlatformKey(process.platform, process.arch);
    const result = await fetchCloudClientVersion({
      manifestUrl: cfg.clientVersionManifestUrl || DEFAULT_CLIENT_VERSION_MANIFEST_URL,
      platformKey,
      fetchImpl: cfg.clientVersionFetchImpl || fetchImpl,
      timeoutMs: cfg.clientVersionTimeoutMs || 8000,
    });
    const previous = authRuntime.clientVersion || cfg.clientVersion || "";
    const next = result.clientVersion;
    const changed = Boolean(next) && next !== previous;
    const checkedAt = new Date().toISOString();
    lastCheckAt = checkedAt;
    const update = {
      lastClientVersionCheckAt: checkedAt,
      clientVersionSource: "cloud-manifest",
    };
    if (changed) {
      update.clientVersion = next;
      update.clientVersionUpdatedAt = checkedAt;
      lastUpdatedAt = checkedAt;
    }
    authRuntime.apply(update);
    let warnings = [];
    if (changed && typeof persistIdentity === "function") {
      warnings = (await persistIdentity(cfg, {
        clientVersion: next,
        source: cfg.source || authRuntime.source,
        sid: cfg.sid || authRuntime.sid,
      }))?.warnings || [];
      if (warnings.length) {
        log.warn("auth.client_version_persist_warnings", {
          warnings: warnings.map(item => item.target + ":" + item.error),
        });
      }
    }
    log.info(changed ? "auth.client_version_updated" : "auth.client_version_checked", {
      reason,
      force,
      previous: previous || null,
      clientVersion: next,
      platform: result.platform,
      changed,
      manifestUrl: cfg.clientVersionManifestUrl || DEFAULT_CLIENT_VERSION_MANIFEST_URL,
      checkedAt,
    });
    return {
      ok: true,
      changed,
      previous: previous || null,
      clientVersion: next,
      platform: result.platform,
      checkedAt,
      clientVersionUpdatedAt: changed ? checkedAt : lastUpdatedAt,
      reason,
    };
  }

  function refresh(options = {}) {
    if (inflight) return inflight;
    inflight = doRefresh(options).finally(() => { inflight = null; });
    return inflight;
  }

  function scheduleNext(delayMs) {
    if (stopped || !enabled()) return;
    const delay = Number.isFinite(Number(delayMs))
      ? Number(delayMs)
      : nextClientVersionRefreshDelayMs({
          intervalMs: config.clientVersionRefreshIntervalMs,
          jitterMs: config.clientVersionRefreshJitterMs,
          random,
        });
    if (timer) clearTimeoutImpl(timer);
    timer = setTimeoutImpl(() => {
      timer = null;
      void refresh({ reason: "interval" })
        .catch(error => {
          log.warn("auth.client_version_refresh_failed", {
            reason: "interval",
            detail: error?.message || String(error),
          });
        })
        .finally(() => scheduleNext());
    }, delay);
    timer?.unref?.();
    log.debug?.("auth.client_version_scheduled", { delayMs: delay });
  }

  return {
    refresh,
    scheduleNext,
    start() {
      stopped = false;
      scheduleNext();
      return this;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeoutImpl(timer);
      timer = null;
    },
    get lastCheckAt() { return lastCheckAt; },
    get lastUpdatedAt() { return lastUpdatedAt; },
    get nextDelayMs() {
      return nextClientVersionRefreshDelayMs({
        intervalMs: config.clientVersionRefreshIntervalMs,
        jitterMs: config.clientVersionRefreshJitterMs,
        random,
      });
    },
  };
}
