import assert from "node:assert/strict";
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
    system: DEFAULT_SYSTEM_PROMPT,
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: DEFAULT_TEMPERATURE,
    maxTurns: DEFAULT_MAX_HISTORY_TURNS,
    inferenceOverrides: {}
  });
});

test("parseCliArgs parses supported options", () => {
  assert.deepEqual(parseCliArgs([
    "--model",
    "claude",
    "--profile",
    "dev",
    "--system",
    "Kurz antworten.",
    "--max-tokens",
    "512",
    "--temperature",
    "0.2",
    "--max-turns",
    "5"
  ]), {
    help: false,
    version: false,
    model: "claude",
    profile: "dev",
    system: "Kurz antworten.",
    maxTokens: 512,
    temperature: 0.2,
    maxTurns: 5,
    inferenceOverrides: {
      maxTokens: 512,
      temperature: 0.2
    }
  });
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
});
