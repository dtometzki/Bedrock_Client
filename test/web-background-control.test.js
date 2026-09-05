import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test } from "node:test";
import { registerBackgroundServer, stopWebBackground } from "../src/web-background-control.js";

const TOKEN = "a".repeat(48);
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-stop-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function localServer(t) {
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.writeHead(403); res.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => new Promise((resolve) => server.close(resolve));
  t.after(close);
  return { port: server.address().port, close, requests: () => requests };
}

test("missing and stale registrations report no server without signalling saved PIDs", async (t) => {
  const dir = directory(t);
  assert.equal(await stopWebBackground({ directory: dir }), false);
  const server = await localServer(t);
  await server.close();
  registerBackgroundServer({ directory: dir, port: server.port, token: TOKEN });
  const signal = t.mock.method(process, "kill", () => assert.fail("must not signal a stored PID"));
  assert.equal(await stopWebBackground({ directory: dir }), false);
  assert.equal(signal.mock.callCount(), 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("unrelated server on a reused port is not stopped and registration is retained", async (t) => {
  const dir = directory(t);
  const server = await localServer(t);
  registerBackgroundServer({ directory: dir, port: server.port, token: TOKEN });
  const signal = t.mock.method(process, "kill", () => assert.fail("must not signal a stored PID"));
  await assert.rejects(stopWebBackground({ directory: dir }), /abgelehnt/);
  assert.equal(signal.mock.callCount(), 0);
  assert.equal(server.requests(), 1);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test("multiple registrations require explicit port selection", async (t) => {
  const dir = directory(t);
  const first = await localServer(t);
  const second = await localServer(t);
  for (const server of [first, second]) registerBackgroundServer({ directory: dir, port: server.port, token: TOKEN });
  await assert.rejects(stopWebBackground({ directory: dir }), /Mehrere Hintergrundserver/);
  assert.equal(first.requests() + second.requests(), 0);
  await assert.rejects(stopWebBackground({ directory: dir, port: first.port }), /abgelehnt/);
  assert.equal(first.requests(), 1);
  assert.equal(second.requests(), 0);
});

test("registration cleanup protects successor data and reports deletion errors", (t) => {
  const dir = directory(t);
  const first = registerBackgroundServer({ directory: dir, port: 3456, token: TOKEN });
  const successor = registerBackgroundServer({ directory: dir, port: 3456, token: "b".repeat(48) });
  assert.throws(first.cleanup, /inzwischen gewechselt/);
  const original = fs.readFileSync(path.join(dir, "web-background-3456.json"), "utf8");
  const unlink = t.mock.method(fs, "unlinkSync", () => { throw new Error("permission denied"); });
  assert.throws(successor.cleanup, /nicht entfernt/);
  assert.equal(fs.readFileSync(path.join(dir, "web-background-3456.json"), "utf8"), original);
  unlink.mock.restore();
  successor.cleanup();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("registration write failures preserve previous state and allow a subsequent successful write", (t) => {
  const dir = directory(t);
  registerBackgroundServer({ directory: dir, port: 3456, token: TOKEN });
  const original = fs.readFileSync(path.join(dir, "web-background-3456.json"), "utf8");
  const rename = t.mock.method(fs, "renameSync", () => { throw new Error("write failed"); });
  assert.throws(() => registerBackgroundServer({ directory: dir, port: 3456, token: "b".repeat(48) }), /nicht.*registriert/);
  assert.equal(fs.readFileSync(path.join(dir, "web-background-3456.json"), "utf8"), original);
  assert.equal(fs.readdirSync(dir).length, 1);
  rename.mock.restore();
  registerBackgroundServer({ directory: dir, port: 3456, token: "b".repeat(48) }).cleanup();
});

test("malformed or oversized registrations are rejected without modification", async (t) => {
  const dir = directory(t);
  const file = path.join(dir, "web-background-3456.json");
  for (const raw of ["not json", "x".repeat(5000), JSON.stringify({ version: 1, port: 3456, pid: process.pid, token: "invalid\r\nheader" })]) {
    fs.writeFileSync(file, raw);
    await assert.rejects(stopWebBackground({ directory: dir }), /ungueltig/);
    assert.equal(fs.readFileSync(file, "utf8"), raw);
  }
});
