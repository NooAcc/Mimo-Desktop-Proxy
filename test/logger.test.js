import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLogger, readLogConfig } from "../lib/logger.js";
import { readConfig } from "../mimo_server.js";

function capture() {
  const stdout = [], stderr = [];
  return { stdout, stderr, console: { log: line => stdout.push(line), error: line => stderr.push(line) } };
}

async function directory(t) {
  const root = path.resolve(os.tmpdir());
  const result = await fs.mkdtemp(path.join(root, "mimo-logger-test-"));
  assert.equal(path.dirname(result), root);
  t.after(() => fs.rm(result, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50
  }));
  return result;
}

const records = async file => (await fs.readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));

test("Logging configuration supplies defaults, resolves paths, and rejects invalid settings", () => {
  const cwd = path.resolve("config-test");
  assert.deepEqual(readLogConfig({}, cwd), { level: "info", format: "json", file: "", maxBytes: 10485760, maxFiles: 5 });
  const settings = { logging: { level: " DEBUG ", format: "JSON", file: "logs/proxy.log", maxBytes: "4096", maxFiles: "0" } };
  const config = readConfig(settings, cwd).logging;
  assert.deepEqual(config, { level: "debug", format: "json", file: path.join(cwd, "logs", "proxy.log"), maxBytes: 4096, maxFiles: 0 });
  for (const [key, value] of [
    ["level", "verbose"], ["format", "xml"], ["maxBytes", "0"],
    ["maxBytes", "Infinity"], ["maxFiles", "-1"], ["maxFiles", "1.5"]
  ]) assert.throws(() => readConfig({ logging: { [key]: value } }), new RegExp("logging\\." + key));
});

test("Logger filters levels and routes warnings/errors to standard error", async () => {
  const output = capture();
  const logger = createLogger({ level: "warn", format: "json", console: output.console });
  logger.debug("hidden debug");
  logger.info("hidden info");
  logger.warn("request.failed", { status: 401 });
  logger.error("server.error", { errorCode: "EADDRINUSE" });
  await logger.close();
  assert.deepEqual(output.stdout, []);
  const entries = output.stderr.map(line => JSON.parse(line));
  assert.deepEqual(entries.map(entry => entry.level), ["warn", "error"]);
  assert.equal(entries[0].status, 401);
  assert.equal(entries[1].errorCode, "EADDRINUSE");
  assert.ok(Number.isFinite(Date.parse(entries[0].timestamp)));
});

test("Text logs stay on one line and preserve readable metadata", async () => {
  const output = capture();
  const logger = createLogger({ format: "text", console: output.console });
  logger.info("line one\nline two\r\n", { path: "/health", durationMs: 1.25 });
  await logger.close();
  assert.equal(output.stdout.length, 1);
  assert.equal(/[\r\n]/.test(output.stdout[0]), false);
  assert.match(output.stdout[0], / INFO line one\\nline two\\r\\n /);
  assert.match(output.stdout[0], /"path":"\/health","durationMs":1.25/);
});

test("Logger redacts nested credentials/content, handles circular fields, and prevents record spoofing", async () => {
  const output = capture();
  const logger = createLogger({ format: "json", console: output.console });
  const fields = {
    authorization: "private-auth", cookie: "private-cookie", nested: { api_key: "private-key", access_token: "private-token" },
    requestBody: "private-body", messages: ["private-message"], input: "private-input", content: "private-output",
    amount: 12n, error: new Error("example failure"), level: "spoofed", timestamp: "spoofed", message: "spoofed",
    toJSON() { throw new Error("User serializers must not run"); }
  };
  fields.circular = fields;
  logger.info("safe event", fields);
  await logger.close();
  const entry = JSON.parse(output.stdout[0]);
  assert.equal(entry.level, "info");
  assert.equal(entry.message, "safe event");
  assert.equal(entry.cookie, "[Redacted]");
  assert.equal(entry.nested.api_key, "[Redacted]");
  assert.equal(entry.circular, "[Circular]");
  assert.equal(entry.amount, "12");
  assert.equal(entry.error.message, "example failure");
  assert.equal(output.stdout[0].includes("private-"), false);
  assert.equal(fields.cookie, "private-cookie");
});

