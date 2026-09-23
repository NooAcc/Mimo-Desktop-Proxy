import crypto from "node:crypto";
import { ProxyError } from "./errors.js";

export const DEFAULT_SSO_URL = "https://account.xiaomi.com/pass/serviceLogin";
export const DEFAULT_SID = "mimopc";
export const DEFAULT_SSO_USER_AGENT = "MiClaw/1.0";

export function clientSign(nonce, ssecurity) {
  const input = "nonce=" + String(nonce) + (ssecurity ? "&" + String(ssecurity) : "");
  return encodeURIComponent(crypto.createHash("sha1").update(input).digest("base64"));
}

export function parseServiceLoginBody(text) {
  const cleaned = String(text || "").replace(/^&&&START&&&/, "").trim();
  const location = cleaned.match(/"location"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1] || "";
  const nonce = cleaned.match(/"nonce"\s*:\s*"?([0-9]+)"?/)?.[1] || "";
  const ssecurity = (cleaned.match(/"ssecurity"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1] || "").replaceAll("\\/", "/");
  const code = cleaned.match(/"code"\s*:\s*(-?\d+)/)?.[1];
  const result = cleaned.match(/"result"\s*:\s*"([^"]*)"/)?.[1] || "";
  const description = cleaned.match(/"description"\s*:\s*"([^"]*)"/)?.[1] || "";
  return {
    location: location.replaceAll("\\/", "/").replace(/\\u003d/gi, "="),
    nonce,
    ssecurity,
    code: code === undefined ? null : Number(code),
    result,
    description,
  };
}

function parseSetCookieItems(headers) {
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  const single = headers.get("set-cookie");
  const items = list?.length ? list : single ? String(single).split("\n") : [];
  return items.map(item => {
    const parts = String(item).split(";");
    const pair = parts[0] || "";
    const index = pair.indexOf("=");
    const name = index > 0 ? pair.slice(0, index).trim() : "";
    const value = index > 0 ? pair.slice(index + 1).trim() : "";
    const attrs = { name, value, maxAge: null, expiresAt: null };
    for (const attr of parts.slice(1)) {
      const eq = attr.indexOf("=");
      const key = (eq >= 0 ? attr.slice(0, eq) : attr).trim().toLowerCase();
      const val = eq >= 0 ? attr.slice(eq + 1).trim() : "";
      if (key === "max-age" && val && Number.isFinite(Number(val))) {
        attrs.maxAge = Number(val);
        attrs.expiresAt = new Date(Date.now() + Number(val) * 1000).toISOString();
      } else if (key === "expires" && val) {
        const parsed = Date.parse(val);
        if (Number.isFinite(parsed)) attrs.expiresAt = new Date(parsed).toISOString();
      }
    }
    return attrs;
  }).filter(item => item.name);
}

function parseSetCookies(headers) {
  const map = {};
  for (const item of parseSetCookieItems(headers)) map[item.name] = item.value;
  return map;
}

/**
 * Xiaomi serviceLogin re-issues passToken Set-Cookie with Max-Age≈30d even when the
 * token value is unchanged — sliding renewal. Capture expiry for proactive refresh.
 */
export function parsePassTokenRenewal(headers, { fallbackPassToken = "", fallbackUserId = "", fallbackCUserId = "" } = {}) {
  const items = parseSetCookieItems(headers);
  const passCookie = items.find(item => item.name === "passToken");
  const userCookie = items.find(item => item.name === "userId");
  const cUserCookie = items.find(item => item.name === "cUserId");
  return {
    passToken: passCookie?.value || fallbackPassToken,
    userId: userCookie?.value || fallbackUserId,
    cUserId: cUserCookie?.value || fallbackCUserId,
    passTokenExpiresAt: passCookie?.expiresAt || null,
    passTokenMaxAgeSec: passCookie?.maxAge,
    passTokenRenewed: Boolean(passCookie?.expiresAt || passCookie?.value),
  };
}

export function composeServiceCookie(map, { sid = DEFAULT_SID, fallbackUserId = "" } = {}) {
  const serviceToken = map.serviceToken || map[sid + "_serviceToken"] || "";
  const userId = map.userId || fallbackUserId || "";
  const slh = map[sid + "_slh"] ?? "";
  const ph = map[sid + "_ph"] ?? "";
  const parts = [];
  if (serviceToken) parts.push("serviceToken=" + serviceToken);
  if (userId) parts.push("userId=" + userId);
  if (slh !== "" || map[sid + "_slh"] !== undefined) parts.push(sid + "_slh=" + slh);
  if (ph !== "" || map[sid + "_ph"] !== undefined) parts.push(sid + "_ph=" + ph);
  const cookie = parts.join("; ");
  return {
    cookie,
    serviceToken,
    userId,
    slh,
    ph,
    cookieNames: cookie
      .split(";")
      .map(part => part.trim().split("=")[0])
      .filter(Boolean),
  };
}

