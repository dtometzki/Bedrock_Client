import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { readSecret, manageAuth } from "../src/auth-prompt.js";

function terminal() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.isPaused = () => true;
  input.setRawMode = (raw) => { input.isRaw = raw; };
  input.resume = () => {};
  input.pause = () => {};
  let printed = "";
  const output = { isTTY: true, write: (text) => { printed += text; } };
  return { input, output, printed: () => printed };
}

test("secret prompts never echo typed/pasted secrets and restore terminal state", async () => {
  const term = terminal();
  let touches = 0;
  const pending = readSecret("Masterpasswort:", { ...term, onActivity: () => touches++ });
  assert.equal(term.input.isRaw, true);
  term.input.emit("data", Buffer.from("private-test-passphrase"));
  term.input.emit("data", Buffer.from("\x7fX\r"));
  assert.equal(await pending, "private-test-passphrasX");
  assert.equal(term.printed(), "Masterpasswort: \n");
  assert.equal(term.input.isRaw, false);
  assert.equal(term.input.listenerCount("data"), 0);
  assert.equal(touches, 2);
});

test("cancel, terminal failure and non-TTY input do not disclose secrets or retain listeners", async () => {
  for (const event of ["cancel", "end", "error"]) {
    const term = terminal();
    const pending = readSecret("Secret:", term);
    term.input.emit("data", Buffer.from("private-key"));
    if (event === "cancel") term.input.emit("data", Buffer.from("\x03"));
    else term.input.emit(event, new Error("private-key"));
    await assert.rejects(pending);
    assert.ok(!term.printed().includes("private-key"));
    assert.equal(term.input.isRaw, false);
    assert.equal(term.input.listenerCount("data"), 0);
  }
  await assert.rejects(readSecret("Password:", { input: { isTTY: false }, output: {} }), /interaktives Terminal/);
});

test("auth management only accepts command names, never password arguments", async () => {
  await assert.rejects(manageAuth({}, "unlock private-test-passphrase"), /Unbekannter/);
});

test("secret prompts preserve Unicode across split terminal data chunks", async () => {
  const term = terminal();
  const pending = readSecret("Password:", term);
  const encoded = Buffer.from("äöü🔐test-passphrase");
  for (const byte of encoded) term.input.emit("data", Buffer.from([byte]));
  term.input.emit("data", Buffer.from("\r"));
  assert.equal(await pending, "äöü🔐test-passphrase");
  assert.equal(term.printed(), "Password: \n");
});
