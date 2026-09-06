import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AuthService } from "../src/auth.js";
import { CredentialVault } from "../src/credential-vault.js";
import { startWebServer } from "../src/web-server.js";
import { getSessionPath, readSession, writeSession } from "../src/session.js";
import { windowChatId } from "../src/web/window-chat.js";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const MODEL = { id: "one", label: "One" };
const MODEL_TWO = { id: "two", label: "Two" };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-windows-"));
  const previousDir = process.env.BEDROCK_CHAT_CONFIG_DIR;
  process.env.BEDROCK_CHAT_CONFIG_DIR = directory;
  const auth = new AuthService({ mode: "aws", vault: new CredentialVault(directory), profiles: async () => ({}),
    savedMode: null, persistMode() {}, env: {} });
  let running;
  let cookie;
  const start = async () => {
    running = await startWebServer({ port: 0, authToken: "test-control", auth, model: MODEL, models: [MODEL, MODEL_TWO],
      persistModelSelection: false, persistEffortSelection: false,
      createClient: () => ({ destroy() {} }),
      streamFn: async function* (_client, request) {
        yield { type: "text", text: `Reply to ${request.messages.at(-1).content[0].text}` };
      }, ...options });
    const response = await fetch(running.url + "/api/browser/connect", { method: "POST", headers: {
      Origin: running.url, "Content-Type": "application/json", "x-bedrock-request": "1", "x-bedrock-token": "test-control"
    }, body: "{}" });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie").split(";")[0];
  };
  const close = async () => { running.server.closeAllConnections(); await new Promise((resolve) => running.server.close(resolve)); };
  await start();
  t.after(async () => {
    await close(); auth.close();
    if (previousDir === undefined) delete process.env.BEDROCK_CHAT_CONFIG_DIR;
    else process.env.BEDROCK_CHAT_CONFIG_DIR = previousDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const fetchChat = (id, route, body, extraHeaders = {}) => fetch(running.url + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: running.url, Cookie: cookie, "Content-Type": "application/json", "x-bedrock-request": "1",
      ...(id !== undefined && { "x-bedrock-chat": id }), ...extraHeaders },
    ...(body !== undefined && { body: JSON.stringify(body) })
  });
  const json = async (id, route = "/api/state", body) => {
    const response = await fetchChat(id, route, body);
    assert.equal(response.status, 200);
    return response.json();
  };
  const chat = async (id, message) => {
    const response = await fetchChat(id, "/api/chat", { message });
    assert.equal(response.status, 200);
    return response.text();
  };
  return { auth, directory, fetchChat, json, chat, restart: async () => { await close(); await start(); } };
}

test("fresh windows start new chats even with copied storage; reload and back preserve their own identifier", () => {
  let stored = A;
  const storage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  assert.equal(windowChatId({ storage, navigationType: "reload", uuid: () => B }), A);
  assert.equal(windowChatId({ storage, navigationType: "back_forward", uuid: () => B }), A);
  assert.equal(windowChatId({ storage, navigationType: "navigate", uuid: () => B }), B);
  assert.equal(windowChatId({ storage, navigationType: "reload", uuid: () => C }), B);
  stored = "../../private";
  assert.equal(windowChatId({ storage, navigationType: "reload", uuid: () => C }), C);
  assert.equal(windowChatId({ storage: { getItem() { throw Error(); }, setItem() { throw Error(); } }, uuid: () => A }), A);
});

test("window histories, model choices, system prompts, usage and clearing are independent", async (t) => {
  const seen = [];
  const f = await fixture(t, { streamFn: async function* (_client, request) {
    seen.push(structuredClone(request.messages));
    yield { type: "text", text: "offline reply" };
  } });
  assert.deepEqual((await f.json(A)).messages, []);
  await f.chat(A, "only A");
  assert.deepEqual((await f.json(B)).messages, []);
  await f.json(A, "/api/model", { model: "two" });
  await f.json(A, "/api/system", { system: "system A" });
  assert.equal((await f.json(A)).modelId, "two");
  assert.equal((await f.json(B)).modelId, "one");
  assert.equal((await f.json(B)).systemPrompt, "");
  assert.equal((await f.json(B)).usage.requests, 0);
  await f.chat(B, "only B");
  assert.equal(seen[1].length, 1, "B must not send A's conversation to AWS");
  assert.equal(seen[1][0].content[0].text, "only B");
  await f.chat(A, "A continues after reload");
  assert.equal(seen[2][0].content[0].text, "only A");
  assert.ok(!JSON.stringify(seen[2]).includes("only B"));
  await f.json(B, "/api/clear", {});
  assert.deepEqual((await f.json(B)).messages, []);
  assert.equal((await f.json(A)).messages.length, 4);
});

test("chat IDs require authentication, reject missing/malformed IDs and cannot access arbitrary files", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.fetchChat(A, "/api/state", undefined, { Cookie: "" })).status, 403);
  for (const id of [undefined, "", "../../last-session", "__proto__", "x".repeat(100), A.toUpperCase().replace("4", "5")]) {
    assert.equal((await f.fetchChat(id, "/api/state")).status, 400);
  }
  assert.deepEqual((await f.json(A)).messages, []);
  assert.throws(() => getSessionPath({ chatId: "../last-session" }), /Chat-ID/);
});

