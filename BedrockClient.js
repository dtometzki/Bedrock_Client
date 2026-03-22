import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";

export class SimpleBedrockClient {
  constructor(region = "us-east-1", modelId = "global.anthropic.claude-sonnet-4-6") {
    this.client = new BedrockRuntimeClient({ region });
    this.modelId = modelId;
    this.messages =[]; 
  }

  // NEU: Modell dynamisch anpassen
  setModelId(newModelId) {
    this.modelId = newModelId;
  }

  clearHistory() {
    this.messages =[];
  }

  async *askStream(prompt, systemPrompt = null) {
    this.messages.push({ role: "user", content:[{ text: prompt }] });

    const commandConfig = {
      modelId: this.modelId, // Nutzt das aktuell gesetzte Modell
      messages: this.messages,
      inferenceConfig: { maxTokens: 2000, temperature: 0.7 }
    };

    if (systemPrompt) commandConfig.system =[{ text: systemPrompt }];

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

      this.messages.push({ role: "assistant", content:[{ text: fullResponse }] });
    } catch (error) {
      console.error("\nBedrock API Fehler:", error.message);
      this.messages.pop(); 
      throw error;
    }
  }
}
