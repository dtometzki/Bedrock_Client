export function trimMessagesToMaxTurns(messages, maxTurns) {
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    return messages;
  }

  const maxMessages = maxTurns * 2;
  if (messages.length <= maxMessages) {
    return messages;
  }

  return messages.slice(-maxMessages);
}

export function countHistoryTurns(messages) {
  let userMessages = 0;
  let assistantMessages = 0;
  for (const message of messages) {
    if (message.role === "user") userMessages += 1;
    else if (message.role === "assistant") assistantMessages += 1;
  }
  return Math.min(userMessages, assistantMessages);
}

// Haengt die Assistant-Antwort an die Request-Nachrichten an und begrenzt den
// Verlauf. Bei Abbruch wird der Teiltext mit einem Hinweis markiert.
// Gemeinsam genutzt von CLI (app.js) und Web-Server (web-server.js).
export function appendAssistantResponse(requestMessages, fullResponse, { aborted = false, maxTurns = 0 } = {}) {
  const responseText = aborted
    ? `${fullResponse}\n\n[Antwort abgebrochen – unvollstaendig]`
    : fullResponse;
  return trimMessagesToMaxTurns([
    ...requestMessages,
    { role: "assistant", content: [{ text: responseText }] }
  ], maxTurns);
}

export function formatHistoryLimit(maxTurns) {
  return maxTurns > 0 ? `${maxTurns} Turns` : "unbegrenzt";
}
