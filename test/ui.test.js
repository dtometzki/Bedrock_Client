import assert from "node:assert/strict";
import test from "node:test";
import { formatInferenceConfig } from "../src/ui.js";

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
