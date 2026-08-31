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
  const fileDescriptor = fs.openSync(resolvedPath, "w", 0o600);
  try {
    // openSync wendet den Modus nur bei neuen Dateien an. fchmodSync zieht
    // deshalb auch eine bereits vorhandene, zu offen lesbare Zieldatei auf
    // POSIX-Systemen auf private Rechte, bevor der vertrauliche Chat-Inhalt
    // geschrieben wird. Unter Windows gelten stattdessen die Verzeichnis-ACLs.
    if (process.platform !== "win32") {
      fs.fchmodSync(fileDescriptor, 0o600);
    }
    fs.writeFileSync(fileDescriptor, formatHistoryMarkdown(messages, meta), "utf8");
  } finally {
    fs.closeSync(fileDescriptor);
  }
  return resolvedPath;
}
