import http2 from "node:http2";
import { Readable, pipeline } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";

const HOP_HEADERS = new Set(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "http2-settings", "te", "content-length"]);
const error = (code, message) => Object.assign(new Error(message), { code });
const abortReason = signal => signal.reason || new DOMException("The request was aborted", "AbortError");

function waitForConnection(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortReason(signal)); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, failure => { cleanup(); reject(failure); });
  });
}

// Fetch-shaped transport for upstream JSON requests. Each origin has a reusable
// HTTP/2 session; cancelling a response cancels only that stream. TLS must
// negotiate h2. Plain HTTP uses h2c prior knowledge, never an HTTP/1.1 fallback.
export function createHttp2Fetch({ idleTimeoutMs = 30000, connectOptions = {} } = {}) {
  const sessions = new Map(), allSessions = new Set();
  let closed = false;

  function forget(entry) {
    if (sessions.get(entry.origin) === entry) sessions.delete(entry.origin);
    clearTimeout(entry.idleTimer);
  }

  function open(url) {
    const session = http2.connect(url.origin, { ...connectOptions, ALPNProtocols: ["h2"] });
    const entry = { origin: url.origin, session, users: 0, draining: false, idleTimer: null };
    sessions.set(url.origin, entry);
    allSessions.add(entry);
    entry.ready = new Promise((resolve, reject) => {
      session.once("connect", () => {
        if (url.protocol === "https:" && session.alpnProtocol !== "h2") {
          const failure = error("HTTP2_REQUIRED", "MiMo upstream must negotiate HTTP/2 (h2)");
          reject(failure);
          session.destroy(failure);
        } else resolve();
      });
      session.on("error", failure => { forget(entry); reject(failure); });
      session.once("close", () => {
        forget(entry);
        allSessions.delete(entry);
        reject(error("HTTP2_CLOSED", "Upstream HTTP/2 connection closed"));
      });
    });
    // A request may be cancelled while the shared connection is still opening.
    entry.ready.catch(() => {});
    session.on("goaway", () => {
      entry.draining = true;
      forget(entry);
      session.close();
    });
    return entry;
  }

  function release(entry) {
    if (--entry.users > 0) return;
    if (closed || entry.draining || entry.session.connecting) {
      forget(entry);
      entry.session.destroy();
      return;
    }
    if (entry.session.closed || entry.session.destroyed) return;
    entry.session.unref();
    entry.idleTimer = setTimeout(() => {
      forget(entry);
      entry.session.close();
    }, idleTimeoutMs);
    entry.idleTimer.unref();
  }

  async function acquire(url, signal) {
    while (true) {
      if (closed) throw error("HTTP2_CLIENT_CLOSED", "HTTP/2 transport is closed");
      if (signal?.aborted) throw abortReason(signal);
      let entry = sessions.get(url.origin);
      if (!entry || entry.draining || entry.session.closed || entry.session.destroyed) entry = open(url);
      entry.users++;
      clearTimeout(entry.idleTimer);
      entry.session.ref();
      try { await waitForConnection(entry.ready, signal); }
      catch (failure) { release(entry); throw failure; }
      if (signal?.aborted) { release(entry); throw abortReason(signal); }
      if (entry.draining || entry.session.closed || entry.session.destroyed) { release(entry); continue; }
      return entry;
    }
  }

  async function fetchHttp2(input, init = {}) {
    const url = new URL(input);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw new TypeError("HTTP/2 upstream requires an http(s) URL without embedded credentials");
    }
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body == null ? null : typeof init.body === "string" ? Buffer.from(init.body) : init.body;
    if (body !== null && !(body instanceof Uint8Array)) throw new TypeError("HTTP/2 upstream body must be text or bytes");
    const headers = new Headers(init.headers);
    const excluded = new Set([...HOP_HEADERS, ...(headers.get("connection") || "").toLowerCase().split(",").map(value => value.trim())]);
    const requestHeaders = { ":method": method, ":path": url.pathname + url.search };
    for (const [key, value] of headers) if (!key.startsWith(":") && !excluded.has(key)) requestHeaders[key] = value;
    if (body !== null) requestHeaders["content-length"] = String(body.byteLength);
    const entry = await acquire(url, init.signal);
    return new Promise((resolve, reject) => {
      let request, responded = false;
      const onAbort = () => {
        const failure = abortReason(init.signal);
        reject(failure);
        request?.close(http2.constants.NGHTTP2_CANCEL);
        request?.destroy(failure);
      };
      try { request = entry.session.request(requestHeaders, { endStream: body === null }); }
      catch (failure) { release(entry); reject(failure); return; }
      request.on("error", reject);
      request.once("close", () => {
        init.signal?.removeEventListener("abort", onAbort);
        release(entry);
        if (!responded) reject(error("HTTP2_STREAM_CLOSED", "Upstream stream closed before response headers"));
      });
      request.once("response", received => {
        try {
          const status = Number(received[":status"]);
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(received)) {
            if (key.startsWith(":")) continue;
            for (const part of Array.isArray(value) ? value : [value]) if (part != null) responseHeaders.append(key, String(part));
          }
          let source = request;
          const encoding = (responseHeaders.get("content-encoding") || "identity").trim().toLowerCase();
          const decompress = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[encoding];
          const noBody = method === "HEAD" || [204, 205, 304].includes(status);
          if (!noBody && encoding !== "identity") {
            if (!decompress) throw error("HTTP2_ENCODING", "Unsupported upstream content encoding");
            source = decompress();
            pipeline(request, source, () => {});
            responseHeaders.delete("content-encoding");
            responseHeaders.delete("content-length");
          }
          const response = new Response(noBody ? null : Readable.toWeb(source, {
            strategy: { highWaterMark: 1, size: chunk => chunk.byteLength }
          }), { status, headers: responseHeaders });
          Object.defineProperty(response, "httpVersion", { value: entry.session.alpnProtocol || "h2c" });
          responded = true;
          resolve(response);
          if (noBody) request.resume();
        } catch (failure) { reject(failure); request.close(http2.constants.NGHTTP2_CANCEL); }
      });
      init.signal?.addEventListener("abort", onAbort, { once: true });
      if (init.signal?.aborted) { onAbort(); return; }
      if (body !== null) request.end(body);
    });
  }

  fetchHttp2.close = () => {
    closed = true;
    for (const entry of allSessions) {
      forget(entry);
      entry.session.destroy();
    }
    sessions.clear();
  };
  return fetchHttp2;
}
