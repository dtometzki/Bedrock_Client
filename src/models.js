import fs from "node:fs";

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

export function findModel(models, requestedModel) {
  if (!requestedModel) return null;
  return models.find((model) => (
    model.id === requestedModel ||
    model.label === requestedModel ||
    model.profileArn === requestedModel ||
    model.inferenceProfileArn === requestedModel ||
    model.aliases?.includes(requestedModel)
  )) ?? null;
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
