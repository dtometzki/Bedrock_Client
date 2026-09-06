// This is a conversation identifier, not an access token. Server APIs still
// require the shared HttpOnly login cookie and same-origin request protection.
export function windowChatId({ storage,
  navigationType = globalThis.performance?.getEntriesByType("navigation")[0]?.type,
  uuid = () => globalThis.crypto.randomUUID() } = {}) {
  const key = "bedrock-window-chat-id";
  let previous;
  try { storage ??= globalThis.sessionStorage; } catch { /* Storage can be disabled. */ }
  try { previous = storage.getItem(key); } catch { /* Storage can be disabled. */ }
  const reuse = ["reload", "back_forward"].includes(navigationType) &&
    typeof previous === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(previous);
  // A fresh navigation gets a new ID even if window.open copied sessionStorage.
  const id = reuse ? previous : uuid();
  try { storage.setItem(key, id); } catch { /* This window still works until reload. */ }
  return id;
}
