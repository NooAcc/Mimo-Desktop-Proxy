import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createClientVersionRefresher,
  fetchCloudClientVersion,
  nextClientVersionRefreshDelayMs,
  normalizeClientVersion,
  parseClientVersionManifest,
  clientVersionPlatformKey,
  DEFAULT_CLIENT_VERSION_MANIFEST_URL,
} from "../lib/client-version.js";
import { createAuthRuntime } from "../lib/auth-runtime.js";
import { loadConfig, readConfig } from "../lib/config.js";
import { createAutoAuthProvider } from "../lib/auto-auth.js";
import { getAuthHeaders } from "../mimo_server.js";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

test("parseClientVersionManifest prefers platform productVersion", () => {
  const manifest = {
    platforms: {
      "win-x64": { version: "26.914.142245", productVersion: "26.914.142245" },
      "linux-x64": { version: "26.909.91205", productVersion: "26.909.91205" },
      "mac-arm64": { version: "26.914.142245" },
    },
  };
  assert.deepEqual(parseClientVersionManifest(manifest, { platformKey: "win-x64" }), {
    clientVersion: "26.914.142245",
    platform: "win-x64",
    source: "manifest",
  });
  assert.equal(parseClientVersionManifest(manifest, { platformKey: "linux-x64" }).clientVersion, "26.909.91205");
  // Unknown platform falls back to highest version.
  assert.equal(parseClientVersionManifest(manifest, { platformKey: "freebsd-x64" }).clientVersion, "26.914.142245");
  assert.equal(normalizeClientVersion(" 26.1.2 "), "26.1.2");
  assert.equal(normalizeClientVersion("not-a-version"), "");
  assert.equal(clientVersionPlatformKey("win32", "x64"), "win-x64");
});

test("nextClientVersionRefreshDelayMs stays within 2h±1h", () => {
  for (let i = 0; i < 50; i++) {
    const delay = nextClientVersionRefreshDelayMs({ random: Math.random });
    assert.ok(delay >= 60 * 60 * 1000, "min 1h, got " + delay);
    assert.ok(delay <= 3 * 60 * 60 * 1000, "max 3h, got " + delay);
  }
  assert.equal(
    nextClientVersionRefreshDelayMs({ intervalMs: 7200000, jitterMs: 3600000, random: () => 0 }),
    3600000
  );
  const high = nextClientVersionRefreshDelayMs({ intervalMs: 7200000, jitterMs: 3600000, random: () => 0.999999 });
  assert.ok(high <= 3 * 60 * 60 * 1000);
  assert.ok(high >= 3 * 60 * 60 * 1000 - 100);
});

