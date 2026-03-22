import { readFile } from "node:fs/promises";

export function formatModelLabel(modelId) {
  return modelId.replace(/^global\.anthropic\./, "");
}

export async function loadModels(fileUrl) {
  const fileContent = await readFile(fileUrl, "utf8");
  const parsedModels = JSON.parse(fileContent);

  if (!Array.isArray(parsedModels) || parsedModels.length === 0) {
    throw new Error("models.json muss ein nicht-leeres Array enthalten.");
  }

  return parsedModels.map((model, index) => {
    if (!model?.id || typeof model.id !== "string") {
      throw new Error(`Modell an Position ${index + 1} benötigt ein string-Feld 'id'.`);
    }

    return {
      id: model.id,
      label: typeof model.label === "string" && model.label.trim()
        ? model.label
        : formatModelLabel(model.id)
    };
  });
}

export function findModel(models, modelName) {
  if (!modelName) return null;

  const normalizedModelName = modelName.toLowerCase();
  return models.find((model) =>
    model.id.toLowerCase() === normalizedModelName ||
    model.label.toLowerCase() === normalizedModelName
  ) ?? null;
}
