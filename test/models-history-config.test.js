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
import { findModel, getModelInvocationId, loadModels, normalizeEffort, normalizeModel, resolveStartupModel } from "../src/models.js";

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

test("normalizeEffort validates levels and falls back to a sensible default", () => {
  assert.equal(normalizeEffort({ id: "m" }), null);
  assert.equal(normalizeEffort({ id: "m", effort: { levels: [] } }), null);
  assert.deepEqual(
    normalizeEffort({ id: "m", effort: { levels: ["low", "medium", "high"], default: "high" } }),
    { levels: ["low", "medium", "high"], default: "high", style: "thinking" }
  );
  // Ungueltiger Default faellt auf "high" zurueck, wenn vorhanden.
  assert.deepEqual(
    normalizeEffort({ id: "m", effort: { levels: ["low", "medium", "high"], default: "turbo" } }),
    { levels: ["low", "medium", "high"], default: "high", style: "thinking" }
  );
  // Ohne "high" faellt der Default auf das letzte Level.
  assert.deepEqual(
    normalizeEffort({ id: "m", effort: { levels: ["low", "medium"] } }),
    { levels: ["low", "medium"], default: "medium", style: "thinking" }
  );
  // Expliziter output_config-Stil wird uebernommen.
  assert.deepEqual(
    normalizeEffort({ id: "m", effort: { levels: ["low", "high"], default: "high", style: "output_config" } }),
    { levels: ["low", "high"], default: "high", style: "output_config" }
  );
});

test("profile ARN can be used as Bedrock invocation id", () => {
  const model = normalizeModel({
    id: "global.model-a",
    label: "Model A",
    aliases: ["old-model-a"],
    profileArn: "arn:aws:bedrock:eu-central-1:123456789012:inference-profile/global.model-a"
  });

  assert.equal(getModelInvocationId(model), model.profileArn);
  assert.equal(findModel([model], model.profileArn).id, "global.model-a");
  assert.equal(resolveStartupModel([model], { lastModelId: "old-model-a" }).id, "global.model-a");
});

test("disabled models are not loaded", () => {
  const modelsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-chat-models-")), "models.json");
  fs.writeFileSync(modelsPath, JSON.stringify([
    { id: "model-a" },
    { id: "model-b", disabled: true }
  ]), "utf8");

  assert.deepEqual(loadModels(modelsPath).map((model) => model.id), ["model-a"]);
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
      topP: 0.9,
      ignored: true
    });

    assert.equal(getSettingsPath(), path.join(configDir, "settings.json"));
    assert.deepEqual(readSavedInferenceOverrides(), {
      maxTokens: 4096,
      temperature: 0.25,
      topP: 0.9
    });
  } finally {
    if (previousConfigDir == null) {
      delete process.env.BEDROCK_CHAT_CONFIG_DIR;
    } else {
      process.env.BEDROCK_CHAT_CONFIG_DIR = previousConfigDir;
    }
  }
});
