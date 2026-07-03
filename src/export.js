import fs from "node:fs";
import path from "node:path";

function formatTimestampForFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function defaultExportFilename(date = new Date()) {
  return `bedrock-chat-${formatTimestampForFilename(date)}.md`;
}

export function formatHistoryMarkdown(messages, { modelLabel, systemPrompt, exportedAt = new Date() } = {}) {
  const lines = ["# Bedrock Chat Export", ""];
  lines.push(`- Exportiert: ${exportedAt.toISOString()}`);
  if (modelLabel) {
    lines.push(`- Modell: ${modelLabel}`);
  }
  if (systemPrompt) {
    lines.push(`- System Prompt: ${systemPrompt}`);
  }
  lines.push("");

  for (const message of messages) {
    const heading = message.role === "user" ? "## Du" : "## Assistant";
    const text = (message.content || [])
      .map((block) => block?.text || "")
      .join("")
      .trim();
    lines.push(heading, "", text, "");
  }

  return `${lines.join("\n")}\n`;
}

export function exportHistoryToMarkdown(messages, targetPath, meta = {}) {
  const resolvedPath = path.resolve(targetPath || defaultExportFilename());
  fs.writeFileSync(resolvedPath, formatHistoryMarkdown(messages, meta), "utf8");
  return resolvedPath;
}
