import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { launchWebBackground, backgroundStopCommand } from "../src/web-background.js";

const exec = promisify(execFile);
const entrypoint = fileURLToPath(new URL("../app_aws.js", import.meta.url));
async function listener() {
  const server = http.createServer((_req, res) => res.end());
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}
function environment(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-background-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { ...process.env, BEDROCK_CHAT_CONFIG_DIR: directory, TMPDIR: directory, TEMP: directory, TMP: directory };
}
async function waitUntil(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("background process did not stop/clean up in time");
}

test("background launcher exits while authenticated web server stays usable; stop cleans bootstrap", { timeout: 20000 }, async (t) => {
  const env = environment(t);
  const reserved = await listener();
  const port = reserved.port;
  await reserved.close();
  let pid = 0;
  let stopped = false;
  t.after(() => { if (pid && !stopped) { try { process.kill(pid, "SIGTERM"); } catch {} } });
  const { stdout, stderr } = await exec(process.execPath, [entrypoint, "--web", "--background", "--no-open", "--no-save", "--auth", "vault", "--port", String(port)], { env, timeout: 10000 });
  assert.equal(stderr, "");
  const plain = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  pid = Number(plain.match(/(?:kill -TERM |taskkill \/PID )(\d+)/)?.[1]);
  assert.ok(pid > 0);
  assert.match(plain, /Web-GUI im Hintergrund:/);
  assert.ok(!plain.includes("#token="));
  const launchPath = plain.match(/Sichere Startdatei: (.+)/)?.[1];
  assert.ok(launchPath);
  const bootstrap = fs.readFileSync(launchPath, "utf8");
  const token = bootstrap.match(/#token=([^"&<]+)/)?.[1];
  assert.ok(token);
  const url = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(url + "/api/auth/status")).status, 403);
  const response = await fetch(url + "/api/auth/status", { headers: { "x-bedrock-token": token } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).locked, true);
  process.kill(pid, "SIGTERM");
  await waitUntil(async () => {
    try { await fetch(url, { signal: AbortSignal.timeout(200) }); return false; } catch { return true; }
  });
  await waitUntil(() => !fs.existsSync(launchPath));
  stopped = true;
});

test("occupied port is reported as startup failure without claiming a running background server", { timeout: 15000 }, async (t) => {
  const env = environment(t);
  const blocker = await listener();
  t.after(blocker.close);
  await assert.rejects(exec(process.execPath, [entrypoint, "--web", "--background", "--no-open", "--port", String(blocker.port)], { env, timeout: 10000 }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /EADDRINUSE|belegt/);
    assert.ok(!error.stdout.includes("Web-GUI im Hintergrund:"));
    return true;
  });
  await blocker.close();
  const restarted = await launchWebBackground({ argv: ["--web", "--background", "--no-open", "--port", String(blocker.port)], env });
  try {
    assert.equal((await fetch(restarted.url)).status, 200);
  } finally {
    process.kill(restarted.pid, "SIGTERM");
    await waitUntil(() => !fs.existsSync(restarted.launchTarget));
  }
});

test("timeout and spawn failure cancel only the newly spawned child", async () => {
  for (const failure of ["timeout", "spawn"]) {
    const child = new EventEmitter();
    let killed = false;
    let unreferenced = false;
    child.connected = true;
    child.kill = () => { killed = true; };
    child.unref = () => { unreferenced = true; };
    child.disconnect = () => { child.connected = false; child.emit("disconnect"); };
    const before = process.listenerCount("SIGINT");
    const pending = launchWebBackground({ argv: ["--web", "--background"], timeoutMs: 10, spawnFn: (_executable, args, options) => {
      assert.ok(!args.includes("--background"));
      assert.equal(options.detached, true);
      assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
      if (failure === "spawn") queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child;
    } });
    await assert.rejects(pending, /Webserver/);
    assert.equal(killed, true);
    assert.equal(unreferenced, true);
    assert.equal(child.connected, false);
    assert.equal(process.listenerCount("SIGINT"), before);
  }
});

test("stop command matches the platform", () => {
  assert.equal(backgroundStopCommand(1234, "darwin"), "kill -TERM 1234");
  assert.equal(backgroundStopCommand(1234, "win32"), "taskkill /PID 1234 /T");
});
