import fs from "node:fs/promises";
import path from "node:path";

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: Infinity });
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const SENSITIVE_KEY = /authorization|cookie|password|secret|token|apikey|body|messages|prompt|instructions|input|output|content|arguments|headers/i;

function choice(value, fallback, allowed, name) {
  const result = value?.trim().toLowerCase() || fallback;
  if (!allowed.includes(result)) throw new Error(name + " must be one of: " + allowed.join(", "));
  return result;
}

function integer(value, fallback, name, minimum) {
  if (value === undefined || value === "") return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) throw new Error(name + " must be an integer >= " + minimum);
  return result;
}

export function readLogConfig(settings = {}, cwd = process.cwd()) {
  return {
    level: choice(settings.level, "info", Object.keys(LEVELS), "logging.level"),
    format: choice(settings.format, "json", ["text", "json"], "logging.format"),
    file: settings.file?.trim() ? path.resolve(cwd, settings.file.trim()) : "",
    maxBytes: integer(settings.maxBytes, DEFAULT_MAX_BYTES, "logging.maxBytes", 1),
    maxFiles: integer(settings.maxFiles, 5, "logging.maxFiles", 0)
  };
}

function sanitize(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "string") return value.length > 2048 ? value.slice(0, 2048) + "[Truncated]" : value;
  if (typeof value === "bigint") return String(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= 5) return "[Truncated]";
  seen.add(value);
  const source = value instanceof Error ? { name: value.name, message: value.message, code: value.code } : value;
  const result = Array.isArray(source) ? [] : Object.create(null);
  for (const [key, item] of Object.entries(source).slice(0, 32)) {
    result[key] = SENSITIVE_KEY.test(key.replace(/[-_]/g, "")) ? "[Redacted]" : sanitize(item, seen, depth + 1);
  }
  seen.delete(value);
  return result;
}

function recordFor(level, message, fields) {
  let details;
  try { details = sanitize(fields); }
  catch { details = { logFieldsError: "Cannot serialize log fields" }; }
  const record = { timestamp: new Date().toISOString(), level, message: String(message).slice(0, 2048) };
  if (details && typeof details === "object" && !Array.isArray(details)) {
    for (const [key, value] of Object.entries(details)) {
      if (!Object.hasOwn(record, key)) Object.defineProperty(record, key, { value, enumerable: true });
    }
  }
  return record;
}

// One logger owns one file. Writes and rotations are serialized without blocking HTTP handlers.
export function createLogger({
  level = "info", format = "json", file = "", maxBytes = DEFAULT_MAX_BYTES, maxFiles = 5,
  console: output = globalThis.console, maxPendingBytes = 1024 * 1024
} = {}) {
  level = choice(level, "info", Object.keys(LEVELS), "LOG_LEVEL");
  format = choice(format, "json", ["text", "json"], "LOG_FORMAT");
  maxBytes = integer(maxBytes, DEFAULT_MAX_BYTES, "LOG_MAX_BYTES", 1);
  maxFiles = integer(maxFiles, 5, "LOG_MAX_FILES", 0);
  maxPendingBytes = integer(maxPendingBytes, 1024 * 1024, "maxPendingBytes", 1);
  let queue = Promise.resolve();
  let pendingBytes = 0;
  let fileBytes = 0;
  let initialized = false;
  let fileDisabled = false;
  let queueFullReported = false;
  let closed = false;

  function writeConsole(record) {
    try {
      const { timestamp, level: severity, message, ...fields } = record;
      const line = format === "json" ? JSON.stringify(record) :
        timestamp + " " + severity.toUpperCase() + " " + JSON.stringify(message).slice(1, -1) +
        (Object.keys(fields).length ? " " + JSON.stringify(fields) : "");
      output[severity === "warn" || severity === "error" ? "error" : "log"](line);
    } catch { /* Logging must not interrupt a request if a console sink is unavailable. */ }
  }

  async function remove(filename) {
    try { await fs.unlink(filename); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  async function rotate() {
    if (maxFiles === 0) await remove(file);
    else {
      await remove(file + "." + maxFiles);
      for (let index = maxFiles - 1; index >= 1; index--) {
        try { await fs.rename(file + "." + index, file + "." + (index + 1)); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      await fs.rename(file, file + ".1");
    }
    fileBytes = 0;
  }

  async function append(line, bytes) {
    if (fileDisabled) return;
    if (!initialized) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      try { fileBytes = (await fs.stat(file)).size; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      initialized = true;
    }
    // A single oversized record remains intact; the next record triggers rotation.
    if (fileBytes > 0 && fileBytes + bytes > maxBytes) await rotate();
    await fs.appendFile(file, line, { encoding: "utf8", mode: 0o600 });
    fileBytes += bytes;
  }

  function log(severity, message, fields) {
    if (closed || LEVELS[severity] < LEVELS[level]) return;
    const record = recordFor(severity, message, fields);
    writeConsole(record);
    if (!file || fileDisabled) return;
    const line = JSON.stringify(record) + "\n";
    const bytes = Buffer.byteLength(line);
    if (pendingBytes + bytes > maxPendingBytes) {
      if (!queueFullReported) writeConsole(recordFor("warn", "logger.queue_full", {
        detail: "File log queue is full; dropping file records until it drains"
      }));
      queueFullReported = true;
      return;
    }
    pendingBytes += bytes;
    queue = queue.then(() => append(line, bytes)).catch(error => {
      fileDisabled = true;
      writeConsole(recordFor("error", "logger.file_error", {
        detail: "File logging disabled; console logging remains available", errorCode: error.code || "UNKNOWN"
      }));
    }).finally(() => {
      pendingBytes -= bytes;
      if (pendingBytes < maxPendingBytes / 2) queueFullReported = false;
    });
  }

  return {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
    flush: () => queue,
    close: () => { closed = true; return queue; }
  };
}
