import { ProxyError } from "./errors.js";
import {
  DEFAULT_SID, DEFAULT_SSO_URL, DEFAULT_SSO_USER_AGENT,
  hasPassCredentials, refreshServiceToken
} from "./sso-refresh.js";
import { parseCookieNames, readAuthFile } from "./auth-runtime.js";

function serviceTokenPresent(cookie) {
  return parseCookieNames(cookie).includes("serviceToken");
}

/**
 * Auth provider that keeps chat cookies fresh via Xiaomi SSO when passToken is available.
 * `baseAuth` must be injected (usually getAuthHeaders from mimo_server.js) to avoid a cycle.
 */
export function createAutoAuthProvider({
  config,
  authRuntime,
  logger,
  baseAuth,
  refreshImpl = refreshServiceToken,
  persist = null,
  ssoFetchImpl,
  clientVersionRefresher = null,
} = {}) {
  if (!authRuntime) throw new Error("createAutoAuthProvider requires authRuntime");
  if (typeof baseAuth !== "function") throw new Error("createAutoAuthProvider requires baseAuth");
  const log = logger || { info() {}, warn() {}, error() {}, debug() {} };
  let inflight = null;

  function liveConfig() {
    return authRuntime.applyTo({ ...config, authRuntime });
  }

  function autoRefreshEnabled(cfg) {
    return cfg?.autoRefresh !== false;
  }

  function shouldRenewPassToken(cfg) {
    const renewBefore = Number(cfg.passTokenRenewBeforeMs);
    if (!Number.isFinite(renewBefore) || renewBefore <= 0) return false;
    const expiresAt = authRuntime.passTokenExpiresAt;
    if (!expiresAt) return false;
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs)) return false;
    return expiresMs - Date.now() <= renewBefore;
  }

  function shouldRefreshByInterval(cfg) {
    const interval = Number(cfg.refreshIntervalMs) || 0;
    if (interval <= 0) return false;
    const last = authRuntime.lastSsoAt || authRuntime.cookieRefreshedAt;
    if (!last) return false;
    const age = Date.now() - Date.parse(last);
    return Number.isFinite(age) && age >= interval;
  }

  async function resolvePassCredentials() {
    const cfg = liveConfig();
    const fromRuntime = {
      passToken: authRuntime.passToken || "",
      userId: authRuntime.passUserId || "",
      passUserId: authRuntime.passUserId || "",
      cUserId: authRuntime.passCUserId || "",
      passCUserId: authRuntime.passCUserId || "",
      sid: authRuntime.sid || "",
      passTokenExpiresAt: authRuntime.passTokenExpiresAt || null,
    };
    if (hasPassCredentials(fromRuntime)) {
      return { ...fromRuntime, sid: fromRuntime.sid || cfg.sid || DEFAULT_SID, source: "runtime" };
    }
    const fromFile = await readAuthFile(cfg.authFile);
    if (fromFile && hasPassCredentials(fromFile)) {
      // Account credentials only; identity (sid/clientVersion/source) stays on config.toml.
      authRuntime.apply({
        ...(fromFile.cookie ? { cookie: fromFile.cookie } : {}),
        passToken: fromFile.passToken,
        passUserId: fromFile.passUserId,
        passCUserId: fromFile.passCUserId,
        ...(fromFile.passTokenExpiresAt ? { passTokenExpiresAt: fromFile.passTokenExpiresAt } : {}),
      });
      return {
        passToken: fromFile.passToken,
        userId: fromFile.passUserId,
        passUserId: fromFile.passUserId,
        cUserId: fromFile.passCUserId,
        passCUserId: fromFile.passCUserId,
        sid: cfg.sid || DEFAULT_SID,
        passTokenExpiresAt: fromFile.passTokenExpiresAt || null,
        source: "auth-file",
      };
    }
    return null;
  }

  async function doRefresh({ reason, signal } = {}) {
    const creds = await resolvePassCredentials();
    if (!creds) {
      throw new ProxyError(503, "auth_error",
        "Cookie auto-refresh unavailable: write passToken/userId into auth-<userId>.json");
    }
    const cfg = liveConfig();
    const result = await refreshImpl({
      passToken: creds.passToken,
      userId: creds.userId || creds.passUserId || "",
      cUserId: creds.cUserId || creds.passCUserId || "",
      sid: creds.sid || cfg.sid || DEFAULT_SID,
      ssoUrl: cfg.ssoUrl || DEFAULT_SSO_URL,
      userAgent: cfg.ssoUserAgent || DEFAULT_SSO_USER_AGENT,
      fetchImpl: ssoFetchImpl || cfg.ssoFetchImpl || fetch,
      signal,
    });
    const cookieRefreshedAt = new Date().toISOString();
    const lastSsoAt = cookieRefreshedAt;
    const passUpdate = { cookie: result.cookie, cookieRefreshedAt, lastSsoAt };
    if (result.passToken) passUpdate.passToken = result.passToken;
    if (result.passUserId) passUpdate.passUserId = result.passUserId;
    if (result.passCUserId) passUpdate.passCUserId = result.passCUserId;
    if (result.passTokenExpiresAt) passUpdate.passTokenExpiresAt = result.passTokenExpiresAt;
    authRuntime.apply(passUpdate);
    if (typeof persist === "function") {
      const warnings = await persist({ config: cfg, authRuntime });
      if (warnings?.length) {
        log.warn("auth.sso_persist_warnings", { warnings: warnings.map(item => item.target + ":" + item.error) });
      }
    }
    log.info("auth.sso_refreshed", {
      reason,
      sid: result.sid,
      cookieNames: result.cookieNames,
      credentialSource: creds.source,
      cookieRefreshedAt,
      passTokenExpiresAt: authRuntime.passTokenExpiresAt,
      passTokenRenewed: Boolean(result.passTokenRenewed ?? result.passTokenExpiresAt),
    });
    // Cookie refresh forces a cloud clientVersion sync (independent of the interval timer).
    if (clientVersionRefresher && typeof clientVersionRefresher.refresh === "function") {
      try {
        const versionResult = await clientVersionRefresher.refresh({
          reason: "cookie_refresh",
          force: true,
        });
        if (versionResult?.changed) {
          log.info("auth.client_version_forced_after_cookie_refresh", {
            previous: versionResult.previous,
            clientVersion: versionResult.clientVersion,
          });
        }
      } catch (error) {
        log.warn("auth.client_version_refresh_failed", {
          reason: "cookie_refresh",
          detail: error?.message || String(error),
        });
      }
    }
    return result;
  }

  function refresh(options = {}) {
    if (inflight) return inflight;
    inflight = doRefresh(options).finally(() => { inflight = null; });
    return inflight;
  }

  async function maybeRefresh(cfg, cookie) {
    if (!autoRefreshEnabled(cfg)) return false;
    const creds = await resolvePassCredentials();
    if (!creds) return false;

    if (shouldRenewPassToken(cfg)) {
      await refresh({ reason: "pass_token_expiring" });
      return true;
    }
    if (shouldRefreshByInterval(cfg)) {
      await refresh({ reason: "interval" });
      return true;
    }

    if (cookie && serviceTokenPresent(cookie)) return false;
    await refresh({ reason: cookie ? "missing_service_token" : "missing_cookie" });
    return true;
  }

  async function auth(cfg = liveConfig(), options = {}) {
    const live = authRuntime.applyTo({ ...cfg, ...liveConfig(), authRuntime });
    let headers;
    try {
      headers = await baseAuth(live, options);
    } catch (error) {
      if (!autoRefreshEnabled(live)) throw error;
      const refreshable = error?.status === 503 || error?.code === "ENOENT";
      if (!refreshable) throw error;
      const creds = await resolvePassCredentials();
      if (!creds) throw error;
      await refresh({ reason: "auth_provider_error", signal: options.signal });
      headers = await baseAuth(authRuntime.applyTo({ ...live, authRuntime }), options);
    }
    const cookie = headers.get?.("cookie") || String(live.cookie || "");
    if (await maybeRefresh(live, cookie)) {
      headers = await baseAuth(authRuntime.applyTo({ ...live, authRuntime }), options);
    }
    return headers;
  }

  return {
    auth,
    refresh,
    resolvePassCredentials,
  };
}
