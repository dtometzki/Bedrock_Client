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

function setErrorField(error, name, value) {
  if (value != null) {
    error[name] = value;
  }
}

function getStreamException(event) {
  const entry = Object.entries(event)
    .find(([key, value]) => key.endsWith("Exception") && value);

  if (!entry) return null;

  const [streamEvent, details] = entry;
  const name = details.name || streamEvent;
  const message = details.message || details.Message || details.originalMessage || JSON.stringify(details);
  const error = new Error(message);
  error.name = name;
  error.streamEvent = streamEvent;
  error.details = details;
  setErrorField(error, "$fault", details.$fault);
  setErrorField(error, "$metadata", details.$metadata);
  setErrorField(error, "$retryable", details.$retryable);
  setErrorField(error, "originalStatusCode", details.originalStatusCode);
  setErrorField(error, "originalMessage", details.originalMessage);
  setErrorField(error, "resourceName", details.resourceName);
  return error;
}

export function formatBedrockErrorMessage(err) {
  const name = err?.name && err.name !== "Error" ? err.name : null;
  const message = err?.message || String(err);
  return name && !message.startsWith(`${name}:`) ? `${name}: ${message}` : message;
}

export function formatBedrockErrorDiagnostics(err, context = {}) {
  const metadata = err?.$metadata || err?.details?.$metadata || {};
  const originalStatusCode = err?.originalStatusCode || err?.details?.originalStatusCode;
  const originalMessage = err?.originalMessage || err?.details?.originalMessage;
  const lines = [];

  if (context.model) {
    lines.push(`Modell: ${context.model.label || context.model.id} (${context.model.id})`);
  }
  if (context.modelId && context.modelId !== context.model?.id) {
    lines.push(`Bedrock modelId: ${context.modelId}`);
  }
  if (context.region) {
    lines.push(`Region: ${context.region}`);
  }
  if (context.inferenceConfig) {
    lines.push(`Inference Config: ${JSON.stringify(context.inferenceConfig)}`);
  }
  if (err?.streamEvent) {
    lines.push(`Stream Event: ${err.streamEvent}`);
  }
  if (err?.name && err.name !== "Error") {
    lines.push(`Fehlertyp: ${err.name}`);
  }
  if (err?.$fault || err?.details?.$fault) {
    lines.push(`Fault: ${err.$fault || err.details.$fault}`);
  }
  if (metadata.httpStatusCode) {
    lines.push(`HTTP Status: ${metadata.httpStatusCode}`);
  }
  if (originalStatusCode) {
    lines.push(`Original Status: ${originalStatusCode}`);
  }
  if (metadata.requestId) {
    lines.push(`Request ID: ${metadata.requestId}`);
  }
  if (metadata.extendedRequestId) {
    lines.push(`Extended Request ID: ${metadata.extendedRequestId}`);
  }
  if (metadata.cfId) {
    lines.push(`CloudFront ID: ${metadata.cfId}`);
  }
  if (err?.resourceName) {
    lines.push(`Resource: ${err.resourceName}`);
  }
  if (err?.$retryable || err?.details?.$retryable) {
    lines.push("Retryable: ja");
  }
  if (originalMessage && originalMessage !== err?.message) {
    lines.push(`Originalmeldung: ${originalMessage}`);
  }

  return lines;
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
