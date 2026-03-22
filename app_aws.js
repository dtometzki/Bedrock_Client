#!/usr/bin/env node

import path from "node:path";
import { SimpleBedrockClient } from "./BedrockClient.js";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { printAwsCliStatus, verifyAwsCliConnection } from "./lib/awsCliCheck.js";
import { printLogo } from "./lib/branding.js";
import { parseCliArgs, printHelp } from "./lib/cli.js";
import { formatMarkdownForTerminal } from "./lib/markdownTerminal.js";
import { findModel, formatModelLabel, loadModels } from "./lib/models.js";
import { promptForModelSelection } from "./lib/modelSelection.js";
import { askStyledQuestion } from "./lib/prompts.js";
import { loadLastModelId, saveLastModelId, loadChatHistory, saveChatHistory } from "./lib/state.js";
import { handleCommand } from "./lib/commands.js";

async function main() {
  const scriptName = process.argv[1] ? path.basename(process.argv[1]) : "";
  if (scriptName !== "bedrock-chat") {
    console.error("Fehler: Diese Anwendung kann nur über den Befehl 'bedrock-chat' gestartet werden.");
    process.exit(1);
  }

  let rl;

  try {
    const models = await loadModels(new URL("./models.json", import.meta.url));
    const cliArgs = parseCliArgs();
    const startupModelArg = cliArgs.model;
    const lastModelId = await loadLastModelId();
    const startupModel = startupModelArg ? findModel(models, startupModelArg) : null;
    const savedModel =
      !startupModelArg && lastModelId
        ? (models.find((model) => model.id === lastModelId) ?? null)
        : null;

    if (cliArgs.help) {
      printHelp(models);
      return;
    }

    if (startupModelArg && !startupModel) {
      throw new Error(`Unbekanntes Modell für -m/--model: ${startupModelArg}`);
    }

    const ai = new SimpleBedrockClient(
      process.env.AWS_REGION || "us-east-1",
      startupModel?.id ?? savedModel?.id ?? models[0].id
    );

    // Load Chat History
    const history = await loadChatHistory();
    if (history && history.length > 0) {
      ai.messages = history;
    }

    const awsIdentity = await verifyAwsCliConnection();
    rl = readline.createInterface({ input, output });
    printLogo();
    printAwsCliStatus(awsIdentity);

    // 1. Modell-Auswahl beim Start
    if (!startupModel && !savedModel) {
      const selectedModel = await promptForModelSelection(rl, models, ai.modelId);
      if (selectedModel) {
        ai.setModelId(selectedModel.id);
        await saveLastModelId(selectedModel.id);
      }
    }

    await ai.verifyAccess();
    await saveLastModelId(ai.modelId);

    const activeModel = models.find((model) => model.id === ai.modelId);
    console.log(`\nAktives Modell: ${activeModel?.label ?? formatModelLabel(ai.modelId)}`);
    if (ai.messages.length > 0) {
      console.log(`[System: Chat-Historie mit ${ai.messages.length} Nachrichten geladen.]`);
    }
    if (cliArgs.system) {
      console.log(`[System: System Prompt aktiviert: "${cliArgs.system.substring(0, 30)}..."]`);
    }
    console.log("Chat gestartet. Befehle: '/exit', '/clear', '/model', '/export'.\n");
    console.log("-".repeat(40));

    // 2. Chat-Schleife
    while (true) {
      const frage = await askStyledQuestion(rl, ">");
      let inputTrimmed = frage.trim().toLowerCase();

      if (!inputTrimmed) continue;

      if (inputTrimmed.startsWith("/") || inputTrimmed === "/") {
        const exitChat = await handleCommand(inputTrimmed, { rl, ai, models });
        if (exitChat) break;
        continue;
      }

      process.stdout.write("\n");

      try {
        let fullResponse = "";
        for await (const chunk of ai.askStream(frage, cliArgs.system)) {
          fullResponse += chunk;
        }
        console.log(formatMarkdownForTerminal(fullResponse));

        // Save chat history after successful generation
        await saveChatHistory(ai.messages);
      } catch (e) {
        // Fehler-Handling ist im BedrockClient oder wird ignoriert (nach Logging)
      }

      console.log("\n\n" + "-".repeat(40) + "\n");
    }
  } catch (err) {
    if (err?.code === "ABORT_ERR") {
      console.log("\nChat beendet.");
      return;
    }
    console.error(err?.message ?? "Ein unerwarteter Fehler ist aufgetreten.");
  } finally {
    rl?.close();
  }
}

main();
