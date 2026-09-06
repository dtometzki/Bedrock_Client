import fs from "node:fs";
import path from "node:path";
import { ensureConfigDir, getConfigDir, writeFileAtomic } from "./config.js";

const SESSION_VERSION = 1;

export function isValidChatId(value) {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}

export function getSessionPath({ chatId = null } = {}) {
  if (chatId === null) return path.join(getConfigDir(), "last-session.json");
  if (!isValidChatId(chatId)) throw new Error("Ungueltige Chat-ID.");
  return path.join(getConfigDir(), "web-chats", `${chatId}.json`);
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

export function readSession({ chatId = null } = {}) {
  try {
    const raw = fs.readFileSync(getSessionPath({ chatId }), "utf8");
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

export function writeSession(messages, { modelId = null, chatId = null } = {}) {
  try {
    const valid = Array.isArray(messages) ? messages.filter(isValidMessage) : [];
    const file = getSessionPath({ chatId });
    ensureConfigDir();
    if (chatId) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const payload = {
      version: SESSION_VERSION,
      savedAt: new Date().toISOString(),
      modelId,
      messages: valid
    };
    // Atomar schreiben: die Session-Datei wird nach jedem Turn komplett neu
    // geschrieben – ein Abbruch mittendrin wuerde sonst den gesamten Verlauf
    // unbrauchbar machen (readSession faengt den JSON-Fehler still ab).
    writeFileAtomic(file, `${JSON.stringify(payload, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function clearSession({ chatId = null } = {}) {
  try {
    fs.rmSync(getSessionPath({ chatId }), { force: true });
    return true;
  } catch {
    return false;
  }
}
