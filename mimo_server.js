import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readSSE, SSEProtocolError } from "./lib/sse.js";
import { CompletionAccumulator } from "./lib/completion.js";
import { ProxyError } from "./lib/errors.js";
import { buildResponsesRequest } from "./lib/responses.js";
import { ResponsesAccumulator, encodeResponseEvent } from "./lib/responses-stream.js";
import { ToolCallFilter } from "./lib/tool-arguments.js";
import { createLogger } from "./lib/logger.js";
import { createHttp2Fetch } from "./lib/http2-fetch.js";
import { CLIENT_VERSION, DEFAULT_MODEL, readConfig, loadConfig } from "./lib/config.js";
import {
  createAuthRuntime, hydrateAuthRuntime, persistAuthUpdate, publicAuthStatus,
  readAuthFile, discoverAuthAccounts, planAccountPorts,
} from "./lib/auth-runtime.js";
import { createAutoAuthProvider } from "./lib/auto-auth.js";
import { refreshServiceToken, DEFAULT_SID } from "./lib/sso-refresh.js";
import { createClientVersionRefresher } from "./lib/client-version.js";
export { ProxyError } from "./lib/errors.js";
export { UPSTREAM_URL, UPSTREAM_URL as DEFAULT_UPSTREAM_URL, CLIENT_VERSION, CONFIG_DIRNAME, CONFIG_FILENAME, AUTH_ACCOUNT_FILENAME_RE, DEFAULT_CLIENT_VERSION_MANIFEST_URL, readConfig, loadConfig, resolveConfigPaths, persistSharedIdentity } from "./lib/config.js";
export {
  createAuthRuntime, hydrateAuthRuntime, readAuthFile, authFileNameForUserId,
  discoverAuthAccounts, planAccountPorts,
} from "./lib/auth-runtime.js";
export { createAutoAuthProvider } from "./lib/auto-auth.js";
export { refreshServiceToken, DEFAULT_SID } from "./lib/sso-refresh.js";
export { createClientVersionRefresher, fetchCloudClientVersion, nextClientVersionRefreshDelayMs } from "./lib/client-version.js";

const HOP_HEADERS = new Set(["host", "content-length", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

export function createAuthHeaders(cookie, { source = "mimocode-cli-free", clientVersion = CLIENT_VERSION } = {}) {
  if (!cookie?.trim()) {
    throw new ProxyError(503, "auth_error", "No MiMo credentials: put auth-<userId>.json in the account config directory");
  }
  try {
    return new Headers({
      cookie: cookie.trim(),
      "content-type": "application/json",
      accept: "text/event-stream",
      "accept-encoding": "identity",
      "x-mimo-source": source,
      "x-client-version": clientVersion
    });
  } catch {
    throw new ProxyError(500, "auth_error", "Configured MiMo authentication headers are invalid");
  }
}

export async function getAuthHeaders(config = readConfig(), { fetchImpl = fetch, signal } = {}) {
  if (typeof config === "string") config = { ...readConfig({}), authFile: config };
  const runtime = config.authRuntime;
  let cookie = (runtime?.cookie || config.cookie || "").trim();
  if (!cookie && config.authFile) {
    const stored = await readAuthFile(config.authFile);
    cookie = (stored?.cookie || "").trim();
  }
  const headerConfig = {
    ...config,
    source: runtime?.source || config.source,
    clientVersion: runtime?.clientVersion || config.clientVersion,
  };
  if (cookie || !config.mitmUrl) return createAuthHeaders(cookie, headerConfig);

  // Capture lookup is an optional fallback, never part of the default startup path.
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), config.authTimeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(config.mitmUrl, {
      headers: config.mitmAuth ? { Authorization: config.mitmAuth } : {}, signal: controller.signal
    });
    if (!response.ok) throw new Error("Capture endpoint returned an error");
    const flows = await response.json();
    if (!Array.isArray(flows)) throw new Error("Capture endpoint must return an array");
    const upstream = new URL(config.upstreamUrl);
    const target = [...flows].reverse().find(flow => {
      const request = flow.request;
      return request && flow.response?.status_code === 200 &&
        (request.host || request.pretty_host) === upstream.hostname &&
        request.path?.split("?")[0] === upstream.pathname;
    });
    if (!Array.isArray(target?.request.headers)) throw new Error("No matching successful capture");
    const headers = new Headers(), cookies = [];
    for (const [name, value] of target.request.headers) {
      const key = String(name).toLowerCase();
      if (key === "cookie") cookies.push(String(value));
      else if (!key.startsWith(":") && !HOP_HEADERS.has(key)) headers.set(key, String(value));
    }
    if (cookies.length) headers.set("cookie", cookies.join("; "));
    if (!headers.get("cookie") && !headers.get("authorization")) throw new Error("Capture has no credentials");
    headers.set("content-type", "application/json");
    headers.set("accept", "text/event-stream");
    headers.set("accept-encoding", "identity");
    if (!headers.has("x-mimo-source")) headers.set("x-mimo-source", headerConfig.source);
    headers.set("x-client-version", headerConfig.clientVersion);
    return headers;
  } catch {
    if (signal?.aborted) throw signal.reason;
    throw new ProxyError(503, "auth_error", "No usable MiMo credentials: check auth-<userId>.json or the configured MITM_URL");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
    };
    const fail = error => { cleanup(); reject(error); };
    const onData = chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limit) {
        fail(new ProxyError(413, "invalid_request_error", "Request body is too large"));
        req.resume();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        resolve(JSON.parse(text || "{}"));
      } catch { reject(new ProxyError(400, "invalid_request_error", "Request body must contain valid UTF-8 JSON")); }
    };
    const onAborted = () => fail(new ProxyError(400, "invalid_request_error", "Client aborted the request"));
    const onError = error => fail(error);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
  });
}

