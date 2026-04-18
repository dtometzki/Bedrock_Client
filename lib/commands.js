import { writeFile } from "node:fs/promises";
import { promptForCommandSelection } from "./commandSelection.js";
import { promptForModelSelection } from "./modelSelection.js";
import { findModel } from "./models.js";
import { saveLastModelId, saveChatHistory } from "./state.js";

function printCommandHelp() {
  console.log("\nVerfügbare Chat-Befehle:");
  console.log("  /help                 Zeigt diese Hilfe an");
  console.log("  /models               Listet verfügbare Modelle auf");
  console.log("  /stats                Zeigt Chat-Statistiken an");
  console.log("  /model                Modell interaktiv wählen");
  console.log("  /model <nummer|id>    Modell direkt per Nummer oder Model-ID setzen");
  console.log("  /export               Chat als Markdown-Datei exportieren");
  console.log("  /clear                Chat-Verlauf löschen");
  console.log("  /exit                 Chat beenden\n");
}

function printModelOverview(models, activeModelId) {
  console.log("\nVerfügbare Modelle:");
  models.forEach((model, index) => {
    const isActive = model.id === activeModelId;
    const marker = isActive ? "*" : " ";
    console.log(` ${marker} [${index + 1}] ${model.label} (${model.id})`);
  });
  console.log("\n* = aktives Modell\n");
}

function printChatStats(messages, activeModelId, tokenUsageTotals) {
  const userMessages = messages.filter((msg) => msg.role === "user").length;
  const assistantMessages = messages.filter((msg) => msg.role === "assistant").length;
  const inputTokens = tokenUsageTotals?.inputTokens;
  const outputTokens = tokenUsageTotals?.outputTokens;
  const totalTokens = tokenUsageTotals?.totalTokens;
  const hasTokenUsage =
    Number.isFinite(inputTokens) && Number.isFinite(outputTokens) && Number.isFinite(totalTokens);
  const averageTokens = hasTokenUsage && messages.length > 0 ? Math.round(totalTokens / messages.length) : 0;

  console.log("\nChat-Statistik:");
  console.log(`  Aktives Modell: ${activeModelId}`);
  console.log(`  Nachrichten gesamt: ${messages.length}`);
  console.log(`  User-Nachrichten: ${userMessages}`);
  console.log(`  Assistant-Nachrichten: ${assistantMessages}`);
  if (hasTokenUsage) {
    console.log(`  Input-Tokens: ${inputTokens}`);
    console.log(`  Output-Tokens: ${outputTokens}`);
    console.log(`  Tokens gesamt: ${totalTokens}`);
    console.log(`  Ø Tokens je Nachricht: ${averageTokens}\n`);
  } else {
    console.log("  Token-Usage: Noch keine Nutzungsdaten verfügbar.\n");
  }
}

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

  if (command === "/help") {
    printCommandHelp();
    return false;
  }

  if (command === "/models") {
    printModelOverview(models, ai.modelId);
    return false;
  }

  if (command === "/stats") {
    printChatStats(ai.messages, ai.modelId, ai.tokenUsageTotals);
    return false;
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
      const exportedAt = new Date();
      const timestampForFile = exportedAt.toISOString().replace(/[:.]/g, "-");
      const filename = `chat-export-${timestampForFile}.md`;
      let content = "# Chat Export\n\n";
      content += `- Exportiert am (UTC): ${exportedAt.toISOString()}\n`;
      content += `- Exportiert am (Lokal): ${exportedAt.toLocaleString()}\n`;
      content += `- Aktives Modell: ${ai.modelId}\n`;
      content += `- Nachrichten gesamt: ${ai.messages.length}\n\n`;

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
    const [, modelArg = ""] = command.split(/\s+/, 2);
    const trimmedModelArg = modelArg.trim();

    if (!trimmedModelArg) {
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
      return false;
    }

    const requestedNumber = Number.parseInt(trimmedModelArg, 10);
    const selectedByNumber =
      Number.isInteger(requestedNumber) && requestedNumber >= 1 && requestedNumber <= models.length
        ? models[requestedNumber - 1]
        : null;
    const selectedById = selectedByNumber ? null : findModel(models, trimmedModelArg);
    const selectedModel = selectedByNumber ?? selectedById;

    if (selectedModel) {
      await switchModel(selectedModel, ai);
    } else {
      console.log(
        "\n[System: Ungültige Modellauswahl. Verwende eine Modellnummer oder eine exakte Model-ID.]\n"
      );
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
