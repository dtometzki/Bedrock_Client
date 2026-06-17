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
  const userMessages = messages.filter((message) => message.role === "user").length;
  const assistantMessages = messages.filter((message) => message.role === "assistant").length;
  return Math.min(userMessages, assistantMessages);
}

export function formatHistoryLimit(maxTurns) {
  return maxTurns > 0 ? `${maxTurns} Turns` : "unbegrenzt";
}
