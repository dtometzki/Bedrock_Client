import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getLastModelPath,
  getSettingsPath,
  readLastModelId,
  readSavedInferenceOverrides,
  writeLastModelId,
  writeSavedInferenceOverrides
} from "../src/config.js";
import { countHistoryTurns, formatHistoryLimit, trimMessagesToMaxTurns } from "../src/history.js";
import { findModel, normalizeModel, resolveStartupModel } from "../src/models.js";

function message(role, text) {
  return { role, content: [{ text }] };
}

test("models are normalized and resolved strictly", () => {
  const models = [
    normalizeModel({ id: "model-a" }),
    normalizeModel({ id: "model-b", label: "Beta" })
  ];

  assert.equal(models[0].label, "model-a");
  assert.equal(findModel(models, "Beta").id, "model-b");
  assert.equal(resolveStartupModel(models, { lastModelId: "model-a" }).id, "model-a");
  assert.equal(resolveStartupModel(models, { requestedModel: "Beta" }).id, "model-b");
  assert.throws(() => resolveStartupModel(models, { requestedModel: "missing" }), /Modell nicht gefunden/);
  assert.throws(() => normalizeModel({}, 1), /id fehlt/);
});

test("history is trimmed by completed chat turns", () => {
  const messages = [
    message("user", "u1"),
    message("assistant", "a1"),
    message("user", "u2"),
    message("assistant", "a2"),
    message("user", "u3"),
    message("assistant", "a3")
  ];

  const trimmed = trimMessagesToMaxTurns(messages, 2);
  assert.deepEqual(trimmed.map((entry) => entry.content[0].text), ["u2", "a2", "u3", "a3"]);
  assert.equal(countHistoryTurns(trimmed), 2);
  assert.equal(trimMessagesToMaxTurns(messages, 0), messages);
  assert.equal(formatHistoryLimit(0), "unbegrenzt");
});

test("last model is stored in the user config directory", () => {
  const previousConfigDir = process.env.BEDROCK_CHAT_CONFIG_DIR;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-chat-test-"));

  try {
    process.env.BEDROCK_CHAT_CONFIG_DIR = configDir;
    writeLastModelId("model-a");

    assert.equal(getLastModelPath(), path.join(configDir, "last_model"));
    assert.equal(readLastModelId(), "model-a");
  } finally {
    if (previousConfigDir == null) {
      delete process.env.BEDROCK_CHAT_CONFIG_DIR;
    } else {
      process.env.BEDROCK_CHAT_CONFIG_DIR = previousConfigDir;
    }
  }
});

test("inference overrides are persisted in settings", () => {
  const previousConfigDir = process.env.BEDROCK_CHAT_CONFIG_DIR;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-chat-test-"));

  try {
    process.env.BEDROCK_CHAT_CONFIG_DIR = configDir;
    writeSavedInferenceOverrides({
      maxTokens: 4096,
      temperature: 0.25,
      ignored: true
    });

    assert.equal(getSettingsPath(), path.join(configDir, "settings.json"));
    assert.deepEqual(readSavedInferenceOverrides(), {
      maxTokens: 4096,
      temperature: 0.25
    });
  } finally {
    if (previousConfigDir == null) {
      delete process.env.BEDROCK_CHAT_CONFIG_DIR;
    } else {
      process.env.BEDROCK_CHAT_CONFIG_DIR = previousConfigDir;
    }
  }
});
