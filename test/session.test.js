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
