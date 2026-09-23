import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, readConfig, resolveConfigPaths, PROJECT_DIR } from "../lib/config.js";
import { parseToml } from "../lib/toml.js";

async function directory(t) {
  const root = path.resolve(os.tmpdir());
  const result = await fs.mkdtemp(path.join(root, "mimo-config-test-"));
  assert.equal(path.dirname(result), root);
  t.after(() => fs.rm(result, { recursive: true, force: true }));
  return result;
}

test("Missing config.toml and the unchanged example both use ready-to-run defaults", async t => {
  const root = await directory(t);
  const defaults = await loadConfig({}, root);
  assert.equal(defaults.host, "0.0.0.0");
  assert.equal(defaults.port, 3000);
  assert.equal(defaults.clientVersion, "26.914.142245");
  assert.deepEqual(defaults.models, ["mimo-v2.6-pro", "mimo-v2.6-flash"]);
  assert.equal(defaults.defaultModel, "mimo-v2.6-pro");
  // Discovery mode: CLI scans configRoot for auth-*.json; no default authFile.
  assert.equal(defaults.authFile, "");
  assert.equal(defaults.configTomlFile, path.join(root, "config", "config.toml"));
  assert.equal(defaults.cookie, "");
  assert.equal(defaults.apiKey, "");
  assert.equal(defaults.authUpdatePort, undefined);
  assert.equal(defaults.mitmUrl, "");
  assert.equal(defaults.logging.file, "");
  assert.equal(defaults.logging.format, "json");
  assert.equal(readConfig({}).authFile, "");
  assert.equal(readConfig({ configRoot: path.join(PROJECT_DIR, "config") }).authFile, "");
  assert.equal(
    readConfig({ authFile: "auth-1.json", configRoot: path.join(PROJECT_DIR, "config") }).authFile,
    path.join(PROJECT_DIR, "config", "auth-1.json")
  );
  await fs.copyFile(new URL("../config/config.toml.example", import.meta.url), path.join(root, "config.toml"));
  // 根目录有 config.toml 时回退到项目根布局。
  const fromExample = await loadConfig({}, root);
  assert.equal(fromExample.authFile, "");
  assert.equal(fromExample.configRoot, root);
  assert.deepEqual(fromExample.models, defaults.models);
  assert.equal(fromExample.port, defaults.port);
  assert.equal(fromExample.clientVersion, defaults.clientVersion);
});

test("config.toml supplies nested settings and program overrides win", async t => {
  const root = await directory(t);
  await fs.writeFile(path.join(root, "config.toml"), [
    "host = \"127.0.0.1\"",
    "port = 13000",
    "models = [\"mimo-v2.6-flash\", \" mimo-v2.6-pro \", \"mimo-v2.6-flash\"]",
    "apiKey = \"from-file\"",
    "",
    "[auth]",
    "clientVersion = \"custom-version\"",
    "source = \"file-source\"",
    "authFile = \"secrets/auth.json\"",
    "",
    "[upstream]",
    "url = \"https://example.test/from-file\"",
    "timeoutMs = 45000",
    "",
    "[logging]",
    "file = \"logs/proxy.log\"",
    "level = \"debug\""
  ].join("\n"));
  const config = await loadConfig({}, root);
  assert.equal(config.port, 13000);
  assert.equal(config.host, "127.0.0.1");
  assert.deepEqual(config.models, ["mimo-v2.6-flash", "mimo-v2.6-pro"]);
  assert.equal(config.defaultModel, "mimo-v2.6-flash");
  assert.equal(config.authFile, path.join(root, "secrets", "auth.json"));
  // Explicit authFile still works for programmatic single-pack use (tests/tools).
  // Credentials are intentionally NOT loaded from config.toml.
  assert.equal(config.cookie, "");
  assert.equal(config.passToken, undefined);
  assert.equal(config.logging.file, path.join(root, "logs", "proxy.log"));
  assert.equal(config.logging.level, "debug");
  assert.equal(config.clientVersion, "custom-version");
  assert.equal(config.source, "file-source");
  assert.equal(config.authUpdatePort, undefined);
  assert.equal(config.timeoutMs, 45000);
  assert.equal(config.apiKey, "from-file");
  assert.equal(config.upstreamUrl, "https://example.test/from-file");

  const overridden = await loadConfig({ models: ["environment-model", "second-model"], apiKey: "" }, root);
  assert.deepEqual(overridden.models, ["environment-model", "second-model"]);
  assert.equal(overridden.defaultModel, "environment-model");
  assert.equal(overridden.apiKey, "");
  const cleared = await loadConfig({ models: "" }, root);
  assert.deepEqual(cleared.models, ["mimo-v2.6-pro", "mimo-v2.6-flash"]);
});

test("Models accept ordered lists and comma strings, and empty values keep defaults", () => {
  for (const [value, expected] of [
    [undefined, ["mimo-v2.6-pro", "mimo-v2.6-flash"]],
    ["", ["mimo-v2.6-pro", "mimo-v2.6-flash"]],
    [" , , \t ", ["mimo-v2.6-pro", "mimo-v2.6-flash"]],
    [" single-model ", ["single-model"]],
    ["model-b,model-a", ["model-b", "model-a"]],
    [" model-b , , model-a, model-b, ", ["model-b", "model-a"]],
    [["model-b", "model-a", "model-b"], ["model-b", "model-a"]]
  ]) {
    const config = readConfig({ models: value });
    assert.deepEqual(config.models, expected);
    assert.equal(config.defaultModel, expected[0]);
  }
});