export function passCookieHeader({ passToken, userId, cUserId }) {
  const parts = [];
  if (passToken) parts.push("passToken=" + passToken);
  if (userId) parts.push("userId=" + userId);
  if (cUserId) parts.push("cUserId=" + cUserId);
  return parts.join("; ");
}

export function hasPassCredentials(creds) {
  const userId = creds?.userId || creds?.passUserId || "";
  return Boolean(creds && typeof creds.passToken === "string" && creds.passToken.trim() && String(userId).trim());
}

/**
 * Xiaomi account SSO refresh: passToken -> serviceLogin(sid) -> business cookies.
 * Returns a ready-to-use chat gateway Cookie header.
 */
export async function refreshServiceToken({
  passToken,
  userId,
  cUserId = "",
  sid = DEFAULT_SID,
  ssoUrl = DEFAULT_SSO_URL,
  userAgent = DEFAULT_SSO_USER_AGENT,
  fetchImpl = fetch,
  signal,
} = {}) {
  if (!hasPassCredentials({ passToken, userId })) {
    throw new ProxyError(503, "auth_error", "SSO refresh requires passToken and userId");
  }
  if (!sid || typeof sid !== "string") {
    throw new ProxyError(503, "auth_error", "SSO refresh requires auth.sid");
  }

  const url = new URL(ssoUrl);
  url.searchParams.set("_locale", "zh_CN");
  url.searchParams.set("_snsNone", "true");
  url.searchParams.set("sid", sid);
  url.searchParams.set("_json", "true");

  let phase1;
  try {
    phase1 = await fetchImpl(url, {
      method: "GET",
      headers: {
        "User-Agent": userAgent,
        Cookie: passCookieHeader({ passToken, userId, cUserId }),
        Accept: "*/*",
      },
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new ProxyError(502, "auth_error", "SSO serviceLogin request failed: " + (error?.message || error));
  }

  const phase1Text = await phase1.text().catch(() => "");
  const parsed = parseServiceLoginBody(phase1Text);
  if (!phase1.ok || parsed.code !== 0 || !parsed.location || !parsed.nonce || !parsed.ssecurity) {
    throw new ProxyError(502, "auth_error",
      "SSO serviceLogin failed for sid=" + sid +
      (parsed.code !== null && parsed.code !== undefined ? " code=" + parsed.code : "") +
      (parsed.description ? " " + parsed.description : "") +
      (parsed.result ? " result=" + parsed.result : "")
    );
  }

  const sign = clientSign(parsed.nonce, parsed.ssecurity);
  const phase2Url = parsed.location + (parsed.location.includes("?") ? "&" : "?") + "clientSign=" + sign;
  let phase2;
  try {
    phase2 = await fetchImpl(phase2Url, {
      method: "GET",
      headers: { "User-Agent": userAgent, Accept: "*/*" },
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new ProxyError(502, "auth_error", "SSO sts request failed: " + (error?.message || error));
  }

  if (!phase2.ok) {
    throw new ProxyError(502, "auth_error", "SSO sts returned HTTP " + phase2.status);
  }

  const setCookie = parseSetCookies(phase2.headers);
  const composed = composeServiceCookie(setCookie, { sid, fallbackUserId: userId });
  if (!composed.serviceToken) {
    throw new ProxyError(502, "auth_error", "SSO sts response did not include serviceToken for sid=" + sid);
  }

  const renewal = parsePassTokenRenewal(phase1.headers, {
    fallbackPassToken: passToken,
    fallbackUserId: userId,
    fallbackCUserId: cUserId,
  });
  // Body may carry the same passToken; expiry from Set-Cookie is what we persist.
  const bodyPassToken = phase1Text.match(/"passToken"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1];
  if (bodyPassToken) renewal.passToken = bodyPassToken.replaceAll("\\/", "/");

  return {
    sid,
    cookie: composed.cookie,
    serviceToken: composed.serviceToken,
    userId: composed.userId,
    cookieNames: composed.cookieNames,
    locationHost: (() => { try { return new URL(parsed.location).host; } catch { return ""; } })(),
    passToken: renewal.passToken,
    passUserId: renewal.userId,
    passCUserId: renewal.cUserId,
    passTokenExpiresAt: renewal.passTokenExpiresAt,
    passTokenMaxAgeSec: renewal.passTokenMaxAgeSec,
    passTokenRenewed: renewal.passTokenRenewed,
  };
}
