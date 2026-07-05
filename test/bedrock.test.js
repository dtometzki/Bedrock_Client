import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAdaptiveThinkingFields,
  buildInferenceConfig,
  formatBedrockErrorDiagnostics,
  formatBedrockErrorMessage,
  getRetryDelayMs,
  isAbortError,
  isRetryableError,
  streamConverse,
  streamConverseWithRetry
} from "../src/bedrock.js";

function streamFrom(events) {
  return (async function* generateEvents() {
    for (const event of events) {
      yield event;
    }
  })();
}

test("buildInferenceConfig merges defaults, model config and CLI overrides", () => {
  assert.deepEqual(buildInferenceConfig({
    inferenceConfig: { maxTokens: 100, topP: 0.9 },
    temperature: 0.4
  }, {
    maxTokens: 50
  }), {
    maxTokens: 50,
    temperature: 0.4,
    topP: 0.9
  });
});

test("buildInferenceConfig omits disabled model fields after CLI overrides", () => {
  assert.deepEqual(buildInferenceConfig({
    inferenceConfig: { maxTokens: 100, temperature: 0.4 },
    disabledInferenceConfigFields: ["temperature"]
  }, {
    temperature: 0.2
  }), {
    maxTokens: 100
  });
});

test("buildInferenceConfig applies topP and stopSequences overrides", () => {
  assert.deepEqual(buildInferenceConfig({}, {
    topP: 0.5,
    stopSequences: ["STOP"]
  }), {
    maxTokens: 2000,
    temperature: 0.7,
    topP: 0.5,
    stopSequences: ["STOP"]
  });

  const withoutStop = buildInferenceConfig({}, { stopSequences: [] });
  assert.equal("stopSequences" in withoutStop, false);
});

test("buildAdaptiveThinkingFields maps effort per request style or nothing", () => {
  // Standard-Stil (Opus 4.6, Sonnet 4.6): effort steckt in thinking.
  assert.deepEqual(buildAdaptiveThinkingFields("low"), { thinking: { type: "adaptive", effort: "low" } });
  assert.deepEqual(
    buildAdaptiveThinkingFields("high", "thinking"),
    { thinking: { type: "adaptive", effort: "high" } }
  );
  // output_config-Stil (Opus 4.8, Sonnet 5, Fable 5): effort separat.
  assert.deepEqual(
    buildAdaptiveThinkingFields("medium", "output_config"),
    { thinking: { type: "adaptive" }, output_config: { effort: "medium" } }
  );
  assert.equal(buildAdaptiveThinkingFields(null), undefined);
  assert.equal(buildAdaptiveThinkingFields("", "output_config"), undefined);
});

test("streamConverse forwards additionalModelRequestFields when present", async () => {
  let sentCommand;
  const client = {
    async send(command) {
      sentCommand = command;
      return { stream: streamFrom([{ contentBlockDelta: { delta: { text: "ok" } } }]) };
    }
  };

  for await (const event of streamConverse(client, {
    modelId: "model-a",
    messages: [],
    additionalModelRequestFields: { thinking: { type: "adaptive", effort: "high" } }
  })) {
    void event;
  }
  assert.deepEqual(sentCommand.input.additionalModelRequestFields, {
    thinking: { type: "adaptive", effort: "high" }
  });

  let plainCommand;
  const plainClient = {
    async send(command) {
      plainCommand = command;
      return { stream: streamFrom([{ contentBlockDelta: { delta: { text: "ok" } } }]) };
    }
  };
  for await (const event of streamConverse(plainClient, { modelId: "model-a", messages: [] })) {
    void event;
  }
  assert.equal("additionalModelRequestFields" in plainCommand.input, false);
});

test("isRetryableError recognizes throttling, status codes and retryable flags", () => {
  assert.equal(isRetryableError({ name: "ThrottlingException" }), true);
  assert.equal(isRetryableError({ $retryable: {} }), true);
  assert.equal(isRetryableError({ $metadata: { httpStatusCode: 503 } }), true);
  assert.equal(isRetryableError({ originalStatusCode: 500 }), true);
  assert.equal(isRetryableError({ name: "ValidationException", $metadata: { httpStatusCode: 400 } }), false);
  assert.equal(isRetryableError({ name: "AbortError" }), false);
  assert.equal(isRetryableError(null), false);
});

test("isAbortError detects abort and timeout errors", () => {
  assert.equal(isAbortError({ name: "AbortError" }), true);
  assert.equal(isAbortError({ name: "TimeoutError" }), true);
  assert.equal(isAbortError({ aborted: true }), true);
  assert.equal(isAbortError({ name: "ThrottlingException" }), false);
});

test("getRetryDelayMs grows with attempts and stays capped", () => {
  const first = getRetryDelayMs(1, 500, 8000);
  const second = getRetryDelayMs(2, 500, 8000);
  assert.ok(first >= 500 && first <= 1000);
  assert.ok(second >= 1000 && second <= 1500);
  assert.ok(getRetryDelayMs(20, 500, 8000) <= 8000);
});