test("Empty options keep defaults, while invalid values fail without echoing secrets", () => {
  const config = readConfig({ port: "", host: "", models: "", clientVersion: "", timeoutMs: "", logging: { maxBytes: "" } });
  assert.equal(config.port, 3000);
  assert.equal(config.clientVersion, "26.914.142245");
  assert.equal(config.timeoutMs, 0);
  assert.equal(readConfig({ timeoutMs: 0 }).timeoutMs, 0);
  assert.equal(readConfig({ timeoutMs: "0" }).timeoutMs, 0);
  assert.equal(config.logging.maxBytes, 10485760);
  assert.equal(config.maxBodyBytes, undefined);
  assert.equal(config.maxResponseBytes, undefined);
  for (const [key, value] of [
    ["port", "65536"], ["port", "-1"], ["port", "invalid-secret"],
    ["timeoutMs", "-1"], ["timeoutMs", "2147483648"],
    ["authTimeoutMs", "-1"], ["authTimeoutMs", "0"],
    ["upstreamUrl", "invalid-secret"], ["mitmUrl", "file:///invalid-secret"]
  ]) assert.throws(() => readConfig({ [key]: value }), error => {
    assert.ok(error.message.includes(key.split(/(?=[A-Z])/).join(".").toLowerCase()) || error.message.includes(key) || /must be/.test(error.message));
    assert.equal(error.message.includes("invalid-secret"), false);
    return true;
  });
});

test("Unreadable and malformed config.toml report useful errors without disclosing credentials", async t => {
  const root = await directory(t);
  const file = path.join(root, "config.toml");
  await fs.mkdir(file);
  await assert.rejects(loadConfig({}, root), /Cannot read config\.toml/);
  await fs.rmdir(file);
  await fs.writeFile(file, "# valid\nport = \"invalid-secret\"\n");
  await assert.rejects(loadConfig({}, root), error => {
    assert.match(error.message, /port must be an integer/);
    assert.equal(error.message.includes("invalid-secret"), false);
    return true;
  });
  await fs.writeFile(file, "not-valid-toml-line\n");
  await assert.rejects(loadConfig({}, root), /Invalid TOML/);
});

test("resolveConfigPaths prefers the config/ directory for a single mounted volume", async t => {
  const root = await directory(t);
  const pathsDefault = await resolveConfigPaths(root);
  assert.equal(pathsDefault.configRoot, path.join(root, "config"));
  assert.equal(pathsDefault.configFile, path.join(root, "config", "config.toml"));

  const nested = path.join(root, "config");
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, "config.toml"), "port = 14001\n");
  await fs.writeFile(path.join(nested, "auth-10001.json"), JSON.stringify({ cookie: "nested=mock", userId: "10001" }));
  const pathsNested = await resolveConfigPaths(root);
  assert.equal(pathsNested.configRoot, nested);
  const config = await loadConfig({}, root);
  assert.equal(config.port, 14001);
  assert.equal(config.authFile, "");
  assert.equal(config.configTomlFile, path.join(nested, "config.toml"));

  // Project-root layout when config/ is absent but root has config.toml.
  const legacy = await directory(t);
  await fs.writeFile(path.join(legacy, "config.toml"), "port = 14002\n");
  await fs.writeFile(path.join(legacy, "auth-10002.json"), JSON.stringify({ cookie: "legacy=mock", userId: "10002" }));
  const pathsLegacy = await resolveConfigPaths(legacy);
  assert.equal(pathsLegacy.configRoot, legacy);
  const legacyConfig = await loadConfig({}, legacy);
  assert.equal(legacyConfig.port, 14002);
  assert.equal(legacyConfig.authFile, "");

  // auth-* without config.toml still selects the directory that holds the packs.
  const authOnly = await directory(t);
  await fs.mkdir(path.join(authOnly, "config"));
  await fs.writeFile(path.join(authOnly, "config", "auth-9.json"), JSON.stringify({ userId: "9", cookie: "c=1" }));
  const pathsAuthOnly = await resolveConfigPaths(authOnly);
  assert.equal(pathsAuthOnly.configRoot, path.join(authOnly, "config"));
  assert.equal(pathsAuthOnly.source, "config-dir-auth");
});

test("parseToml reads tables, strings, numbers, booleans and arrays", () => {
  const data = parseToml([
    "# comment",
    "host = \"0.0.0.0\" # trailing",
    "port = 3000",
    "models = [\"a\", 'b', \"c d\"]",
    "enabled = true",
    "[auth]",
    "cookie = 'raw=$value'",
    "clientVersion = \"26.1\"",
    "[logging]",
    "maxFiles = 0"
  ].join("\n"));
  assert.equal(data.host, "0.0.0.0");
  assert.equal(data.port, 3000);
  assert.deepEqual(data.models, ["a", "b", "c d"]);
  assert.equal(data.enabled, true);
  assert.equal(data.auth.cookie, "raw=$value");
  assert.equal(data.auth.clientVersion, "26.1");
  assert.equal(data.logging.maxFiles, 0);
});
