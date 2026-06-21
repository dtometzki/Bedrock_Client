import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";

export const DEFAULT_INFERENCE_CONFIG = {
  maxTokens: 2000,
  temperature: 0.7
};

export function createBedrockClient(creds) {
  return new BedrockRuntimeClient({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken || undefined
    }
  });
}

export function buildInferenceConfig(model, overrides = {}) {
  const config = {
    ...DEFAULT_INFERENCE_CONFIG,
    ...(model?.inferenceConfig || {}),
    ...(model?.maxTokens != null && { maxTokens: model.maxTokens }),
    ...(model?.temperature != null && { temperature: model.temperature }),
    ...(overrides.maxTokens != null && { maxTokens: overrides.maxTokens }),
    ...(overrides.temperature != null && { temperature: overrides.temperature })
  };

  for (const field of model?.disabledInferenceConfigFields || []) {
    delete config[field];
  }

  return config;
}

function getStreamException(event) {
  const entry = Object.entries(event)
    .find(([key, value]) => key.endsWith("Exception") && value);

  if (!entry) return null;

  const [name, details] = entry;
  const message = details.message || details.Message || JSON.stringify(details);
  return new Error(`${name}: ${message}`);
}

export async function* streamConverse(client, { modelId, messages, system, inferenceConfig = DEFAULT_INFERENCE_CONFIG }) {
  const command = new ConverseStreamCommand({
    modelId,
    messages,
    inferenceConfig,
    ...(system && { system: [{ text: system }] })
  });
  const response = await client.send(command);

  for await (const event of response.stream ?? []) {
    const streamException = getStreamException(event);
    if (streamException) {
      throw streamException;
    }

    const text = event.contentBlockDelta?.delta?.text;
    if (text) {
      yield { type: "text", text };
    }

    const usage = event.metadata?.usage;
    if (usage) {
      yield { type: "usage", usage, metrics: event.metadata?.metrics };
    }
  }
}