test("fetchCloudClientVersion reads CDN manifest via mock fetch", async () => {
  const body = {
    platforms: {
      "win-x64": { version: "27.1.0", productVersion: "27.1.0", url: "https://example.test/x.exe" },
    },
  };
  const result = await fetchCloudClientVersion({
    platformKey: "win-x64",
    fetchImpl: async (url) => {
      assert.equal(String(url), DEFAULT_CLIENT_VERSION_MANIFEST_URL);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(result.clientVersion, "27.1.0");
  assert.equal(result.platform, "win-x64");
});

test("createClientVersionRefresher updates config.toml identity after cloud sync", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-client-version-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configDir = path.join(directory, "config");
  await fs.mkdir(configDir);
  const configFile = path.join(configDir, "config.toml");
  await fs.writeFile(configFile, [
    "host = \"127.0.0.1\"",
    "",
    "[auth]",
    "sid = \"mimopc\"",
    "clientVersion = \"26.0.0\"",
    "source = \"mimocode-cli-free\"",
  ].join("\n"));
  const authFile = path.join(configDir, "auth-1.json");
  await fs.writeFile(authFile, JSON.stringify({
    cookie: "serviceToken=STALE; userId=1",
    passToken: "V1:P",
    userId: "1",
    cUserId: "c",
  }, null, 2));

  const config = {
    ...await loadConfig({}, directory),
    authFile,
    cookie: "serviceToken=STALE; userId=1",
    clientVersionRefresh: true,
    clientVersionRefreshIntervalMs: 7200000,
    clientVersionRefreshJitterMs: 3600000,
  };
  assert.equal(config.configTomlFile, configFile);
  assert.equal(config.clientVersion, "26.0.0");
  const authRuntime = createAuthRuntime({
    cookie: "serviceToken=STALE; userId=1",
    passToken: "V1:P",
    passUserId: "1",
    passCUserId: "c",
    sid: config.sid,
    clientVersion: config.clientVersion,
    source: config.source,
  });

  let manifestCalls = 0;
  const fetchImpl = async (url) => {
    manifestCalls += 1;
    assert.match(String(url), /manifest\.json$/);
    return new Response(JSON.stringify({
      platforms: {
        "win-x64": { version: "27.2.2", productVersion: "27.2.2" },
      },
    }), { status: 200 });
  };

  const { persistAuthUpdate } = await import("../lib/auth-runtime.js");
  const refresher = createClientVersionRefresher({
    config,
    authRuntime,
    logger: silentLogger,
    persist: persistAuthUpdate,
    fetchImpl,
    random: () => 0.5,
  });

  const periodic = await refresher.refresh({ reason: "interval" });
  assert.equal(periodic.ok, true);
  assert.equal(periodic.changed, true);
  assert.equal(periodic.clientVersion, "27.2.2");
  assert.equal(authRuntime.clientVersion, "27.2.2");
  assert.equal(manifestCalls, 1);
  const tomlText = await fs.readFile(configFile, "utf8");
  assert.match(tomlText, /clientVersion = "27\.2\.2"/);
  const pack = JSON.parse(await fs.readFile(authFile, "utf8"));
  assert.equal("clientVersion" in pack, false);
  assert.equal(pack.cookie, "serviceToken=STALE; userId=1");

  const auto = createAutoAuthProvider({
    config,
    authRuntime,
    logger: silentLogger,
    baseAuth: getAuthHeaders,
    refreshImpl: async () => ({
      cookie: "serviceToken=NEW; userId=1; mimopc_slh=\"\"; mimopc_ph=x",
      cookieNames: ["serviceToken", "userId", "mimopc_slh", "mimopc_ph"],
      sid: "mimopc",
      passToken: "V1:P",
      passUserId: "1",
    }),
    persist: persistAuthUpdate,
    clientVersionRefresher: refresher,
  });
  await auto.refresh({ reason: "missing_service_token" });
  assert.ok(manifestCalls >= 2, "cookie refresh must force another cloud fetch");
  assert.equal(authRuntime.cookie.includes("serviceToken=NEW"), true);
  assert.equal(authRuntime.clientVersion, "27.2.2");
  assert.ok(authRuntime.lastClientVersionCheckAt);

  const offConfig = { ...config, clientVersionRefresh: false };
  const offRuntime = createAuthRuntime({ clientVersion: "26.0.0" });
  const off = createClientVersionRefresher({
    config: offConfig,
    authRuntime: offRuntime,
    logger: silentLogger,
    fetchImpl,
  });
  const skipped = await off.refresh({ reason: "interval" });
  assert.equal(skipped.skipped, true);
  const forced = await off.refresh({ reason: "cookie_refresh", force: true });
  assert.equal(forced.ok, true);
});

test("config defaults enable clientVersion refresh at 2h±1h", () => {
  const config = readConfig({});
  assert.equal(config.clientVersionRefresh, true);
  assert.equal(config.clientVersionRefreshIntervalMs, 2 * 60 * 60 * 1000);
  assert.equal(config.clientVersionRefreshJitterMs, 60 * 60 * 1000);
  assert.equal(config.clientVersionManifestUrl, DEFAULT_CLIENT_VERSION_MANIFEST_URL);
});
