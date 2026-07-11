import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./config.js";

const SESSION_VERSION = 1;

export function getSessionPath() {
  return path.join(getConfigDir(), "last-session.json");
}

function isValidMessage(message) {
  return Boolean(message) &&
    (message.role === "user" || message.role === "assistant") &&
    Array.isArray(message.content) &&
    message.content.every((block) => typeof block?.text === "string") &&
    (message.attachmentNames == null || (
      Array.isArray(message.attachmentNames) &&
      message.attachmentNames.every((name) => typeof name === "string")
    ));
}

export function readSession() {
  try {
    const raw = fs.readFileSync(getSessionPath(), "utf8");
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.messages) ? parsed.messages.filter(isValidMessage) : [];
    return {
      messages,
      modelId: typeof parsed?.modelId === "string" ? parsed.modelId : null,
      savedAt: typeof parsed?.savedAt === "string" ? parsed.savedAt : null
    };
  } catch {
    return { messages: [], modelId: null, savedAt: null };
  }
}

export function writeSession(messages, { modelId = null } = {}) {
  try {
    const valid = Array.isArray(messages) ? messages.filter(isValidMessage) : [];
    fs.mkdirSync(getConfigDir(), { recursive: true });
    const payload = {
      version: SESSION_VERSION,
      savedAt: new Date().toISOString(),
      modelId,
      messages: valid
    };
    fs.writeFileSync(getSessionPath(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function clearSession() {
  try {
    fs.rmSync(getSessionPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}