test("streamConverseWithRetry retries a retryable initial failure then succeeds", async () => {
  let attempts = 0;
  const client = {
    async send() {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("throttled");
        err.name = "ThrottlingException";
        throw err;
      }
      return {
        stream: streamFrom([
          { contentBlockDelta: { delta: { text: "ok" } } }
        ])
      };
    }
  };

  const events = [];
  for await (const event of streamConverseWithRetry(client, {
    modelId: "model-a",
    messages: []
  }, { maxRetries: 2, sleep: async () => {} })) {
    events.push(event);
  }

  assert.equal(attempts, 2);
  assert.deepEqual(events.map((event) => event.type), ["retry", "text"]);
  assert.equal(events[0].attempt, 1);
});

test("streamConverseWithRetry does not retry after text was already yielded", async () => {
  let attempts = 0;
  const client = {
    async send() {
      attempts += 1;
      return {
        stream: streamFrom([
          { contentBlockDelta: { delta: { text: "partial" } } },
          {
            modelStreamErrorException: {
              name: "ModelStreamErrorException",
              message: "mid-stream failure"
            }
          }
        ])
      };
    }
  };

  const seen = [];
  await assert.rejects(async () => {
    for await (const event of streamConverseWithRetry(client, {
      modelId: "model-a",
      messages: []
    }, { maxRetries: 3, sleep: async () => {} })) {
      seen.push(event);
    }
  }, /mid-stream failure/);

  assert.equal(attempts, 1);
  assert.deepEqual(seen.map((event) => event.type), ["text"]);
});

test("streamConverse throws AbortError when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = {
    async send() {
      return { stream: streamFrom([{ contentBlockDelta: { delta: { text: "x" } } }]) };
    }
  };

  await assert.rejects(async () => {
    for await (const event of streamConverse(client, {
      modelId: "model-a",
      messages: [],
      abortSignal: controller.signal
    })) {
      void event;
    }
  }, (err) => isAbortError(err));
});

test("streamConverse yields text and usage events", async () => {
  let sentCommand;
  const client = {
    async send(command) {
      sentCommand = command;
      return {
        stream: streamFrom([
          { contentBlockDelta: { delta: { text: "Hallo" } } },
          { metadata: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, metrics: { latencyMs: 42 } } }
        ])
      };
    }
  };

  const events = [];
  for await (const event of streamConverse(client, {
    modelId: "model-a",
    messages: [],
    inferenceConfig: { maxTokens: 123, temperature: 0.2 }
  })) {
    events.push(event);
  }

  assert.equal(sentCommand.input.modelId, "model-a");
  assert.deepEqual(sentCommand.input.inferenceConfig, { maxTokens: 123, temperature: 0.2 });
  assert.deepEqual(events, [
    { type: "text", text: "Hallo" },
    {
      type: "usage",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      metrics: { latencyMs: 42 }
    }
  ]);
});

test("streamConverse surfaces Bedrock stream exception events", async () => {
  const client = {
    async send() {
      return {
        stream: streamFrom([
          {
            modelStreamErrorException: {
              name: "ModelStreamErrorException",
              message: "stream failed",
              originalStatusCode: 500,
              originalMessage: "provider failed",
              $metadata: { httpStatusCode: 424, requestId: "req-1" },
              $fault: "client"
            }
          }
        ])
      };
    }
  };

  let thrown;
  try {
    for await (const event of streamConverse(client, {
      modelId: "model-a",
      messages: []
    })) {
      assert.fail(`unexpected event: ${event.type}`);
    }
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown);
  assert.equal(thrown.name, "ModelStreamErrorException");
  assert.equal(thrown.message, "stream failed");
  assert.equal(thrown.streamEvent, "modelStreamErrorException");
  assert.equal(thrown.originalStatusCode, 500);
  assert.equal(thrown.originalMessage, "provider failed");
  assert.equal(formatBedrockErrorMessage(thrown), "ModelStreamErrorException: stream failed");
  assert.deepEqual(formatBedrockErrorDiagnostics(thrown, {
    model: { id: "model-a", label: "Model A" },
    modelId: "profile-a",
    region: "eu-central-1",
    inferenceConfig: { maxTokens: 100 }
  }), [
    "Modell: Model A (model-a)",
    "Bedrock modelId: profile-a",
    "Region: eu-central-1",
    "Inference Config: {\"maxTokens\":100}",
    "Stream Event: modelStreamErrorException",
    "Fehlertyp: ModelStreamErrorException",
    "Fault: client",
    "HTTP Status: 424",
    "Original Status: 500",
    "Request ID: req-1",
    "Originalmeldung: provider failed"
  ]);
});

test("streamConverse yields reasoning deltas separately from text", async () => {
  const client = {
    async send() {
      return {
        stream: streamFrom([
          { contentBlockDelta: { delta: { reasoningContent: { text: "denke nach" } } } },
          { contentBlockDelta: { delta: { text: "Antwort" } } }
        ])
      };
    }
  };

  const events = [];
  for await (const event of streamConverse(client, { modelId: "model-a", messages: [] })) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { type: "reasoning", text: "denke nach" },
    { type: "text", text: "Antwort" }
  ]);
});
