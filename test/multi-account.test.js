import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  authFileNameForUserId,
  discoverAuthAccounts,
  planAccountPorts,
  hydrateAuthRuntime,
  publicAuthStatus,
} from "../lib/auth-runtime.js";
import { loadConfig, readConfig } from "../lib/config.js";
import { createProxyServer } from "../mimo_server.js";

async function directory(t, prefix = "mimo-multi-") {
  const root = path.resolve(os.tmpdir());
  const result = await fs.mkdtemp(path.join(root, prefix));
  t.after(() => fs.rm(result, { recursive: true, force: true }));
  return result;
}

test("authFileNameForUserId requires a userId and sanitizes path characters", () => {
  assert.equal(authFileNameForUserId("2386469077"), "auth-2386469077.json");
  assert.equal(authFileNameForUserId("abc/def"), "auth-abc_def.json");
  assert.throws(() => authFileNameForUserId(""), /userId is required/);
  assert.throws(() => authFileNameForUserId(null), /userId is required/);
});

test("discoverAuthAccounts finds only auth-*.json and sorts stably", async t => {
  const root = await directory(t);
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, "auth.json"), JSON.stringify({ cookie: "legacy=1", userId: "1" }));
  await fs.writeFile(path.join(configDir, "auth-200.json"), JSON.stringify({ cookie: "b=2", userId: "200" }));
  await fs.writeFile(path.join(configDir, "auth-100.json"), JSON.stringify({ cookie: "a=1", userId: "100" }));
  await fs.writeFile(path.join(configDir, "auth-300.json.bak"), JSON.stringify({ cookie: "x=3", userId: "300" }));
  await fs.writeFile(path.join(configDir, "config.toml"), "port = 0\n");

  const accounts = await discoverAuthAccounts(configDir);
  assert.deepEqual(accounts.map(item => item.userId), ["100", "200"]);
  assert.deepEqual(accounts.map(item => item.fileName), ["auth-100.json", "auth-200.json"]);
  assert.equal(accounts[0].hasCookie, true);
  assert.deepEqual(await discoverAuthAccounts(path.join(root, "missing")), []);
});

test("planAccountPorts assigns basePort + index and rejects overflow", () => {
  const accounts = [{ id: "1" }, { id: "2" }, { id: "3" }];
  assert.deepEqual(planAccountPorts(accounts, 3000).map(item => item.port), [3000, 3001, 3002]);
  assert.deepEqual(planAccountPorts(accounts, 0).map(item => item.port), [0, 0, 0]);
  assert.throws(() => planAccountPorts(accounts, "x"), /port must be/);
  assert.throws(() => planAccountPorts([{ id: "a" }, { id: "b" }], 65535), /exceeds 65535/);
});

test("hydrateAuthRuntime + publicAuthStatus expose the per-account pack", async t => {
  const root = await directory(t);
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, "config.toml"), [
    "port = 3100",
    "host = \"127.0.0.1\"",
    "",
    "[auth]",
    "sid = \"mimopc\"",
    "clientVersion = \"toml-version\"",
    "source = \"toml-source\"",
  ].join("\n"));
  await fs.writeFile(path.join(configDir, "auth-42.json"), JSON.stringify({
    cookie: "serviceToken=T; userId=42",
    passToken: "V1:secret",
    userId: "42",
    cUserId: "c",
    // Legacy identity keys in packs are ignored.
    sid: "pack-sid",
    clientVersion: "pack-version",
    source: "pack-source",
  }));
  const base = await loadConfig({}, root);
  assert.equal(base.sid, "mimopc");
  assert.equal(base.clientVersion, "toml-version");
  assert.equal(base.source, "toml-source");
  const accounts = await discoverAuthAccounts(base.configRoot);
  const planned = planAccountPorts(accounts, base.port);
  assert.equal(planned[0].port, 3100);
  const config = {
    ...base,
    port: planned[0].port,
    authFile: planned[0].file,
    accountId: planned[0].id,
    accountUserId: planned[0].userId,
  };
  const runtime = await hydrateAuthRuntime(config);
  assert.equal(runtime.passUserId, "42");
  // Identity comes from config.toml, not the auth pack.
  assert.equal(runtime.sid, "mimopc");
  assert.equal(runtime.clientVersion, "toml-version");
  assert.equal(runtime.source, "toml-source");
  const status = publicAuthStatus(config, runtime);
  assert.equal(status.accountId, "42");
  assert.equal(status.accountUserId, "42");
  assert.equal(status.port, 3100);
  assert.equal(status.identitySource, "config.toml");
  assert.equal(status.hasPassToken, true);
  assert.equal(JSON.stringify(status).includes("V1:secret"), false);
});

