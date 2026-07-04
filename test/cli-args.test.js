import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_MAX_HISTORY_TURNS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TEMPERATURE,
  parseCliArgs
} from "../src/cli-args.js";

test("parseCliArgs returns defaults", () => {
  assert.deepEqual(parseCliArgs([]), {
    help: false,
    version: false,
    model: null,
    profile: null,
    region: null,
    system: DEFAULT_SYSTEM_PROMPT,
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: DEFAULT_TEMPERATURE,
    topP: null,
    stopSequences: [],
    maxTurns: DEFAULT_MAX_HISTORY_TURNS,
    resume: false,
    noSave: false,
    debug: false,
    web: false,
    port: null,
    noOpen: false,
    inferenceOverrides: {}
  });
});

test("parseCliArgs parses supported options", () => {
  assert.deepEqual(parseCliArgs([
    "--model",
    "claude",
    "--profile",
    "dev",
    "--region",
    "eu-central-1",
    "--system",
    "Kurz antworten.",
    "--max-tokens",
    "512",
    "--temperature",
    "0.2",
    "--top-p",
    "0.8",
    "--stop",
    "STOP",
    "--stop",
    "ENDE",
    "--max-turns",
    "5",
    "--resume",
    "--no-save",
    "--debug",
    "--web",
    "--port",
    "8080",
    "--no-open"
  ]), {
    help: false,
    version: false,
    model: "claude",
    profile: "dev",
    region: "eu-central-1",
    system: "Kurz antworten.",
    maxTokens: 512,
    temperature: 0.2,
    topP: 0.8,
    stopSequences: ["STOP", "ENDE"],
    maxTurns: 5,
    resume: true,
    noSave: true,
    debug: true,
    web: true,
    port: 8080,
    noOpen: true,
    inferenceOverrides: {
      maxTokens: 512,
      temperature: 0.2,
      topP: 0.8,
      stopSequences: ["STOP", "ENDE"]
    }
  });
});

test("parseCliArgs reads system prompt from file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-chat-system-"));
  const filePath = path.join(dir, "system.txt");
  fs.writeFileSync(filePath, "  Antworte auf Deutsch.\n", "utf8");

  assert.equal(parseCliArgs(["--system-file", filePath]).system, "Antworte auf Deutsch.");
  assert.throws(() => parseCliArgs(["--system-file", path.join(dir, "missing.txt")]), /System-Prompt Datei/);
});

test("parseCliArgs parses the region short flag", () => {
  assert.equal(parseCliArgs(["-r", "us-west-2"]).region, "us-west-2");
});

test("parseCliArgs preserves profile list shortcut", () => {
  assert.equal(parseCliArgs(["-p", "-list"]).profile, "list");
  assert.equal(parseCliArgs(["--profile", "--list"]).profile, "list");
});

test("parseCliArgs rejects invalid options", () => {
  assert.throws(() => parseCliArgs(["--wat"]), /Ungueltige Argumente/);
  assert.throws(() => parseCliArgs(["--model"]), /Ungueltige Argumente/);
  assert.throws(() => parseCliArgs(["--max-tokens", "0"]), /Ungueltiger Wert/);
  assert.throws(() => parseCliArgs(["--temperature", "2"]), /Ungueltiger Wert/);
  assert.throws(() => parseCliArgs(["--top-p", "1.5"]), /Ungueltiger Wert/);
  assert.throws(() => parseCliArgs(["--port", "0"]), /Ungueltiger Wert/);
  assert.throws(() => parseCliArgs(["--port", "70000"]), /Ungueltiger Wert/);
});
