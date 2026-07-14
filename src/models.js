import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./config.js";

// Pfad zu einer optionalen, nutzereigenen models.json im Konfigurationsverzeichnis
// (~/.config/bedrock-chat/models.json). Sie ueberschreibt die mitgelieferte Datei
// komplett, damit account-spezifische Eintraege (z. B. Inference-Profile-ARNs)
// nicht im npm-Paket landen muessen.
export function getUserModelsPath() {
  return path.join(getConfigDir(), "models.json");
}

export function resolveModelsPath(defaultPath) {
  const userPath = getUserModelsPath();
  try {
    if (fs.existsSync(userPath)) {
      return userPath;
    }
  } catch {}
  return defaultPath;
}

export function normalizeModel(model, index = 0) {
  if (!model || typeof model !== "object" || !model.id) {
    throw new Error(`Ungueltiger Modelle Eintrag an Position ${index + 1}: id fehlt.`);
  }

  return {
    ...model,
    label: model.label || model.id
  };
}

export function getModelInvocationId(model) {
  return model?.profileArn || model?.inferenceProfileArn || model?.id;
}

// Normalisiert die Effort-Konfiguration eines Modells. Liefert null, wenn das
// Modell kein adaptives Thinking (Effort Level) unterstuetzt.
export function normalizeEffort(model) {
  const config = model?.effort;
  if (!config) return null;

  const levels = Array.isArray(config.levels)
    ? config.levels.filter((level) => typeof level === "string" && level)
    : [];
  if (!levels.length) return null;

  const fallback = levels.includes("high") ? "high" : levels[levels.length - 1];
  const defaultLevel = levels.includes(config.default) ? config.default : fallback;
  const style = config.style === "output_config" ? "output_config" : "thinking";
  return { levels, default: defaultLevel, style };
}

// Bestimmt das anzuwendende Effort Level fuer ein Modell. Bevorzugt den
// uebergebenen Wunsch (z. B. gespeicherte Nutzerwahl), faellt aber auf den
// Modell-Default zurueck, wenn der Wunsch fuer dieses Modell nicht gueltig ist.
// Liefert null, wenn das Modell kein Effort Level unterstuetzt.
export function resolveEffortLevel(model, preferred = null) {
  const config = normalizeEffort(model);
  if (!config) return null;
  return config.levels.includes(preferred) ? preferred : config.default;
}

export function loadModels(modelsPath) {
  let parsed;

  try {
    parsed = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  } catch (err) {
    throw new Error(`models.json konnte nicht gelesen werden: ${err.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("models.json muss mindestens ein Modell enthalten.");
  }

  const models = parsed
    .map(normalizeModel)
    .filter((model) => !model.disabled);

  if (models.length === 0) {
    throw new Error("models.json muss mindestens ein aktiviertes Modell enthalten.");
  }

  return models;
}

// Einzige Quelle fuer die Frage "bezeichnet dieser Wert dieses Modell?".
// Wird von findModel und der Modellauswahl (prompt.js) gemeinsam genutzt,
// damit die Matching-Regeln nicht auseinanderdriften.
export function modelMatches(model, requestedModel) {
  return Boolean(model) && (
    model.id === requestedModel ||
    model.label === requestedModel ||
    model.profileArn === requestedModel ||
    model.inferenceProfileArn === requestedModel ||
    Boolean(model.aliases?.includes(requestedModel))
  );
}

export function findModel(models, requestedModel) {
  if (!requestedModel) return null;
  return models.find((model) => modelMatches(model, requestedModel)) ?? null;
}

export function formatModelChoices(models) {
  return models.map((model) => `${model.label} (${model.id})`).join(", ");
}

export function resolveStartupModel(models, { requestedModel, lastModelId } = {}) {
  if (requestedModel) {
    const model = findModel(models, requestedModel);
    if (!model) {
      throw new Error(`Modell nicht gefunden: ${requestedModel}\nVerfuegbar: ${formatModelChoices(models)}`);
    }
    return model;
  }

  return findModel(models, lastModelId) ?? models[0];
}
