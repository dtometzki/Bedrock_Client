import { writeFile } from "node:fs/promises";
import { promptForCommandSelection } from "./commandSelection.js";
import { promptForModelSelection } from "./modelSelection.js";
import { saveLastModelId, saveChatHistory } from "./state.js";

/**
 * Handles the execution of a chat command.
 * @param {string} inputTrimmed The normalized input command string.
 * @param {object} context The application context.
 * @returns {Promise<boolean>} True if the chat should exit, false otherwise.
 */
export async function handleCommand(inputTrimmed, context) {
  const { rl, ai, models } = context;
  let command = inputTrimmed;

  if (command === "/") {
    const selectedCommand = await promptForCommandSelection(rl);
    if (!selectedCommand) {
      console.log("\n[System: Befehlsauswahl abgebrochen.]\n");
      return false;
    }
    command = selectedCommand.command;
    console.log(`\n[System: Befehl gewählt: ${selectedCommand.command}]\n`);
  }

  if (command === "/exit" || command === "/quit") {
    console.log("Chat beendet.");
    return true;
  }

  if (command === "/clear" || command === "/reset") {
    ai.clearHistory();
    await saveChatHistory(ai.messages);
    console.log("\n[System: Chat-Verlauf wurde gelöscht.]\n");
    return false;
  }

  if (command === "/export") {
    if (ai.messages.length === 0) {
      console.log("\n[System: Keine Nachrichten zum Exportieren vorhanden.]\n");
      return false;
    }

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `chat-export-${timestamp}.md`;
      let content = `# Chat Export - ${timestamp}\n\n`;

      for (const msg of ai.messages) {
        const role = msg.role === "user" ? "User" : "Assistant";
        const text = msg.content[0]?.text || "";
        content += `## ${role}\n${text}\n\n`;
      }

      await writeFile(filename, content, "utf8");
      console.log(`\n[System: Chat exportiert nach ${filename}]\n`);
    } catch (error) {
      console.log(`\n[System: Fehler beim Exportieren: ${error.message}]\n`);
    }
    return false;
  }

  if (command.startsWith("/model")) {
    let newChoiceIndex = -1;

    if (command.startsWith("/model ")) {
      newChoiceIndex = parseInt(command.split(" ")[1], 10) - 1;
    }

    if (newChoiceIndex >= 0 && newChoiceIndex < models.length) {
      await switchModel(models[newChoiceIndex], ai);
    } else if (command === "/model") {
      const selectedModel = await promptForModelSelection(
        rl,
        models,
        ai.modelId,
        "Wähle ein Modell"
      );
      if (selectedModel) {
        await switchModel(selectedModel, ai);
      } else {
        console.log("\n[System: Modellwechsel abgebrochen.]\n");
      }
    } else {
      console.log("\n[System: Ungültige Modellnummer.]\n");
    }
    return false;
  }

  console.log(`\n[System: Unbekannter Befehl: ${command}]\n`);
  return false;
}

/**
 * Helper to switch the active model and verify access.
 * @param {object} selectedModel The model object to switch to.
 * @param {object} ai The Bedrock client instance.
 * @returns {Promise<void>}
 */
async function switchModel(selectedModel, ai) {
  try {
    await ai.verifyAccess(selectedModel.id);
    ai.setModelId(selectedModel.id);
    await saveLastModelId(selectedModel.id);
    console.log(`\n[System: Modell gewechselt zu ${selectedModel.label}]\n`);
  } catch (error) {
    console.log(`\n[System: Modellwechsel fehlgeschlagen: ${error.message}]\n`);
  }
}
