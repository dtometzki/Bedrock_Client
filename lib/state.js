import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Gets the path to the application's state directory.
 * @returns {string} The path to the state directory.
 */
function getStateFilePath() {
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "bedrock-chat", "state.json");
}

/**
 * Gets the path to the application's history directory.
 * @returns {string} The path to the history file.
 */
function getHistoryFilePath() {
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "bedrock-chat", "history.json");
}

/**
 * Loads the last used model ID from the state file.
 * @returns {Promise<string|null>} The model ID or null if not found.
 */
export async function loadLastModelId() {
  try {
    const stateContent = await readFile(getStateFilePath(), "utf8");
    const state = JSON.parse(stateContent);
    return typeof state.lastModelId === "string" ? state.lastModelId : null;
  } catch {
    return null;
  }
}

/**
 * Saves the last used model ID to the state file.
 * @param {string} modelId The model ID to save.
 * @returns {Promise<void>}
 */
export async function saveLastModelId(modelId) {
  try {
    const stateFilePath = getStateFilePath();
    await mkdir(path.dirname(stateFilePath), { recursive: true });
    await writeFile(stateFilePath, JSON.stringify({ lastModelId: modelId }, null, 2), "utf8");
  } catch {
    console.error("[System: Letztes Modell konnte nicht gespeichert werden.]");
  }
}

/**
 * Loads the chat history from the history file.
 * @returns {Promise<Array>} The chat history array or an empty array.
 */
export async function loadChatHistory() {
  try {
    const historyContent = await readFile(getHistoryFilePath(), "utf8");
    const history = JSON.parse(historyContent);
    return Array.isArray(history) ? history : [];
  } catch {
    return [];
  }
}

/**
 * Saves the chat history to the history file.
 * @param {Array} messages The chat messages to save.
 * @returns {Promise<void>}
 */
export async function saveChatHistory(messages) {
  try {
    const historyFilePath = getHistoryFilePath();
    await mkdir(path.dirname(historyFilePath), { recursive: true });
    await writeFile(historyFilePath, JSON.stringify(messages, null, 2), "utf8");
  } catch {
    console.error("[System: Chat-Verlauf konnte nicht gespeichert werden.]");
  }
}
