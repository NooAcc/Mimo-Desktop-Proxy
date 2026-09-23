import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { connectInspector } from "./cdp.js";

async function installCapture(options) {
  const require = process.getBuiltinModule("module").createRequire(process.execPath);
  const electron = require("electron");
  const account = electron.session.fromPartition("persist:xiaomi-account");
  if (globalThis.__mimoProxyCapture) throw new Error("A MiMo proxy capture is already active");
  const original = account.fetch;
  const state = {complete: false, record: null, error: null, probeId: options.probeId};
  globalThis.__mimoProxyCapture = state;
  const safeHeaders = new Set(["content-type", "accept", "accept-encoding", "content-length", "cache-control", "date", "server", "user-agent", "x-client-version", "x-mimo-source"]);
  const scrubHeaders = headers => Object.fromEntries([...new Headers(headers).entries()].map(([key, value]) => [key, safeHeaders.has(key) ? value : "[redacted]"]));
  const target = new URL("https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions");
  let secretValues = [];
  const redactText = text => {
    for (const value of secretValues) if (value.length >= 8) text = text.split(value).join("[redacted]");
    return text;
  };
  const scrub = (value, key = "") => {
    if (/cookie|authorization|password|secret|api.?key|access.?token|refresh.?token|service.?token|pass.?token|(?:^|_)user.?id$|account.?id|device.?id|signature/i.test(key)) return "[redacted]";
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map(item => scrub(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrub(item, name)]));
    return value;
  };
  const wrapper = async function(input, init) {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    const selected = url.origin === target.origin && url.pathname === target.pathname &&
      typeof init?.body === "string" && init.body.includes(options.probeId) && !state.record;
    if (!selected) return original.call(this, input, init);
    const started = Date.now();
    const cookies = await account.cookies.get({url: target.href});
    secretValues = cookies.map(cookie => cookie.value);
    let body;
    try {body = JSON.parse(init.body);} catch {body = "[non-JSON body]";}
    if (Array.isArray(body.messages)) {
      body.messages = body.messages.map(message => ({
        ...message,
        content: typeof message.content === "string" && message.content.includes(options.probeId) ? message.content : "[redacted client context]"
      }));
    }
    state.record = {
      capturedAt: new Date().toISOString(),
      source: "MiMo original chat -> Electron session.fetch, before native Cookie insertion; raw response body after HTTP decoding",
      appVersion: electron.app.getVersion(),
      request: {
        method: init.method || "GET", url: url.origin + url.pathname,
        headers: {...scrubHeaders(init.headers), cookie: "[managed by Electron session]"},
        cookieNames: cookies.map(cookie => cookie.name),
        body: scrub(body)
      }
    };
    let response;
    try {response = await original.call(this, input, init);}
    catch (error) {state.error = redactText(String(error.message)); state.complete = true; throw error;}
    state.record.response = {status: response.status, headers: scrubHeaders(response.headers), chunks: [], body: "", endedBy: null};
    const copy = response.clone();
    (async () => {
      const reader = copy.body.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) {state.record.response.body += decoder.decode(); state.record.response.endedBy = "eof"; break;}
          size += value.byteLength;
          if (size > Number.POSITIVE_INFINITY) throw new Error("Probe response exceeded limit");
          state.record.response.chunks.push({elapsedMs: Date.now() - started, bytes: value.byteLength});
          state.record.response.body += decoder.decode(value, {stream: true});
          if (/(?:^|\n)data:\s*\[DONE\]\r?\n\r?\n/.test(state.record.response.body)) {
            state.record.response.endedBy = "done-marker";
            void reader.cancel().catch(() => {});
            break;
          }
        }
      } catch (error) {state.error = redactText(String(error.message));}
      finally {
        state.record.response.body = redactText(state.record.response.body);
        state.complete = true;
      }
    })();
    return response;
  };
  account.fetch = wrapper;
  const timer = setTimeout(() => state.restore(), options.timeoutMs + 10000);
  timer.unref();
  state.restore = () => {
    clearTimeout(timer);
    if (account.fetch === wrapper) account.fetch = original;
    if (globalThis.__mimoProxyCapture === state) delete globalThis.__mimoProxyCapture;
  };
  let window;
  for (const candidate of electron.webContents.getAllWebContents()) {
    if (candidate.isDestroyed() || candidate.getType() !== "window") continue;
    if (await candidate.executeJavaScript('typeof window.mimo?.chat === "function"').catch(() => false)) {window = candidate; break;}
  }
  if (!window) {state.restore(); throw new Error("MiMo chat window is not ready");}
  state.window = window;
  const messages = [{role: "user", content: "请只回复 OK。这是接口兼容性测试，编号：" + options.probeId}];
  await window.executeJavaScript("window.mimo.chat(" + JSON.stringify(messages) + "," + JSON.stringify(options.model) + "," + JSON.stringify(options.probeId) + ")");
  return {installed: true, appVersion: electron.app.getVersion(), probeId: options.probeId};
}

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const port = Number(option("--port", "9222"));
const model = option("--model", "mimo-pro");
const timeoutMs = Number(option("--timeout-ms", "120000"));
const outputDir = path.resolve(option("--output-dir", "captures/client-" + new Date().toISOString().replace(/[:.]/g, "-")));
const inspector = await connectInspector(port);
let installed = false;
try {
  const options = {model, timeoutMs, probeId: "mimo-proxy-" + randomUUID()};
  await inspector.evaluate("(" + installCapture.toString() + ")(" + JSON.stringify(options) + ")");
  installed = true;
  console.log(JSON.stringify({capture: "started", model, timeoutMs}));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await inspector.evaluate("(() => { const s = globalThis.__mimoProxyCapture; return s ? {complete:s.complete,error:s.error,status:s.record?.response?.status,chunks:s.record?.response?.chunks.length} : null; })()");
    if (!status) throw new Error("Capture hook disappeared");
    if (status.complete) {
      const capture = await inspector.evaluate("({record:globalThis.__mimoProxyCapture.record,error:globalThis.__mimoProxyCapture.error})");
      if (!capture.record) throw new Error(capture.error || "No matching request was captured");
      await fs.mkdir(outputDir, {recursive: true});
      const record = capture.record;
      if (capture.error) record.captureError = capture.error;
      const text = record.response?.body || "";
      if (record.response) delete record.response.body;
      await fs.writeFile(path.join(outputDir, "trace.json"), JSON.stringify(record, null, 2) + "\n");
      await fs.writeFile(path.join(outputDir, "response.sse"), text);
      console.log(JSON.stringify({capture: "saved", outputDir, status: record.response?.status, chunks: record.response?.chunks.length, bytes: Buffer.byteLength(text), requestFields: Object.keys(record.request.body), error: capture.error}));
      if (capture.error || record.response?.status !== 200) process.exitCode = 1;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (Date.now() >= deadline) throw new Error("Timed out waiting for the original MiMo request");
} finally {
  if (installed) {
    await inspector.evaluate("(() => { const s = globalThis.__mimoProxyCapture; if (!s) return; if (!s.complete && s.window && !s.window.isDestroyed()) s.window.executeJavaScript('window.mimo.chatStop(' + JSON.stringify(s.probeId) + ')').catch(() => {}); s.restore(); })()").catch(() => {});
  }
  inspector.close();
}
