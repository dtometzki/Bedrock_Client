import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInferenceConfig,
  formatBedrockErrorDiagnostics,
  formatBedrockErrorMessage,
  streamConverse
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