test("createProxyServer serves distinct cookies on sequential account ports", async t => {
  const root = await directory(t);
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, "config.toml"), "host = \"127.0.0.1\"\nport = 0\n");
  await fs.writeFile(path.join(configDir, "auth-1.json"), JSON.stringify({ cookie: "serviceToken=ONE; userId=1", userId: "1" }));
  await fs.writeFile(path.join(configDir, "auth-2.json"), JSON.stringify({ cookie: "serviceToken=TWO; userId=2", userId: "2" }));

  const base = { ...await loadConfig({}, root), host: "127.0.0.1" };
  const planned = planAccountPorts(await discoverAuthAccounts(base.configRoot), 0);
  assert.equal(planned.length, 2);

  const seenCookies = [];
  const servers = [];
  for (const account of planned) {
    const accountConfig = {
      ...base,
      port: 0,
      authFile: account.file,
      accountId: account.id,
      accountUserId: account.userId,
    };
    const authRuntime = await hydrateAuthRuntime(accountConfig);
    const server = createProxyServer({
      config: accountConfig,
      authRuntime,
      autoAuth: null,
      clientVersionRefresher: null,
      fetchImpl: async (url, { headers }) => {
        seenCookies.push(headers.get("cookie"));
        return Response.json({
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        });
      },
    });
    await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", resolve);
      server.once("error", reject);
    });
    servers.push(server);
    t.after(() => new Promise(resolve => server.close(resolve)));
  }

  const ports = servers.map(server => server.address().port);
  assert.equal(new Set(ports).size, 2);

  for (const port of ports) {
    const body = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json" },
      }, res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, text }));
      });
      request.on("error", reject);
      request.end(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
    });
    assert.equal(body.status, 200);
    const health = await new Promise((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: "/health" }, res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { text += chunk; });
        res.on("end", () => resolve(JSON.parse(text)));
      }).on("error", reject);
    });
    assert.ok(health.account.userId === "1" || health.account.userId === "2");
  }
  assert.equal(new Set(seenCookies).size, 2);
});

test("CLI starts one listening port per auth-*.json pack", { timeout: 8000 }, async t => {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, "mimo-cli-multi-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const serviceDirectory = path.join(directory, "service");
  await fs.mkdir(path.join(serviceDirectory, "config"), { recursive: true });
  for (const name of ["mimo_server.js", "package.json"]) {
    await fs.copyFile(new URL("../" + name, import.meta.url), path.join(serviceDirectory, name));
  }
  await fs.cp(new URL("../lib/", import.meta.url), path.join(serviceDirectory, "lib"), { recursive: true });
  await fs.writeFile(path.join(serviceDirectory, "lib", "http2-fetch.js"),
    'export const createHttp2Fetch = () => Object.assign((...args) => globalThis.fetch(...args), { close() {} });\n');
  // Recommended layout: config/config.toml + config/auth-*.json
  await fs.writeFile(path.join(serviceDirectory, "config", "config.toml"), "host = \"127.0.0.1\"\nport = 0\n");
  await fs.writeFile(path.join(serviceDirectory, "config", "auth-10.json"), JSON.stringify({ cookie: "serviceToken=A; userId=10", userId: "10" }));
  await fs.writeFile(path.join(serviceDirectory, "config", "auth-20.json"), JSON.stringify({ cookie: "serviceToken=B; userId=20", userId: "20" }));

  const entry = pathToFileURL(path.join(serviceDirectory, "mimo_server.js"));
  const launcher = [
    "process.argv[1] = " + JSON.stringify(fileURLToPath(entry)) + ";",
    'process.on("message", () => { process.disconnect(); process.emit("SIGTERM"); });',
    'globalThis.fetch = async () => Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });',
    "await import(" + JSON.stringify(entry.href) + ");"
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", launcher], {
    cwd: directory,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const exited = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  let pending = "", stderr = "";
  const records = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", text => { stderr += text; });
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for listeners: " + stderr)), 5000);
    child.stdout.on("data", text => {
      pending += text;
      let boundary;
      while ((boundary = pending.indexOf("\n")) >= 0) {
        const record = JSON.parse(pending.slice(0, boundary));
        pending = pending.slice(boundary + 1);
        records.push(record);
        if (records.filter(item => item.message === "server.listening").length >= 2) {
          clearTimeout(timer);
          resolve(records.filter(item => item.message === "server.listening"));
        }
      }
    });
  });
  const listeners = await Promise.race([
    listening,
    exited.then(([code]) => { throw new Error("CLI exited early " + code + " " + stderr); }),
  ]);
  assert.equal(listeners.length, 2);
  const ports = listeners.map(item => item.port);
  assert.equal(new Set(ports).size, 2);
  assert.deepEqual(listeners.map(item => item.accountId).sort(), ["10", "20"]);
  const planned = records.find(item => item.message === "multi_account.planned");
  assert.ok(planned);
  assert.equal(planned.accounts.length, 2);
  child.send("stop");
  assert.equal((await exited)[0], 0, stderr);
});
