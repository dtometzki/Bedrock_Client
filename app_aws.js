#!/usr/bin/env node

import { SimpleBedrockClient } from "./BedrockClient.js";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { printAwsCliStatus, verifyAwsCliConnection } from "./lib/awsCliCheck.js";
import { printLogo } from "./lib/branding.js";
import { parseCliArgs, printHelp } from "./lib/cli.js";
import { promptForCommandSelection } from "./lib/commandSelection.js";
import { formatMarkdownForTerminal } from "./lib/markdownTerminal.js";
import { findModel, formatModelLabel, loadModels } from "./lib/models.js";
import { promptForModelSelection } from "./lib/modelSelection.js";
import { askStyledQuestion } from "./lib/prompts.js";
import { loadLastModelId, saveLastModelId } from "./lib/state.js";

async function main() {
  let rl;

  try {
    const models = await loadModels(new URL("./models.json", import.meta.url));
    const cliArgs = parseCliArgs();
    const startupModelArg = cliArgs.model;
    const lastModelId = await loadLastModelId();
    const startupModel = startupModelArg ? findModel(models, startupModelArg) : null;
    const savedModel = !startupModelArg && lastModelId
      ? models.find((model) => model.id === lastModelId) ?? null
      : null;

    if (cliArgs.help) {
      printHelp(models);
      return;
    }

    if (startupModelArg && !startupModel) {
      throw new Error(`Unbekanntes Modell für -m/--model: ${startupModelArg}`);
    }

    const ai = new SimpleBedrockClient(
      "us-east-1",
      startupModel?.id ?? savedModel?.id ?? models[0].id
    );
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
    console.log("Chat gestartet. Befehle: '/exit', '/clear', '/model'.\n");
    console.log("-".repeat(40));

    // 2. Chat-Schleife
    while (true) {
      const frage = await askStyledQuestion(rl, ">");
      let inputTrimmed = frage.trim().toLowerCase();
      
      if (!inputTrimmed) continue;

      if (inputTrimmed === "/") {
        const selectedCommand = await promptForCommandSelection(rl);
        if (!selectedCommand) {
          console.log("\n[System: Befehlsauswahl abgebrochen.]\n");
          continue;
        }
        inputTrimmed = selectedCommand.command;
        console.log(`\n[System: Befehl gewählt: ${selectedCommand.command}]\n`);
      }

      if (inputTrimmed === "/exit" || inputTrimmed === "/quit") {
        console.log("Chat beendet.");
        break; 
      }

      if (inputTrimmed === "/clear" || inputTrimmed === "/reset") {
        ai.clearHistory();
        console.log("\n[System: Chat-Verlauf wurde gelöscht.]\n");
        continue;
      }

      if (inputTrimmed === "/model") {
        const selectedModel = await promptForModelSelection(
          rl,
          models,
          ai.modelId,
          "Wähle ein Modell"
        );
        if (selectedModel) {
          try {
            await ai.verifyAccess(selectedModel.id);
            ai.setModelId(selectedModel.id);
            await saveLastModelId(selectedModel.id);
            console.log(`\n[System: Modell gewechselt zu ${selectedModel.label}]\n`);
          } catch (error) {
            console.log(`\n[System: Modellwechsel fehlgeschlagen: ${error.message}]\n`);
          }
        } else {
          console.log("\n[System: Modellwechsel abgebrochen.]\n");
        }
        continue;
      }

      if (inputTrimmed.startsWith("/model ")) {
        const newChoice = parseInt(inputTrimmed.split(" ")[1], 10) - 1;
        if (newChoice >= 0 && newChoice < models.length) {
          try {
            await ai.verifyAccess(models[newChoice].id);
            ai.setModelId(models[newChoice].id);
            await saveLastModelId(models[newChoice].id);
            console.log(`\n[System: Modell gewechselt zu ${models[newChoice].label}]\n`);
          } catch (error) {
            console.log(`\n[System: Modellwechsel fehlgeschlagen: ${error.message}]\n`);
          }
        } else {
          console.log("\n[System: Ungültige Modellnummer.]\n");
        }
        continue;
      }

      process.stdout.write("\n");

      try {
        let fullResponse = "";
        for await (const chunk of ai.askStream(frage)) {
          fullResponse += chunk;
        }
        console.log(formatMarkdownForTerminal(fullResponse));
      } catch (e) {
        // Fehler-Handling ist in der Klasse
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
