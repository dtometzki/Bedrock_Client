import test from "node:test";
import assert from "node:assert/strict";
import { consumeConverseStream } from "../src/stream-consumer.js";
import { emptyUsageTotals } from "../src/usage.js";

async function* streamFrom(events) {
  for (const event of events) {
    yield event;
  }
}

async function* failingStream(events, error) {
  for (const event of events) {
    yield event;
  }
  throw error;
}

const TEST_MODEL = { id: "model-a", label: "Modell A" };

test("consumeConverseStream sammelt Text, Reasoning und Usage", async () => {
  const usageTotals = emptyUsageTotals();
  const seen = { text: [], reasoning: [] };

  const result = await consumeConverseStream(streamFrom([
    { type: "reasoning", text: "denke..." },
    { type: "text", text: "Hallo" },
    { type: "text", text: " Welt" },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 42 } }
  ]), {
    usageTotals,
    model: TEST_MODEL,
    onText: (text) => seen.text.push(text),
    onReasoning: (text) => seen.reasoning.push(text)
  });

  assert.equal(result.fullResponse, "Hallo Welt");
  assert.deepEqual(seen.text, ["Hallo", " Welt"]);
  assert.deepEqual(seen.reasoning, ["denke..."]);
  assert.equal(result.aborted, false);
  assert.equal(result.error, null);
  assert.equal(result.usageRecord.totalTokens, 15);
  assert.equal(usageTotals.requests, 1);
  assert.equal(usageTotals.totalTokens, 15);
});

test("consumeConverseStream meldet Retry-Events ueber den Callback", async () => {
  const retries = [];
  const retryError = new Error("throttled");

  const result = await consumeConverseStream(streamFrom([
    { type: "retry", attempt: 1, maxRetries: 3, delayMs: 500, error: retryError },
    { type: "text", text: "ok" }
  ]), {
    onRetry: (event) => retries.push(event)
  });

  assert.equal(retries.length, 1);
  assert.equal(retries[0].attempt, 1);
  assert.equal(result.fullResponse, "ok");
  assert.equal(result.error, null);
});

test("consumeConverseStream klassifiziert Nutzer-Abbruch als aborted und behaelt den Teiltext", async () => {
  const abortError = new Error("aborted");
  abortError.name = "AbortError";

  const result = await consumeConverseStream(
    failingStream([{ type: "text", text: "Teil" }], abortError),
    {}
  );

  assert.equal(result.aborted, true);
  assert.equal(result.error, null);
  assert.equal(result.fullResponse, "Teil");
});

test("consumeConverseStream klassifiziert ein abgelaufenes Signal als Abbruch", async () => {
  const controller = new AbortController();
  controller.abort();
  const otherError = new Error("boom");

  const result = await consumeConverseStream(
    failingStream([], otherError),
    { abortSignal: controller.signal }
  );

  assert.equal(result.aborted, true);
  assert.equal(result.error, null);
});

test("consumeConverseStream gibt Nicht-Abbruch-Fehler als error zurueck", async () => {
  const apiError = new Error("ValidationException");

  const result = await consumeConverseStream(
    failingStream([{ type: "text", text: "Teil" }], apiError),
    {}
  );

  assert.equal(result.aborted, false);
  assert.equal(result.error, apiError);
  assert.equal(result.fullResponse, "Teil");
});

test("consumeConverseStream funktioniert ohne usageTotals und Callbacks", async () => {
  const result = await consumeConverseStream(streamFrom([
    { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    { type: "text", text: "ok" }
  ]));

  assert.equal(result.fullResponse, "ok");
  assert.equal(result.usageRecord, null);
});
