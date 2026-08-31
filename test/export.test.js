import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultExportFilename, exportHistoryToMarkdown, formatHistoryMarkdown } from "../src/export.js";

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

test("exportHistoryToMarkdown schreibt neue und bestehende Dateien privat", {
  skip: process.platform === "win32"
}, (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-export-test-"));
  const targetPath = path.join(tempDir, "chat.md");
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  // Simuliert eine bereits vorhandene, fuer andere Benutzer lesbare Datei.
  fs.writeFileSync(targetPath, "alter Inhalt", { mode: 0o644 });
  fs.chmodSync(targetPath, 0o644);

  exportHistoryToMarkdown([
    { role: "user", content: [{ text: "Vertraulich" }] }
  ], targetPath);

  assert.equal(fs.statSync(targetPath).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(targetPath, "utf8"), /Vertraulich/);
});
