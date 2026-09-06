import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test } from "node:test";
import { AuthService, IDLE_MS } from "../src/auth.js";
import { CredentialVault } from "../src/credential-vault.js";
import { startWebServer } from "../src/web-server.js";

const PASSWORD = "test-only-browser-passphrase";
const DATA = { accessKeyId: "AKIAEXAMPLEONLY000001", secretAccessKey: "s".repeat(40), profile: "role" };
const CONTROL = "test-only-control-token";
async function fixture(t, { setup = true, serverOptions = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-browser-test-"));
  let now = Date.now();
  const auth = new AuthService({ vault: new CredentialVault(directory), mode: "vault", now: () => now,
    profiles: async () => ({ role: { role_arn: "arn:aws:iam::123456789012:role/Test", source_profile: "base" }, base: {} }),
    savedMode: null, persistMode() {}, env: {} });
  if (setup) { await auth.setup(DATA, PASSWORD, PASSWORD); auth.lock(); }
  const server = await startWebServer({ port: 0, auth, authToken: CONTROL, persistModelSelection: false,
    model: { id: "test-model", label: "Test" }, models: [{ id: "test-model", label: "Test" }],
    messages: [{ role: "user", content: [{ text: "PRIVATE-CHAT" }] }],
    createClient: () => ({ destroy() {} }), streamFn: async function* () { yield { type: "text", text: "Test" }; }, ...serverOptions });
  t.after(async () => {
    auth.close(); server.server.closeAllConnections();
    await new Promise((resolve) => server.server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const headers = (cookie = "") => ({ "x-bedrock-request": "1", Origin: server.url,
    "Content-Type": "application/json", Cookie: cookie });
  async function request(route, body, cookie = "", extraHeaders = {}) {
    const res = await fetch(server.url + route, { method: body === undefined ? "GET" : "POST",
      headers: { ...headers(cookie), ...extraHeaders }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const text = await res.text();
    for (const secret of [PASSWORD, DATA.accessKeyId, DATA.secretAccessKey, CONTROL]) assert.ok(!text.includes(secret));
    return { status: res.status, data: JSON.parse(text), headers: res.headers, cookie: res.headers.get("set-cookie")?.split(";")[0] };
  }
  const login = (password = PASSWORD) => request("/api/browser/unlock", { password });
  return { ...server, auth, directory, headers, request, login, advance: (ms) => { now += ms; } };
}

test("vault password creates a private browser cookie shared across tabs; other browsers prove the password separately", async (t) => {
  const { request, login } = await fixture(t);
  assert.deepEqual((await request("/api/browser/status")).data, { authenticated: false, vaultLogin: true });
  assert.equal((await request("/api/state")).status, 403);
  const first = await login();
  assert.equal(first.status, 200);
  assert.match(first.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Path=\//);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal((await request("/api/state", undefined, first.cookie)).data.messages[0].text, "PRIVATE-CHAT");
  assert.equal((await request("/api/state", undefined, first.cookie)).status, 200); // new tab/reload, same cookie
  assert.equal((await request("/api/state")).status, 403); // separate browser
  const other = await login();
  assert.notEqual(other.cookie, first.cookie);
  for (const cookie of [first.cookie, other.cookie]) assert.equal((await request("/api/state", undefined, cookie)).status, 200);
});

test("browser authentication and cookie APIs enforce Origin, Host, request header and JSON; bad inputs and throttling recover", async (t) => {
  const { request, login, url, advance } = await fixture(t);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.get(url + "/api/browser/status", { headers: { Host: "127.0.0.1:1", "x-bedrock-request": "1" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
  });
  assert.equal(wrongHost, 403);
  for (const headers of [{ Origin: "http://evil.example" }, { Origin: "" }, { Origin: url.replace("http:", "https:") },
    { "x-bedrock-request": "" }, { "Content-Type": "text/plain" }, { "sec-fetch-site": "same-site" }]) {
    assert.equal((await request("/api/browser/unlock", { password: PASSWORD }, "", headers)).status, 403, JSON.stringify(headers));
  }
  for (const body of [{}, [], { password: 5 }, { password: PASSWORD, extra: true }, { password: "x".repeat(1025) }]) {
    assert.equal((await request("/api/browser/unlock", body)).status, 400);
  }
  assert.equal((await login("wrong-password")).status, 401);
  assert.equal((await login()).status, 429);
  advance(31000);
  const { cookie } = await login();
  assert.equal((await request("/api/state", undefined, cookie, { "x-bedrock-request": "" })).status, 403);
  assert.equal((await request("/api/state", undefined, cookie, { Origin: "http://localhost:9876" })).status, 403);
  assert.equal((await request("/api/state", undefined, cookie)).status, 200);
});

test("locking and idle expiry revoke every browser; privileged background stop remains available", async (t) => {
  let stopped = false;
  const { request, login, advance } = await fixture(t, { serverOptions: { prepareShutdown: () => () => { stopped = true; } } });
  const first = await login();
  const other = await login();
  assert.equal((await request("/api/server/stop", {}, first.cookie)).status, 403);
  const locked = await request("/api/auth/lock", {}, first.cookie);
  assert.equal(locked.status, 200);
  assert.match(locked.headers.get("set-cookie"), /Max-Age=0/);
  for (const cookie of [first.cookie, other.cookie]) assert.equal((await request("/api/state", undefined, cookie)).status, 403);
  const current = await login();
  advance(IDLE_MS + 1);
  assert.equal((await request("/api/browser/status", undefined, current.cookie)).data.authenticated, false);
  assert.equal((await request("/api/state", undefined, current.cookie)).status, 403);
  assert.equal((await request("/api/server/stop", {}, "", { "x-bedrock-token": CONTROL })).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(stopped);
});

test("password changes rotate browser access and invalidate old cookies and passwords", async (t) => {
  const { request, login, advance } = await fixture(t);
  const first = await login();
  const other = await login();
  const replacement = "replacement-browser-passphrase";
  const changed = await request("/api/auth/password", { oldPassword: PASSWORD, password: replacement, confirmation: replacement }, first.cookie);
  assert.equal(changed.status, 200);
  assert.ok(changed.cookie);
  for (const cookie of [first.cookie, other.cookie]) assert.equal((await request("/api/state", undefined, cookie)).status, 403);
  assert.equal((await request("/api/state", undefined, changed.cookie)).status, 200);
  assert.equal((await login()).status, 401);
  advance(31000);
  assert.equal((await login(replacement)).status, 200);
});

test("initial setup and AWS profile mode exchange a private startup token without granting anonymous access", async (t) => {
  const { request, auth } = await fixture(t, { setup: false });
  assert.equal((await request("/api/browser/connect", {})).status, 403);
  const connected = await request("/api/browser/connect", {}, "", { "x-bedrock-token": CONTROL });
  assert.equal(connected.status, 200);
  const setup = await request("/api/auth/setup", { ...DATA, password: PASSWORD, confirmation: PASSWORD }, connected.cookie);
  assert.equal(setup.status, 200);
  assert.equal((await request("/api/state", undefined, setup.cookie)).status, 200);
  assert.equal((await request("/api/browser/connect", {}, "", { "x-bedrock-token": CONTROL })).status, 423);
  await auth.selectMode("aws", "base");
  const aws = await request("/api/browser/connect", {}, "", { "x-bedrock-token": CONTROL });
  assert.equal(aws.status, 200);
  assert.equal((await request("/api/state", undefined, aws.cookie)).status, 200);
  assert.equal((await request("/api/state")).status, 403);
});

test("lock aborts a cookie-authenticated stream and prevents a pending request body from mutating state", async (t) => {
  let announce;
  const started = new Promise((resolve) => { announce = resolve; });
  let signal;
  const f = await fixture(t, { serverOptions: { streamFn: async function* (_client, options) {
    signal = options.abortSignal;
    yield { type: "text", text: "partial" };
    announce();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    yield { type: "text", text: "LATE-PRIVATE-OUTPUT" };
  } } });
  const { cookie } = await f.login();
  const stream = fetch(f.url + "/api/chat", { method: "POST", headers: f.headers(cookie), body: JSON.stringify({ message: "test" }) });
  await started;
  const response = await stream;
  const reader = response.body.getReader();
  assert.ok((await reader.read()).value);
  assert.equal((await f.request("/api/auth/lock", {}, cookie)).status, 200);
  let remaining = "";
  try { while (true) { const part = await reader.read(); if (part.done) break; remaining += new TextDecoder().decode(part.value); } } catch {}
  assert.ok(signal.aborted);
  assert.ok(!remaining.includes("LATE-PRIVATE-OUTPUT"));
  const current = await f.login();
  assert.equal(current.status, 200);
  let connected;
  const received = new Promise((resolve) => f.server.once("request", resolve));
  const pending = new Promise((resolve) => {
    const req = http.request(f.url + "/api/system", { method: "POST", headers: f.headers(current.cookie) }, (res) => { res.resume(); resolve(); });
    req.on("error", resolve);
    connected = req;
    req.write('{"system":"SHOULD-NOT-APPLY');
  });
  // Revoke after the server accepted the headers but before the body completes.
  await received;
  await f.request("/api/auth/lock", {}, current.cookie);
  connected.end('"}');
  await pending;
  assert.equal(f.getState().systemPrompt, "");
});
