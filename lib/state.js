import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function getStateFilePath() {
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "bedrock-chat", "state.json");
}

export async function loadLastModelId() {
  try {
    const stateContent = await readFile(getStateFilePath(), "utf8");
    const state = JSON.parse(stateContent);
    return typeof state.lastModelId === "string" ? state.lastModelId : null;
  } catch (error) {
    return null;
  }
}

export async function saveLastModelId(modelId) {
  try {
    const stateFilePath = getStateFilePath();
    await mkdir(path.dirname(stateFilePath), { recursive: true });
    await writeFile(
      stateFilePath,
      JSON.stringify({ lastModelId: modelId }, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("[System: Letztes Modell konnte nicht gespeichert werden.]");
  }
}
