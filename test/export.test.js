import assert from "node:assert/strict";
import test from "node:test";
import { defaultExportFilename, formatHistoryMarkdown } from "../src/export.js";

test("defaultExportFilename enthaelt Zeitstempel und .md Endung", () => {
  const name = defaultExportFilename(new Date(2026, 6, 3, 9, 5, 7));
  assert.equal(name, "bedrock-chat-20260703-090507.md");
});

test("formatHistoryMarkdown rendert Meta und Nachrichten", () => {
  const markdown = formatHistoryMarkdown([
    { role: "user", content: [{ text: "Hallo" }] },
    { role: "assistant", content: [{ text: "Hi, wie kann ich helfen?" }] }
  ], {
    modelLabel: "claude-sonnet-5",
    systemPrompt: "Antworte kurz.",
    exportedAt: new Date("2026-07-03T09:00:00.000Z")
  });

  assert.match(markdown, /^# Bedrock Chat Export/);
  assert.match(markdown, /- Modell: claude-sonnet-5/);
  assert.match(markdown, /- System Prompt: Antworte kurz\./);
  assert.match(markdown, /## Du\n\nHallo/);
  assert.match(markdown, /## Assistant\n\nHi, wie kann ich helfen\?/);
});

test("formatHistoryMarkdown funktioniert ohne Meta", () => {
  const markdown = formatHistoryMarkdown([
    { role: "user", content: [{ text: "Test" }] }
  ]);
  assert.doesNotMatch(markdown, /- Modell:/);
  assert.match(markdown, /## Du\n\nTest/);
});
