import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearSession, getSessionPath, readSession, writeSession } from "../src/session.js";

function withTempConfigDir(run) {
  const previous = process.env.BEDROCK_CHAT_CONFIG_DIR;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-chat-session-"));
  try {
    process.env.BEDROCK_CHAT_CONFIG_DIR = configDir;
    run(configDir);
  } finally {
    if (previous == null) {
      delete process.env.BEDROCK_CHAT_CONFIG_DIR;
    } else {
      process.env.BEDROCK_CHAT_CONFIG_DIR = previous;
    }
  }
}

function message(role, text) {
  return { role, content: [{ text }] };
}

test("session round-trips valid messages and drops invalid ones", () => {
  withTempConfigDir((configDir) => {
    const messages = [
      message("user", "hallo"),
      message("assistant", "hi"),
      { role: "system", content: [{ text: "ignored" }] },
      { role: "user", content: "kaputt" }
    ];

    assert.equal(writeSession(messages, { modelId: "model-a" }), true);
    assert.equal(getSessionPath(), path.join(configDir, "last-session.json"));

    const saved = readSession();
    assert.deepEqual(saved.messages, [message("user", "hallo"), message("assistant", "hi")]);
    assert.equal(saved.modelId, "model-a");
    assert.equal(typeof saved.savedAt, "string");
  });
});

test("reading a missing session returns an empty result", () => {
  withTempConfigDir(() => {
    assert.deepEqual(readSession(), { messages: [], modelId: null, savedAt: null });
  });
});

test("clearSession removes the stored session", () => {
  withTempConfigDir(() => {
    writeSession([message("user", "x"), message("assistant", "y")], { modelId: "m" });
    assert.equal(clearSession(), true);
    assert.deepEqual(readSession().messages, []);
  });
});

test("session file and created config dir are private (0600/0700)", { skip: process.platform === "win32" }, () => {
  withTempConfigDir((configDir) => {
    // Ein noch nicht existierendes Unterverzeichnis, damit der Verzeichnis-
    // Modus von ensureConfigDir selbst stammt (mkdtemp oben liefert schon 700).
    const nestedDir = path.join(configDir, "nested");
    process.env.BEDROCK_CHAT_CONFIG_DIR = nestedDir;

    writeSession([message("user", "geheim"), message("assistant", "ok")], { modelId: "m" });

    // Der Verlauf enthaelt komplette Gespraeche und darf fuer andere Nutzer
    // desselben Rechners weder lesbar noch das Verzeichnis betretbar sein.
    assert.equal(fs.statSync(getSessionPath()).mode & 0o777, 0o600);
    assert.equal(fs.statSync(nestedDir).mode & 0o777, 0o700);
  });
});
