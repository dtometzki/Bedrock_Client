import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function getConfigDir() {
  if (process.env.BEDROCK_CHAT_CONFIG_DIR) {
    return process.env.BEDROCK_CHAT_CONFIG_DIR;
  }

  const baseDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(baseDir, "bedrock-chat");
}

export function getLastModelPath() {
  return path.join(getConfigDir(), "last_model");
}

export function getSettingsPath() {
  return path.join(getConfigDir(), "settings.json");
}

export function readLastModelId(legacyPath = null) {
  const paths = [getLastModelPath(), legacyPath].filter(Boolean);

  for (const modelPath of paths) {
    try {
      if (fs.existsSync(modelPath)) {
        return fs.readFileSync(modelPath, "utf8").trim();
      }
    } catch {}
  }

  return "";
}

export function writeLastModelId(modelId) {
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.writeFileSync(getLastModelPath(), modelId, "utf8");
}

function readSettings() {
  try {
    if (!fs.existsSync(getSettingsPath())) {
      return {};
    }

    const parsed = JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.writeFileSync(getSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function normalizeInferenceOverrides(value) {
  const overrides = {};

  if (Number.isInteger(value?.maxTokens) && value.maxTokens > 0) {
    overrides.maxTokens = value.maxTokens;
  }

  if (Number.isFinite(value?.temperature) && value.temperature >= 0 && value.temperature <= 1) {
    overrides.temperature = value.temperature;
  }

  if (Number.isFinite(value?.topP) && value.topP >= 0 && value.topP <= 1) {
    overrides.topP = value.topP;
  }

  return overrides;
}

export function readSavedInferenceOverrides() {
  const settings = readSettings();
  return normalizeInferenceOverrides(settings.inferenceOverrides);
}

export function writeSavedInferenceOverrides(inferenceOverrides) {
  const settings = readSettings();
  settings.inferenceOverrides = normalizeInferenceOverrides(inferenceOverrides);
  writeSettings(settings);
}

// Liest das zuletzt gewaehlte Effort Level (Denk-Aufwand) aus den Settings.
// Liefert null, wenn nichts Gueltiges gespeichert ist.
export function readSavedEffort() {
  const settings = readSettings();
  const value = settings.effort;
  return typeof value === "string" && value ? value : null;
}

// Speichert das zuletzt gewaehlte Effort Level. null/leer entfernt den Eintrag.
export function writeSavedEffort(effort) {
  const settings = readSettings();
  if (typeof effort === "string" && effort) {
    settings.effort = effort;
  } else {
    delete settings.effort;
  }
  writeSettings(settings);
}
