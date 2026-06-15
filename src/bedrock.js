import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";

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

export async function* streamConverse(client, { modelId, messages, system }) {
  const command = new ConverseStreamCommand({
    modelId,
    messages,
    inferenceConfig: { maxTokens: 2000, temperature: 0.7 },
    ...(system && { system: [{ text: system }] })
  });
  const response = await client.send(command);

  for await (const event of response.stream ?? []) {
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