test("two windows can stream concurrently; abort and busy guards affect only their own chat; vault lock stops both", async (t) => {
  const gates = new Map(["A", "B", "A again"].map((name) => [name, deferred()]));
  const signals = new Map();
  const f = await fixture(t, { streamFn: async function* (_client, request) {
    const name = request.messages.at(-1).content[0].text;
    signals.set(name, request.abortSignal);
    yield { type: "text", text: name };
    gates.get(name).resolve();
    await new Promise((resolve) => request.abortSignal.addEventListener("abort", resolve, { once: true }));
    yield { type: "text", text: "LATE MUST NOT APPEAR" };
  } });
  const a = f.chat(A, "A");
  const b = f.chat(B, "B").catch(() => "connection closed");
  await Promise.all([gates.get("A").promise, gates.get("B").promise]);
  assert.equal((await f.fetchChat(A, "/api/chat", { message: "duplicate" })).status, 409);
  await f.json(A, "/api/abort", {});
  assert.ok(!(await a).includes("LATE MUST NOT APPEAR"));
  assert.equal(signals.get("B").aborted, false);
  assert.equal((await f.json(A)).busy, false);
  assert.equal((await f.json(B)).busy, true);
  await f.json(A, "/api/system", { system: "A only" });
  assert.equal((await f.fetchChat(B, "/api/system", { system: "busy" })).status, 409);
  const again = f.chat(A, "A again").catch(() => "connection closed");
  await gates.get("A again").promise;
  await f.json(A, "/api/auth/lock", {});
  assert.equal(signals.get("A again").aborted, true);
  assert.equal(signals.get("B").aborted, true);
  assert.ok(!(await again).includes("LATE MUST NOT APPEAR"));
  assert.ok(!(await b).includes("LATE MUST NOT APPEAR"));
  for (const id of [A, B]) assert.equal((await f.fetchChat(id, "/api/state")).status, 403);
});

test("each window saves and reloads its own private file; clearing never deletes other windows or CLI history", async (t) => {
  const f = await fixture(t, { autoSave: true });
  const legacy = [{ role: "user", content: [{ text: "CLI history" }] }];
  assert.equal(writeSession(legacy), true);
  await f.chat(A, "persist A");
  await f.chat(B, "persist B");
  assert.equal(readSession({ chatId: A }).messages[0].content[0].text, "persist A");
  assert.equal(readSession({ chatId: B }).messages[0].content[0].text, "persist B");
  assert.deepEqual(readSession().messages, legacy);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(getSessionPath({ chatId: A })).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(getSessionPath({ chatId: A }))).mode & 0o777, 0o700);
  }
  await f.restart();
  assert.equal((await f.json(A)).messages[0].text, "persist A");
  assert.equal((await f.json(B)).messages[0].text, "persist B");
  await f.json(A, "/api/clear", {});
  assert.equal(fs.existsSync(getSessionPath({ chatId: A })), false);
  assert.equal(readSession({ chatId: B }).messages[0].content[0].text, "persist B");
  assert.deepEqual(readSession().messages, legacy);
});

test("explicit resumed history belongs only to the first browser window", async (t) => {
  const f = await fixture(t, { messages: [{ role: "user", content: [{ text: "explicit resume" }] }] });
  assert.equal((await f.json(A)).messages[0].text, "explicit resume");
  assert.deepEqual((await f.json(B)).messages, []);
});

test("failed window save or clear preserves the response and other chats, and recovery succeeds", async (t) => {
  const f = await fixture(t, { autoSave: true });
  await f.chat(B, "keep B");
  const file = getSessionPath({ chatId: A });
  fs.mkdirSync(file);
  const response = await f.chat(A, "keep A despite failed save");
  assert.match(response, /Verlauf konnte nicht gespeichert/);
  assert.equal((await f.json(A)).messages.length, 2);
  assert.equal((await f.fetchChat(A, "/api/clear", {})).status, 500);
  assert.equal((await f.json(A)).messages.length, 2);
  assert.equal((await f.json(B)).messages[0].text, "keep B");
  fs.rmdirSync(file);
  assert.ok(!(await f.chat(A, "save succeeds")).includes("Verlauf konnte nicht gespeichert"));
  await f.json(A, "/api/clear", {});
  assert.deepEqual((await f.json(A)).messages, []);
  assert.equal(readSession({ chatId: B }).messages[0].content[0].text, "keep B");
});

test("window count is bounded without evicting existing conversations", async (t) => {
  const f = await fixture(t);
  for (let index = 1; index <= 64; index++) {
    await f.json(`00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);
  }
  assert.equal((await f.fetchChat("00000000-0000-4000-8000-000000000041", "/api/state")).status, 429);
  assert.deepEqual((await f.json(A)).messages, []);
});
