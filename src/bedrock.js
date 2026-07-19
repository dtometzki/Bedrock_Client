import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";

// Einzige Quelle fuer die Inference-Defaults; cli-args.js re-exportiert sie
// fuer die Argument-Verarbeitung, damit die Werte nicht auseinanderdriften.
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TEMPERATURE = 0.7;

export const DEFAULT_INFERENCE_CONFIG = {
  maxTokens: DEFAULT_MAX_TOKENS,
  temperature: DEFAULT_TEMPERATURE
};

export function createBedrockClient({ region } = {}) {
  // Keine statischen Credentials: Das SDK löst sie über die Default Provider
  // Chain auf (Env, SSO, Profildateien, Assume-Role) und erneuert sie bei Bedarf.
  return new BedrockRuntimeClient({
    region: region || "us-east-1"
  });
}

export function buildInferenceConfig(model, overrides = {}) {
  const config = {
    ...DEFAULT_INFERENCE_CONFIG,
    ...(model?.inferenceConfig || {}),
    ...(model?.maxTokens != null && { maxTokens: model.maxTokens }),
    ...(model?.temperature != null && { temperature: model.temperature }),
    ...(model?.topP != null && { topP: model.topP }),
    ...(overrides.maxTokens != null && { maxTokens: overrides.maxTokens }),
    ...(overrides.temperature != null && { temperature: overrides.temperature }),
    ...(overrides.topP != null && { topP: overrides.topP }),
    ...(Array.isArray(overrides.stopSequences) && overrides.stopSequences.length
      ? { stopSequences: overrides.stopSequences }
      : {})
  };

  for (const field of model?.disabledInferenceConfigFields || []) {
    delete config[field];
  }

  return config;
}

// Baut die additionalModelRequestFields fuer adaptives Thinking (Effort Level).
// Anthropic-Reasoning-Modelle steuern den Denk-Aufwand ueber
// thinking.type = "adaptive" mit einem effort-Wert (low|medium|high|max).
// Es gibt zwei Request-Formate, je nach Modellgeneration:
//   - "thinking":       effort steckt in thinking.effort (Opus 4.6, Sonnet 4.6)
//   - "output_config":  effort steckt in einem separaten output_config.effort
//                       (Opus 4.8, Sonnet 5, Fable 5). thinking.effort waere
//                       hier ungueltig ("Extra inputs are not permitted").
export function buildAdaptiveThinkingFields(effort, style = "thinking") {
  if (!effort) return undefined;
  if (style === "output_config") {
    return { thinking: { type: "adaptive" }, output_config: { effort } };
  }
  return { thinking: { type: "adaptive", effort } };
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

export function isAbortError(err) {
  return err?.name === "AbortError" || err?.name === "TimeoutError" || err?.aborted === true;
}

const RETRYABLE_ERROR_NAMES = new Set([
  "ThrottlingException",
  "TooManyRequestsException",
  "ServiceUnavailableException",
  "InternalServerException",
  "ModelTimeoutException",
  "RequestTimeout",
  "RequestTimeoutException"
]);

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableError(err) {
  if (!err || isAbortError(err)) return false;
  if (err.$retryable || err.details?.$retryable) return true;
  if (err.name && RETRYABLE_ERROR_NAMES.has(err.name)) return true;

  const statusCode = err.$metadata?.httpStatusCode ||
    err.details?.$metadata?.httpStatusCode ||
    err.originalStatusCode ||
    err.details?.originalStatusCode;
  return statusCode != null && RETRYABLE_STATUS_CODES.has(Number(statusCode));
}

export function getRetryDelayMs(attempt, baseDelayMs = 500, maxDelayMs = 8000) {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(maxDelayMs, exponential + jitter);
}

function createAbortError() {
  const error = new Error("Anfrage abgebrochen.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function defaultSleep(ms, abortSignal) {
  throwIfAborted(abortSignal);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timeout);
      reject(createAbortError());
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function* streamConverse(client, { modelId, messages, system, inferenceConfig = DEFAULT_INFERENCE_CONFIG, additionalModelRequestFields, abortSignal }) {
  const command = new ConverseStreamCommand({
    modelId,
    messages,
    inferenceConfig,
    ...(system && { system: [{ text: system }] }),
    ...(additionalModelRequestFields && Object.keys(additionalModelRequestFields).length
      ? { additionalModelRequestFields }
      : {})
  });
  const response = await client.send(command, abortSignal ? { abortSignal } : {});

  for await (const event of response.stream ?? []) {
    if (abortSignal?.aborted) {
      const abortError = new Error("Anfrage abgebrochen.");
      abortError.name = "AbortError";
      throw abortError;
    }

    const streamException = getStreamException(event);
    if (streamException) {
      throw streamException;
    }

    const reasoningText = event.contentBlockDelta?.delta?.reasoningContent?.text;
    if (reasoningText) {
      yield { type: "reasoning", text: reasoningText };
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

export async function* streamConverseWithRetry(client, params, {
  maxRetries = 3,
  baseDelayMs = 500,
  sleep = defaultSleep
} = {}) {
  let attempt = 0;

  while (true) {
    let yieldedAny = false;
    try {
      for await (const event of streamConverse(client, params)) {
        yieldedAny = true;
        yield event;
      }
      return;
    } catch (err) {
      if (yieldedAny || attempt >= maxRetries || !isRetryableError(err)) {
        throw err;
      }
      attempt += 1;
      const delayMs = getRetryDelayMs(attempt, baseDelayMs);
      yield { type: "retry", attempt, maxRetries, delayMs, error: err };
      await sleep(delayMs, params.abortSignal);
      // Auch injizierte Sleep-Funktionen in Tests oder Integrationen muessen
      // einen zwischenzeitlichen Abbruch respektieren.
      throwIfAborted(params.abortSignal);
    }
  }
}
