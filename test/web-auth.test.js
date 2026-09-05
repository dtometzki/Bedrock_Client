import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test } from "node:test";
import { AuthService, IDLE_MS } from "../src/auth.js";
import { CredentialVault } from "../src/credential-vault.js";
import { startWebServer } from "../src/web-server.js";

const PASSWORD = "test-only-master-passphrase";
const DATA = { accessKeyId: "AKIAEXAMPLEONLY000001", secretAccessKey: "s".repeat(40), profile: "role" };
const PROFILES = { role: { role_arn: "arn:aws:iam::123456789012:role/Test", source_profile: "base" }, base: {} };
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-web-auth-test-"));
  const auth = new AuthService({ vault: new CredentialVault(directory), mode: "vault", profiles: async () => PROFILES,
    savedMode: null, persistMode: () => {}, env: {}, ...options.authOptions });
  const server = await startWebServer({
    models: [{ id: "test-model", label: "Test" }], model: { id: "test-model", label: "Test" },
    port: 0, auth, authToken: "test-local-token", persistModelSelection: false,
    createClient: () => ({ destroy() {} }),
    streamFn: async function* () { yield { type: "text", text: "Testantwort" }; }, ...options.serverOptions
  });
  t.after(async () => {
    auth.close();
    server.server.closeAllConnections();
    await new Promise((resolve) => server.server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function request(route, body, headers = {}) {
    const res = await fetch(server.url + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-bedrock-token": "test-local-token", "Content-Type": "application/json", ...headers },
      ...(body !== undefined && { body: JSON.stringify(body) })
    });
    const text = await res.text();
    for (const secret of [DATA.accessKeyId, DATA.secretAccessKey, PASSWORD]) assert.ok(!text.includes(secret), "response must not expose secrets");
    return { status: res.status, text, headers: res.headers, data: text.startsWith("{") ? JSON.parse(text) : null };
  }
  return { ...server, auth, request };
}

test("all auth endpoints require token and preserve origin/host checks", async (t) => {
  const { request, url } = await fixture(t);
  for (const action of ["status", "profiles", "setup", "unlock", "lock", "update", "password", "delete", "mode", "profile", "check", "activity"]) {
    const result = await request(`/api/auth/${action}`, ["status", "profiles"].includes(action) ? undefined : {}, { "x-bedrock-token": "" });
    assert.equal(result.status, 403);
  }
  assert.equal((await request("/api/auth/unlock", { password: PASSWORD }, { Origin: "http://evil.example" })).status, 403);
  const status = await new Promise((resolve) => {
    const req = http.get(url + "/api/auth/status", { headers: { Host: "evil.example", "x-bedrock-token": "test-local-token" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", assert.fail);
  });
  assert.equal(status, 403);
  assert.equal((await request("/api/auth/status")).status, 200);
  assert.deepEqual((await request("/api/auth/profiles")).data.profiles, ["role"]);
});

test("web starts without credentials; setup, reload, locked requests and recovery share one state", async (t) => {
  let calls = 0;
  const { request } = await fixture(t, { serverOptions: { streamFn: async function* () { calls++; yield { type: "text", text: "Testantwort" }; } } });
  assert.equal((await request("/api/state")).data.auth.ready, false);
  assert.equal((await request("/api/chat", { message: "hello" })).status, 423);
  assert.equal(calls, 0);
  assert.equal((await request("/api/auth/setup", { ...DATA, password: PASSWORD, confirmation: PASSWORD })).status, 200);
  const reloaded = await request("/api/auth/status");
  assert.equal(reloaded.data.locked, false);
  assert.equal(reloaded.headers.get("cache-control"), "no-store");
  assert.equal((await request("/api/chat", { message: "hello" })).status, 200);
  assert.equal(calls, 1);
  await request("/api/auth/lock", {});
  assert.equal((await request("/api/auth/status")).data.locked, true);
  const history = (await request("/api/state")).data.messages;
  assert.equal((await request("/api/chat", { message: "no" })).status, 423);
  assert.deepEqual((await request("/api/state")).data.messages, history);
  assert.equal((await request("/api/auth/unlock", { password: PASSWORD })).status, 200);
  assert.equal((await request("/api/chat", { message: "again" })).status, 200);
  assert.equal(calls, 2);
});

test("bad auth inputs release locks and polling cannot postpone inactivity lock", async (t) => {
  let now = 0;
  const { request } = await fixture(t, { authOptions: { now: () => now } });
  for (const body of [[], null, { password: {} }, { password: "x".repeat(9000) }, { unexpected: "field" }]) {
    assert.ok([400, 413].includes((await request("/api/auth/unlock", body)).status));
  }
  await request("/api/auth/setup", { ...DATA, password: PASSWORD, confirmation: PASSWORD });
  now = IDLE_MS - 1;
  assert.equal((await request("/api/auth/status")).data.locked, false);
  now++;
  assert.equal((await request("/api/state")).data.auth.locked, true);
  assert.equal((await request("/api/auth/activity", {})).data.locked, true);
  assert.equal((await request("/api/auth/unlock", { password: PASSWORD })).data.locked, false);
});

test("manual lock aborts streaming across tabs, rejects changes while busy and drops late output", async (t) => {
  let signal;
  let announce;
  const started = new Promise((resolve) => { announce = resolve; });
  const { request, auth } = await fixture(t, { serverOptions: {
    streamFn: async function* (_client, options) {
      signal = options.abortSignal;
      yield { type: "text", text: "partial" };
      announce();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      yield { type: "text", text: "LATE-OUTPUT-MUST-NOT-APPEAR" };
    }
  } });
  await request("/api/auth/setup", { ...DATA, password: PASSWORD, confirmation: PASSWORD });
  const stream = request("/api/chat", { message: "hello" });
  await started;
  assert.equal((await request("/api/auth/update", DATA)).status, 409);
  assert.equal((await request("/api/auth/lock", {})).status, 200);
  assert.equal(signal.aborted, true);
  const response = await stream;
  assert.ok(!response.text.includes("LATE-OUTPUT-MUST-NOT-APPEAR"));
  assert.match(response.text, /"aborted":true/);
  assert.equal(auth.status().locked, true);
  assert.equal((await request("/api/state")).data.busy, false);
  assert.equal((await request("/api/auth/unlock", { password: PASSWORD })).status, 200);
});

test("vault stream errors never expose AWS secrets and the next valid request succeeds", async (t) => {
  let first = true;
  const { request } = await fixture(t, { serverOptions: { streamFn: async function* () {
    if (first) { first = false; throw new Error(DATA.secretAccessKey); }
    yield { type: "text", text: "recovered" };
  } } });
  await request("/api/auth/setup", { ...DATA, password: PASSWORD, confirmation: PASSWORD });
  const failed = await request("/api/chat", { message: "first" });
  assert.match(failed.text, /"failed":true/);
  assert.equal((await request("/api/state")).data.messages.length, 0);
  assert.match((await request("/api/chat", { message: "second" })).text, /recovered/);
});