export function buildUpstreamBody(body, { defaultModel = DEFAULT_MODEL } = {}) {
  const invalid = message => { throw new ProxyError(400, "invalid_request_error", message); };
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("Request body must be an object");
  if (!Array.isArray(body.messages) || body.messages.length === 0) invalid("messages must be a non-empty array");
  if (body.messages.some(message => !message || typeof message !== "object" || Array.isArray(message) || typeof message.role !== "string")) {
    invalid("Every message must be an object with a role");
  }
  if (body.model !== undefined && (typeof body.model !== "string" || !body.model.trim())) invalid("model must be a non-empty string");
  if (body.stream !== undefined && typeof body.stream !== "boolean") invalid("stream must be a boolean");
  if (body.reasoning_effort !== undefined && (typeof body.reasoning_effort !== "string" || !body.reasoning_effort)) {
    invalid("reasoning_effort must be a non-empty string");
  }
  if (body.stream_options !== undefined && (!body.stream_options || typeof body.stream_options !== "object" || Array.isArray(body.stream_options))) {
    invalid("stream_options must be an object");
  }

  const upstream = { ...body, model: body.model || defaultModel, stream: true };
  if (upstream.model === "mimo-auto") upstream.model = "mimo-pro";
  if (typeof body.thinking === "boolean" || body.thinking === undefined) {
    upstream.reasoning_effort = body.reasoning_effort || (body.thinking ? "high" : "medium");
    delete upstream.thinking;
  }
  return upstream;
}

function jsonResponse(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// Text tool calls are only reconstructed for tools the client declared, and the declared
// schema tells us which recovered parameters are numbers or nested JSON.
function toolSchema(definition) {
  return definition?.tool?.function?.parameters ?? definition?.parameters ??
    definition?.tool?.parameters ?? definition?.tool?.input_schema ?? definition?.input_schema;
}

function declaredTools(body, converted) {
  if (converted?.tools instanceof Map) {
    return new Map([...converted.tools].map(([name, definition]) => [name, toolSchema(definition)]));
  }
  const tools = new Map();
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    const name = tool?.function?.name ?? (tool?.type ? undefined : tool?.name);
    if (typeof name === "string") tools.set(name, tool?.function?.parameters ?? (tool?.type ? undefined : tool?.parameters));
  }
  for (const fn of Array.isArray(body?.functions) ? body.functions : []) {
    if (typeof fn?.name === "string") tools.set(fn.name, fn.parameters);
  }
  return tools;
}

