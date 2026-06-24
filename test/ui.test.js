import assert from "node:assert/strict";
import test from "node:test";
import { ANSI, formatAccountSummary, formatInferenceConfig } from "../src/ui.js";

test("formatInferenceConfig shows max tokens and temperature", () => {
  assert.equal(formatInferenceConfig({
    maxTokens: 4096,
    temperature: 0.25
  }), "Max Tokens: 4.096 | Temperatur: 0,25");
});

test("formatInferenceConfig omits missing values", () => {
  assert.equal(formatInferenceConfig({ maxTokens: 2000 }), "Max Tokens: 2.000");
  assert.equal(formatInferenceConfig(), "");
});

test("formatAccountSummary shows identity and active profile region", () => {
  assert.deepEqual(formatAccountSummary({
    profile: "default",
    region: "eu-central-1",
    identityLabel: "Damian (Admins, 123456789012)"
  }), [
    `${ANSI.green}Account:${ANSI.reset} Damian (Admins, 123456789012)`,
    `${ANSI.green}AWS Profil:${ANSI.reset} default (eu-central-1)`
  ]);
});
