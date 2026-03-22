import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";

/**
 * A simple wrapper around the AWS Bedrock Runtime Client.
 */
export class SimpleBedrockClient {
  /**
   * Initializes a new instance of SimpleBedrockClient.
   * @param {string} region The AWS region to use.
   * @param {string} modelId The default model ID.
   */
  constructor(region = "us-east-1", modelId = "global.anthropic.claude-sonnet-4-6") {
    this.client = new BedrockRuntimeClient({ region });
    this.modelId = modelId;
    this.messages = [];
  }

  /**
   * Sets a new model ID.
   * @param {string} newModelId The model ID.
   */
  setModelId(newModelId) {
    this.modelId = newModelId;
  }

  /**
   * Clears the current chat history.
   */
  clearHistory() {
    this.messages = [];
  }

  /**
   * Verifies if the current AWS credentials have access to the selected model.
   * @param {string} modelId The model to verify. Defaults to current model.
   * @throws {Error} If access is denied or another error occurs.
   */
  async verifyAccess(modelId = this.modelId) {
    const command = new ConverseStreamCommand({
      modelId,
      messages: [{ role: "user", content: [{ text: "ping" }] }],
      inferenceConfig: { maxTokens: 1, temperature: 0 }
    });

    try {
      const response = await this.client.send(command);

      for await (const _event of response.stream) {
        break;
      }
    } catch (error) {
      if (
        error?.name === "UnrecognizedClientException" ||
        error?.name === "InvalidSignatureException" ||
        error?.name === "CredentialsProviderError"
      ) {
        throw new Error(
          "AWS-Zugangsdaten sind ungültig oder fehlen. Bitte stellen Sie sicher, dass Sie mit `aws configure` oder per Umgebungsvariablen gültige Credentials hinterlegt haben.",
          { cause: error }
        );
      }

      const isAccessDenied =
        error?.name === "AccessDeniedException" || error?.$metadata?.httpStatusCode === 403;

      if (isAccessDenied) {
        throw new Error(
          `Das Modell ${modelId} kann mit den aktuellen Bedrock-Berechtigungen nicht verwendet werden. ` +
            "Erforderlich ist mindestens `bedrock:InvokeModelWithResponseStream` bzw. `bedrock:ConverseStream`.",
          { cause: error }
        );
      }

      throw error;
    }
  }

  /**
   * Asks the model a question and yields the streaming response chunks.
   * @param {string} prompt The user prompt.
   * @param {string|null} systemPrompt An optional system prompt.
   * @yields {string} The text chunks from the stream.
   */
  async *askStream(prompt, systemPrompt = null) {
    this.messages.push({ role: "user", content: [{ text: prompt }] });

    const commandConfig = {
      modelId: this.modelId, // Nutzt das aktuell gesetzt Modell
      messages: this.messages,
      inferenceConfig: { maxTokens: 2000, temperature: 0.7 }
    };

    if (systemPrompt) commandConfig.system = [{ text: systemPrompt }];

    let retries = 3;
    let delay = 1000;

    while (retries > 0) {
      try {
        const command = new ConverseStreamCommand(commandConfig);
        const response = await this.client.send(command);

        let fullResponse = "";
        for await (const event of response.stream) {
          if (event.contentBlockDelta?.delta?.text) {
            const chunk = event.contentBlockDelta.delta.text;
            fullResponse += chunk;
            yield chunk;
          }
        }

        this.messages.push({ role: "assistant", content: [{ text: fullResponse }] });
        return; // Success, exit loop
      } catch (error) {
        const isThrottling =
          error?.name === "ThrottlingException" || error?.$metadata?.httpStatusCode === 429;
        const isServiceUnavailable = error?.$metadata?.httpStatusCode === 503;

        if ((isThrottling || isServiceUnavailable) && retries > 1) {
          retries--;
          console.error(
            `\n[System: API überlastet (${error.name}). Wiederhole in ${delay}ms... (Verbleibend: ${retries})]`
          );
          await new Promise((res) => setTimeout(res, delay));
          delay *= 2; // Exponential backoff
        } else {
          console.error("\nBedrock API Fehler:", error.message);
          this.messages.pop(); // Remove user message on failure
          throw error;
        }
      }
    }
  }
}