function errorMessage(data, fallback) {
  const error = data?.error ?? data;
  if (typeof error === "string") return error.slice(0, 2048);
  return String(error?.message || error?.msg || fallback).slice(0, 2048);
}

function sendError(res, error) {
  if (res.destroyed || res.writableEnded) return;
  const status = error instanceof ProxyError ? error.status : 500;
  const payload = { error: {
    message: error.message || "Internal error",
    type: error instanceof ProxyError ? error.type : "internal_error",
    ...(error.param !== undefined ? { param: error.param } : {}),
    ...(error.code !== undefined ? { code: error.code } : {})
  } };
  if (res.headersSent) {
    res.end("data: " + JSON.stringify(payload) + "\n\ndata: [DONE]\n\n");
  } else {
    if (status === 413) res.setHeader("Connection", "close");
    jsonResponse(res, status, payload);
  }
}

async function writeChunk(res, data, signal) {
  if (signal.aborted) throw signal.reason;
  if (res.destroyed || res.writableEnded) throw new Error("Client connection closed");
  if (res.write(data)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("Client connection closed")); };
    const onError = error => { cleanup(); reject(error); };
    const onAbort = () => { cleanup(); reject(signal.reason); };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function requireApiKey(req, apiKey) {
  if (!apiKey) return;
  const expected = Buffer.from("Bearer " + apiKey);
  const actual = Buffer.from(req.headers.authorization || "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ProxyError(401, "authentication_error", "Invalid proxy API key");
  }
}

function rememberFailure(context, error, code = error?.code || error?.cause?.code) {
  context.errorStatus = error instanceof ProxyError ? error.status : 500;
  context.errorType = error instanceof ProxyError ? error.type : "internal_error";
  // Error messages can echo credentials or user content from the upstream response.
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) context.errorCode = code;
}

const elapsed = start => Math.round((performance.now() - start) * 100) / 100;