test("Silent logging does not create a file or emit console output", async t => {
  const output = capture();
  const file = path.join(await directory(t), "silent.log");
  const logger = createLogger({ level: "silent", file, console: output.console });
  for (const level of ["debug", "info", "warn", "error"]) logger[level]("hidden");
  await logger.close();
  assert.deepEqual(output.stdout, []);
  assert.deepEqual(output.stderr, []);
  await assert.rejects(fs.access(file), { code: "ENOENT" });
});

test("File logging creates directories, appends ordered JSONL, and flushes on close", async t => {
  const file = path.join(await directory(t), "nested", "proxy.log");
  const output = capture();
  const logger = createLogger({ file, console: output.console });
  for (let index = 0; index < 20; index++) logger.info("record", { index });
  await logger.flush();
  assert.deepEqual((await records(file)).map(entry => entry.index), Array.from({ length: 20 }, (_, i) => i));
  logger.warn("last record", { index: 20 });
  await logger.close();
  logger.error("after close");
  const second = createLogger({ file, console: output.console });
  second.info("next run", { index: 21 });
  await second.close();
  assert.deepEqual((await records(file)).map(entry => entry.index), Array.from({ length: 22 }, (_, i) => i));
});

test("File rotation counts UTF-8 bytes, rotates existing files, and bounds backup retention", async t => {
  const root = await directory(t);
  const file = path.join(root, "proxy.log");
  await fs.writeFile(file, JSON.stringify({ index: -1, message: "existing record".repeat(6) }) + "\n");
  const output = capture();
  const logger = createLogger({ file, maxBytes: 300, maxFiles: 2, console: output.console });
  logger.info("汉".repeat(50), { index: 0 });
  await logger.flush();
  assert.equal((await records(file + ".1"))[0].index, -1);
  for (let index = 1; index < 4; index++) logger.info("汉".repeat(50), { index });
  await logger.close();
  assert.deepEqual((await fs.readdir(root)).sort(), ["proxy.log", "proxy.log.1", "proxy.log.2"]);
  for (const [suffix, index] of [["", 3], [".1", 2], [".2", 1]]) {
    assert.equal((await records(file + suffix))[0].index, index);
    assert.ok((await fs.stat(file + suffix)).size <= 300);
  }
});

test("Rotation with zero backups retains an oversized record intact", async t => {
  const root = await directory(t);
  const file = path.join(root, "proxy.log");
  const logger = createLogger({ file, maxBytes: 1, maxFiles: 0, console: capture().console });
  logger.info("first record");
  logger.info("second record");
  await logger.close();
  assert.deepEqual(await fs.readdir(root), ["proxy.log"]);
  assert.equal((await records(file))[0].message, "second record");
});

test("A file failure reports once and leaves console logging usable", async t => {
  const blocker = path.join(await directory(t), "not-a-directory");
  await fs.writeFile(blocker, "blocker");
  const output = capture();
  const logger = createLogger({ file: path.join(blocker, "proxy.log"), format: "json", console: output.console });
  logger.info("first");
  logger.info("second");
  await logger.flush();
  logger.info("still available");
  await logger.close();
  assert.equal(output.stdout.length, 3);
  assert.equal(output.stderr.length, 1);
  assert.equal(JSON.parse(output.stderr[0]).message, "logger.file_error");
  assert.equal(output.stderr[0].includes(blocker), false);
});

test("A failing console sink does not prevent file logging", async t => {
  const file = path.join(await directory(t), "proxy.log");
  const fail = () => { throw new Error("closed console"); };
  const logger = createLogger({ file, console: { log: fail, error: fail } });
  assert.doesNotThrow(() => logger.info("saved"));
  await logger.close();
  assert.equal((await records(file))[0].message, "saved");
});

test("A saturated file queue drops excess records with one warning and recovers after flush", async t => {
  const file = path.join(await directory(t), "proxy.log");
  const output = capture();
  const logger = createLogger({ file, format: "json", maxPendingBytes: 256, console: output.console });
  for (let index = 0; index < 10; index++) logger.info("record", { index });
  await logger.flush();
  logger.info("recovered", { index: 99 });
  await logger.close();
  const saved = await records(file);
  assert.equal(saved[0].index, 0);
  assert.equal(saved.at(-1).index, 99);
  assert.ok(saved.length < 11);
  assert.equal(output.stdout.length, 11);
  assert.equal(output.stderr.length, 1);
  assert.equal(JSON.parse(output.stderr[0]).message, "logger.queue_full");
});
