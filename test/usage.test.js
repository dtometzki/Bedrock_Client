import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MODEL_PRICING_UPDATED,
  getModelPricing
} from "../src/usage.js";

const FALLBACK_SOURCE = `integrierte Preistabelle (Stand ${DEFAULT_MODEL_PRICING_UPDATED})`;

test("getModelPricing nutzt gueltige Preise aus models.json", () => {
  const pricing = getModelPricing({
    id: "custom-model",
    pricingUsdPer1M: { input: 1.5, output: 7.5 }
  });

  assert.deepEqual(pricing, { input: 1.5, output: 7.5, source: "models.json" });
});

test("getModelPricing uebernimmt eine eigene source-Angabe", () => {
  const pricing = getModelPricing({
    id: "custom-model",
    pricingUsdPer1M: { input: 1, output: 2, source: "Preisliste 2026-07" }
  });

  assert.equal(pricing.source, "Preisliste 2026-07");
});

test("getModelPricing akzeptiert numerische Strings", () => {
  const pricing = getModelPricing({
    id: "custom-model",
    pricingUsdPer1M: { input: "3", output: "15" }
  });

  assert.equal(pricing.input, 3);
  assert.equal(pricing.output, 15);
});

test("getModelPricing faellt bei ungueltigen Werten auf die eingebaute Tabelle zurueck", () => {
  const pricing = getModelPricing({
    id: "anthropic.claude-sonnet-4-6",
    pricingUsdPer1M: { input: "3$", output: "15$" }
  });

  assert.deepEqual(pricing, { input: 3, output: 15, source: FALLBACK_SOURCE });
});

test("getModelPricing liefert null bei ungueltigen Werten ohne Tabellen-Treffer", () => {
  const pricing = getModelPricing({
    id: "custom-model",
    pricingUsdPer1M: { input: "teuer", output: "3" }
  });

  assert.equal(pricing, null);
});

test("getModelPricing nutzt die eingebaute Tabelle ohne konfigurierte Preise", () => {
  const pricing = getModelPricing({ id: "anthropic.claude-opus-4-1", label: "Claude Opus 4.1" });

  assert.deepEqual(pricing, { input: 15, output: 75, source: FALLBACK_SOURCE });
});

test("getModelPricing liefert null fuer unbekannte Modelle ohne Preise", () => {
  assert.equal(getModelPricing({ id: "irgendein-modell" }), null);
  assert.equal(getModelPricing(null), null);
});