export function createProxyServer({
  config = readConfig(), fetchImpl, authProvider = getAuthHeaders, logger,
  timeoutMs = config.timeoutMs,
  // 局域网可信：默认不限制请求体 / Responses 累计输出体积。
  maxBodyBytes = Number.POSITIVE_INFINITY,
  maxResponseBytes = Number.POSITIVE_INFINITY,
  authRuntime = createAuthRuntime({ clientVersion: config.clientVersion, source: config.source, sid: config.sid }),
  // Pass null to disable the SSO auto-auth wrapper (tests / custom providers).
  autoAuth,
  refreshImpl,
  ssoFetchImpl,
  clientVersionRefresher,
} = {}) {
  const ownsLogger = !logger;
  const log = logger || createLogger(config.logging);
  const upstreamFetch = fetchImpl || createHttp2Fetch();
  const authFetch = fetchImpl || fetch;
  const modelsCreated = Math.floor(Date.now() / 1000);
  const liveAuthConfig = () => authRuntime.applyTo({ ...config, authRuntime });
  const baseAuthProvider = authProvider || getAuthHeaders;
  const versionRefresher = clientVersionRefresher === null
    ? null
    : (clientVersionRefresher || createClientVersionRefresher({
        config,
        authRuntime,
        logger: log,
        persist: persistAuthUpdate,
        fetchImpl: ssoFetchImpl || fetch,
      }));
  const autoAuthProvider = autoAuth === null
    ? null
    : (autoAuth || createAutoAuthProvider({
        config, authRuntime, logger: log,
        baseAuth: baseAuthProvider,
        persist: persistAuthUpdate,
        refreshImpl,
        ssoFetchImpl,
        clientVersionRefresher: versionRefresher,
      }));
  const resolveHeaders = (options) =>
    autoAuthProvider
      ? autoAuthProvider.auth(liveAuthConfig(), options)
      : baseAuthProvider(liveAuthConfig(), options);
  async function chat(req, res, context, protocol = "chat") {
    const body = await readJsonBody(req, maxBodyBytes);
    const converted = protocol === "responses" ? buildResponsesRequest(body) : null;
    const upstreamBody = buildUpstreamBody(converted?.request ?? body, config);
    const streaming = body.stream === true;
    Object.assign(context, { protocol, model: upstreamBody.model, stream: streaming });
    const responses = converted ? new ResponsesAccumulator({
      request: body, tools: converted.tools, responseTools: converted.responseTools,
      model: upstreamBody.model, reasoningEffort: upstreamBody.reasoning_effort,
      streaming, maxBytes: maxResponseBytes
    }) : null;
    const controller = new AbortController();
    const onClose = () => { if (!res.writableFinished) controller.abort(new Error("Client connection closed")); };
    res.once("close", onClose);
    // timeoutMs <= 0 disables the proxy-side upstream timeout.
    const timer = timeoutMs > 0
      ? setTimeout(() => controller.abort(new ProxyError(504, "upstream_timeout", "MiMo upstream request timed out")), timeoutMs)
      : null;
    timer?.unref?.();

    try {
      let headers = await resolveHeaders({ fetchImpl: authFetch, signal: controller.signal });
      const upstreamStart = performance.now();
      log.debug?.("upstream.request", { requestId: context.requestId, protocol, model: upstreamBody.model, stream: streaming });
      const callUpstream = (authHeaders) => upstreamFetch(config.upstreamUrl, {
        method: "POST", headers: authHeaders, body: JSON.stringify(upstreamBody), signal: controller.signal
      });
      let upstream = await callUpstream(headers);
      context.upstreamStatus = upstream.status;
      log.debug?.("upstream.response", { requestId: context.requestId, status: upstream.status, httpVersion: upstream.httpVersion, durationMs: elapsed(upstreamStart) });

      // One automatic SSO refresh + retry when the chat gateway rejects stale cookies.
      if (upstream.status === 401 && autoAuthProvider) {
        try {
          await autoAuthProvider.refresh({ reason: "upstream_401", signal: controller.signal });
          headers = await resolveHeaders({ fetchImpl: authFetch, signal: controller.signal });
          try { await upstream.body?.cancel?.(); } catch { /* ignore */ }
          upstream = await callUpstream(headers);
          context.upstreamStatus = upstream.status;
          context.authRefreshed = true;
          log.debug?.("upstream.retry_after_sso", { requestId: context.requestId, status: upstream.status });
        } catch (refreshError) {
          log.warn?.("auth.sso_refresh_failed", {
            requestId: context.requestId,
            reason: "upstream_401",
            detail: refreshError?.message || String(refreshError),
          });
        }
      }

      if (!upstream.ok) {
        const text = await upstream.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        throw new ProxyError(upstream.status, "upstream_error", errorMessage(data, "Upstream HTTP " + upstream.status));
      }

      const accumulator = new CompletionAccumulator(upstreamBody.model, { aggregate: !streaming && !responses });
      const toolArguments = new ToolCallFilter({ tools: declaredTools(body, converted) });
      const reportToolArguments = diagnostics => {
        for (const item of diagnostics) {
          context.toolArgumentAction = item.action;
          const fields = { requestId: context.requestId, ...item };
          if (item.action === "invalid") log.warn("tool_arguments.invalid", fields);
          else log.debug?.("tool_arguments." + item.action, fields);
        }
      };
      let done = false;
      const writeEvents = async events => {
        if (!streaming || !events.length) return;
        if (!res.headersSent) res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive"
        });
        for (const event of events) await writeChunk(res, encodeResponseEvent(event), controller.signal);
      };
      const forward = async chunk => {
        let normalized;
        try { normalized = accumulator.add(chunk); }
        catch (error) { throw new ProxyError(502, "upstream_error", error.message); }
        if (responses) {
          await writeEvents(responses.add(normalized));
          return;
        }
        if (streaming) {
          if (!res.headersSent) res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive"
          });
          await writeChunk(res, "data: " + JSON.stringify(normalized) + "\n\n", controller.signal);
        }
      };
      const emit = async chunk => {
        const filtered = toolArguments.push(chunk);
        reportToolArguments(filtered.diagnostics);
        for (const item of filtered.chunks) await forward(item);
      };

      if (upstream.headers.get("content-type")?.includes("application/json")) {
        const data = await upstream.json();
        if (data?.error || (data?.code !== undefined && data.code !== 0)) {
          throw new ProxyError(502, "upstream_error", errorMessage(data, "Upstream returned an error"));
        }
        await emit(data);
        done = true;
      } else {
        for await (const event of readSSE(upstream.body)) {
          const payload = event.data.trim();
          if (payload === "[DONE]") { done = true; break; }
          if (!payload) continue;
          let data;
          try { data = JSON.parse(payload); }
          catch { throw new ProxyError(502, "upstream_error", "Upstream SSE contains invalid JSON"); }
          if (event.event === "error" || data?.error || (data?.code !== undefined && data.code !== 0)) {
            throw new ProxyError(502, "upstream_error", errorMessage(data, "Upstream reported an error"));
          }
          await emit(data);
        }
      }

      const remaining = toolArguments.flush();
      reportToolArguments(remaining.diagnostics);
      for (const item of remaining.chunks) await forward(item);
      if (!accumulator.choices.size) throw new ProxyError(502, "upstream_error", "Upstream returned no choices");
      if (!done && !accumulator.finished) throw new ProxyError(502, "upstream_error", "Upstream stream ended before completion");
      if (responses) {
        await writeEvents(responses.finish());
        if (streaming) res.end();
        else jsonResponse(res, 200, responses.result());
      } else if (streaming) {
        await writeChunk(res, "data: [DONE]\n\n", controller.signal);
        res.end();
      } else {
        jsonResponse(res, 200, accumulator.result());
      }
    } catch (error) {
      if (res.destroyed) return;
      if (controller.signal.aborted) error = controller.signal.reason;
      const code = error?.code || error?.cause?.code;
      if (error instanceof SSEProtocolError) error = new ProxyError(502, "upstream_error", error.message);
      if (!(error instanceof ProxyError)) error = new ProxyError(502, "upstream_error", error?.message || "Upstream request failed");
      rememberFailure(context, error, code);
      if (responses && res.headersSent) res.end(responses.fail(error).map(encodeResponseEvent).join(""));
      else sendError(res, error);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      res.off("close", onClose);
    }
  }

  async function handle(req, res, context) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    let url;
    try { url = new URL(req.url || "/", "http://localhost"); }
    catch { throw new ProxyError(400, "invalid_request_error", "Invalid request URL"); }
    if (req.method === "GET" && ["/", "/health"].includes(url.pathname)) {
      jsonResponse(res, 200, {
        status: "ok",
        service: "mimo-openai-proxy",
        account: {
          id: config.accountId || null,
          userId: config.accountUserId || authRuntime.passUserId || null,
          port: config.port ?? null,
          authFile: config.authFile || null,
        },
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/auth/status") {
      jsonResponse(res, 200, {
        ok: true,
        service: "mimo-openai-proxy",
        auth: publicAuthStatus(config, authRuntime),
      });
      return;
    }
    requireApiKey(req, config.apiKey);
    if (req.method === "GET" && url.pathname === "/v1/models") {
      jsonResponse(res, 200, { object: "list", data: config.models.map(id => ({
        id, object: "model", created: modelsCreated, owned_by: "xiaomi"
      })) });
      return;
    }
    if (req.method === "POST" && ["/v1/chat/completions", "/chat/completions"].includes(url.pathname)) {
      await chat(req, res, context);
      return;
    }
    if (req.method === "POST" && ["/v1/responses", "/responses"].includes(url.pathname)) {
      await chat(req, res, context, "responses");
      return;
    }
    throw new ProxyError(404, "invalid_request_error", "Not found");
  }

  const server = http.createServer((req, res) => {
    const start = performance.now();
    let pathname;
    try { pathname = new URL(req.url || "/", "http://localhost").pathname; }
    catch { pathname = "<invalid>"; }
    const context = { requestId: randomUUID(), method: req.method, path: pathname };
    res.setHeader("X-Request-Id", context.requestId);
    let recorded = false;
    const complete = aborted => {
      if (recorded) return;
      recorded = true;
      if (aborted) Object.assign(context, { errorStatus: 499, errorType: "client_disconnected" });
      const status = res.headersSent ? res.statusCode : null;
      const failureStatus = context.errorStatus || status;
      const failed = context.errorStatus !== undefined || status >= 400;
      const severity = aborted ? "warn" : failed && failureStatus >= 500 ? "error" : failed ? "warn" : "info";
      const event = aborted ? "request.aborted" : failed ? "request.failed" : "request.completed";
      log[severity](event, { ...context, status, durationMs: elapsed(start) });
    };
    res.once("finish", () => complete(false));
    res.once("close", () => complete(!res.writableFinished));
    log.debug?.("request.started", context);
    handle(req, res, context).catch(error => {
      rememberFailure(context, error);
      sendError(res, error);
    });
  });
  server.on("listening", () => {
    const address = server.address();
    log.info("server.listening", {
      host: address.address, port: address.port,
      accountId: config.accountId || authRuntime.passUserId || null,
      accountUserId: config.accountUserId || authRuntime.passUserId || null,
      authFile: config.authFile || null,
      chatEndpoint: "/v1/chat/completions", responsesEndpoint: "/v1/responses",
      authStatusEndpoint: "/auth/status"
    });
  });
  server.on("error", error => log.error("server.error", { errorCode: error.code || "UNKNOWN" }));
  server.once("close", () => {
    if (!fetchImpl) upstreamFetch.close();
    versionRefresher?.stop?.();
    log.info("server.closed");
    if (ownsLogger) void log.close();
  });
  server.authRuntime = authRuntime;
  server.autoAuthProvider = autoAuthProvider;
  server.clientVersionRefresher = versionRefresher;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let logger = createLogger();
  const servers = [];
  try {
    const baseConfig = await loadConfig();
    logger = createLogger(baseConfig.logging);
    const accounts = await discoverAuthAccounts(baseConfig.configRoot);
    if (!accounts.length) {
      throw new Error(
        "No multi-account credentials found in " + baseConfig.configRoot +
        ". Expected auth-<userId>.json files (export with: npm run pass-token -- --save). " +
        "Legacy auth.json is no longer loaded."
      );
    }
    const planned = planAccountPorts(accounts, baseConfig.port);
    logger.info("multi_account.planned", {
      configRoot: baseConfig.configRoot,
      basePort: baseConfig.port,
      accounts: planned.map(item => ({
        id: item.id,
        userId: item.userId,
        fileName: item.fileName,
        port: item.port,
        ready: Boolean(item.hasCookie || item.hasPassToken),
      })),
    });
    for (const account of planned) {
      const accountConfig = {
        ...baseConfig,
        port: account.port,
        authFile: account.file,
        accountId: account.id,
        accountUserId: account.userId || account.id,
      };
      const authRuntime = await hydrateAuthRuntime(accountConfig);
      const server = createProxyServer({ config: accountConfig, logger, authRuntime });
      const started = await new Promise(resolve => {
        const onListenError = error => {
          logger.error("server.listen_failed", {
            accountId: account.id,
            port: account.port,
            errorCode: error.code || "UNKNOWN",
          });
          resolve(false);
        };
        server.once("error", onListenError);
        server.listen(account.port, baseConfig.host, () => {
          server.off("error", onListenError);
          resolve(true);
        });
      });
      if (!started) {
        try { server.close(); } catch { /* ignore */ }
        continue;
      }
      server.clientVersionRefresher?.start?.();
      servers.push(server);
    }
    if (!servers.length) {
      throw new Error("No account server started; check auth-*.json files and port availability");
    }
    const shutdown = signal => {
      logger.info("server.stopping", { signal, accounts: servers.length });
      for (const server of servers) {
        server.clientVersionRefresher?.stop?.();
        server.close();
        server.closeAllConnections?.();
      }
    };
    const onInterrupt = () => shutdown("SIGINT");
    const onTerminate = () => shutdown("SIGTERM");
    const cleanup = () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      void logger.close();
    };
    let closed = 0;
    for (const server of servers) {
      server.once("close", () => {
        closed += 1;
        if (closed === servers.length) cleanup();
      });
      server.once("error", () => { process.exitCode = 1; });
    }
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
  } catch (error) {
    logger.error("server.start_failed", { detail: error.message });
    await logger.close();
    process.exitCode = 1;
  }
}
