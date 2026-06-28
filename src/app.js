import {
  ANSI,
  formatAccountSummary,
  formatInteger,
  formatUsd,
  getPackageVersion,
  printStartupBanner,
  terminalLine
} from "./ui.js";
import { SLASH_COMMANDS, printSlashCommands } from "./slash-commands.js";
import { parseCliArgs } from "./cli-args.js";
import {
  readLastModelId,
  readSavedInferenceOverrides,
  writeLastModelId,
  writeSavedInferenceOverrides
} from "./config.js";
import { countHistoryTurns, formatHistoryLimit, trimMessagesToMaxTurns } from "./history.js";
import { getModelInvocationId, loadModels, resolveStartupModel } from "./models.js";
import {
  formatProfileList,
  listAwsProfiles,
  loadAwsContext,
  printAwsProfiles,
  switchAwsProfile
} from "./aws-context.js";
import {
  buildInferenceConfig,
  createBedrockClient,
  formatBedrockErrorDiagnostics,
  formatBedrockErrorMessage,
  streamConverse
} from "./bedrock.js";
import { promptForModelSelection, readPrompt } from "./prompt.js";
import { formatLine, resetResponseFormatting } from "./response-format.js";
import { addUsageRecord, emptyUsageTotals, printUsageSummary } from "./usage.js";

function printHistorySummary(messages, maxTurns) {
  console.log(`${ANSI.green}Verlauf:${ANSI.reset} ${countHistoryTurns(messages)} Turns, ${messages.length} Nachrichten`);
  console.log(`${ANSI.green}Limit:${ANSI.reset} ${formatHistoryLimit(maxTurns)}`);
  console.log(terminalLine());
}

function isDebugEnvEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function parseDebugCommand(input, currentDebugMode) {
  const value = input.slice("/debug".length).trim().toLowerCase();
  if (!value) return !currentDebugMode;
  if (["1", "an", "ein", "on", "true", "yes"].includes(value)) return true;
  if (["0", "aus", "off", "false", "no"].includes(value)) return false;
  if (["status", "state"].includes(value)) return currentDebugMode;
  return null;
}

function printDebugStatus(debugMode) {
  console.log(`${ANSI.green}Debug:${ANSI.reset} ${debugMode ? "ein" : "aus"}`);
  console.log(terminalLine());
}

function formatDebugRequestLines({
  model,
  modelId,
  region,
  profile,
  inferenceConfig,
  historyMessages,
  requestMessages,
  system,
  maxTurns
}) {
  return [
    `Modell: ${model.label || model.id} (${model.id})`,
    ...(modelId !== model.id ? [`Bedrock modelId: ${modelId}`] : []),
    `AWS Profil: ${profile}`,
    `Region: ${region}`,
    `Inference Config: ${JSON.stringify(inferenceConfig)}`,
    `System Prompt: ${system ? `gesetzt (${system.length} Zeichen)` : "nicht gesetzt"}`,
    `Nachrichten: ${requestMessages.length} gesendet, ${historyMessages.length} im Verlauf`,
    `Verlauf-Limit: ${formatHistoryLimit(maxTurns)}`
  ];
}

function printDebugLines(title, lines) {
  console.error(`${ANSI.magenta}${title}${ANSI.reset}`);
  lines.forEach((line) => {
    console.error(`${ANSI.magenta}  ${line}${ANSI.reset}`);
  });
}

export async function main() {
  try {
    const cliArgs = parseCliArgs();

    if (cliArgs.version) {
      console.log(`bedrock-chat ${getPackageVersion()}`);
      return;
    }

    const modelsPath = new URL("../models.json", import.meta.url);
    const models = loadModels(modelsPath);

    if (cliArgs.help) {
      console.log(`${ANSI.bold}Verwendung:${ANSI.reset} bedrock-chat [Optionen]\n`);
      console.log("Optionen:");
      console.log("  -m, --model <name>  Modell beim Start setzen");
      console.log("  -p, --profile <name> AWS Profil beim Start setzen");
      console.log("  -p -list           AWS Profile anzeigen und beenden");
      console.log("  -s, --system <text> System Prompt setzen");
      console.log("  --max-tokens <n>    Max. Antwort-Tokens setzen");
      console.log("  --temperature <n>   Temperatur setzen (0 bis 1)");
      console.log("  --max-turns <n>     Verlauf auf n Chat-Turns begrenzen, 0 = unbegrenzt");
      console.log("  --debug             Debug-Ausgabe fuer Bedrock Requests aktivieren");
      console.log("  -v, --version      Version anzeigen");
      console.log("  -h, --help          Hilfe anzeigen\n");
      console.log("Commands:");
      const commandNameWidth = Math.max(...SLASH_COMMANDS.map((command) => command.name.length));
      SLASH_COMMANDS.forEach((command) => {
        console.log(`  ${command.name.padEnd(commandNameWidth)}  ${command.description}`);
      });
      console.log("");
      console.log("Modelle:");
      models.forEach((m) => console.log(`  - ${m.label} (${m.id})`));
      return;
    }

    if (cliArgs.profile === "-list" || cliArgs.profile === "--list" || cliArgs.profile === "list") {
      printAwsProfiles();
      return;
    }

    const legacyLastModelPath = new URL("../.last_model", import.meta.url);
    const lastModelId = readLastModelId(legacyLastModelPath);
    const activeModel = resolveStartupModel(models, {
      requestedModel: cliArgs.model,
      lastModelId
    });
    let modelId = activeModel.id;

    if (!cliArgs.model && !lastModelId && models.length > 1) {
      const selected = await promptForModelSelection(models, modelId);
      if (selected) {
        modelId = selected.id;
        try {
          writeLastModelId(modelId);
        } catch {}
      }
    }

    let currentModel = models.find((m) => m.id === modelId) ?? activeModel;
    const savedInferenceOverrides = readSavedInferenceOverrides();
    const activeInferenceOverrides = {
      ...savedInferenceOverrides,
      ...cliArgs.inferenceOverrides
    };
    if (Object.keys(cliArgs.inferenceOverrides).length) {
      try {
        writeSavedInferenceOverrides(activeInferenceOverrides);
      } catch {}
    }
    let inferenceConfig = buildInferenceConfig(currentModel, activeInferenceOverrides);
    const startupContext = cliArgs.profile ? switchAwsProfile(cliArgs.profile) : loadAwsContext();
    let { creds, identityLabel } = startupContext;
    let bedrockClient = createBedrockClient(creds);
    let debugMode = cliArgs.debug || isDebugEnvEnabled(process.env.BEDROCK_CHAT_DEBUG);
    printStartupBanner({ model: currentModel, inferenceConfig });
    if (debugMode) {
      printDebugStatus(debugMode);
    }

    let messages = [];
    const usageTotals = emptyUsageTotals();

    while (true) {
      const prompt = await readPrompt();
      if (prompt === null) break;
      const input = prompt.trim();

      if (!input) continue;
      if (input === "/exit") break;
      if (input === "/" || input === "/help") {
        printSlashCommands(input);
        continue;
      }
      if (input === "/clear") {
        messages = [];
        console.log(`${ANSI.gray}Verlauf geleert.${ANSI.reset}`);
        console.log(terminalLine());
        continue;
      }
      if (input === "/debug" || input.startsWith("/debug ")) {
        const nextDebugMode = parseDebugCommand(input, debugMode);
        if (nextDebugMode === null) {
          console.log(`${ANSI.yellow}Ungueltiger Debug-Wert:${ANSI.reset} ${input.slice("/debug".length).trim()}`);
          console.log(`${ANSI.gray}Nutze /debug, /debug on oder /debug off.${ANSI.reset}`);
          console.log(terminalLine());
          continue;
        }
        debugMode = nextDebugMode;
        printDebugStatus(debugMode);
        continue;
      }
      if (input === "/usage") {
        printUsageSummary(usageTotals);
        continue;
      }
      if (input === "/history") {
        printHistorySummary(messages, cliArgs.maxTurns);
        continue;
      }
      if (input === "/account") {
        console.log(formatAccountSummary({
          profile: process.env.AWS_PROFILE || "default",
          region: creds.region,
          identityLabel
        }).join("\n"));
        console.log(terminalLine());
        continue;
      }
      if (input === "/profile" || input.startsWith("/profile ")) {
        const requestedProfile = input.slice("/profile".length).trim();
        if (!requestedProfile) {
          console.log(`${ANSI.green}AWS Profile:${ANSI.reset} ${formatProfileList(listAwsProfiles())}`);
          console.log(`${ANSI.green}Aktiv:${ANSI.reset} ${identityLabel || process.env.AWS_PROFILE || "default"}`);
          console.log(terminalLine());
          continue;
        }

        try {
          const nextContext = switchAwsProfile(requestedProfile);
          creds = nextContext.creds;
          identityLabel = nextContext.identityLabel;
          bedrockClient = createBedrockClient(creds);
          messages = [];
          console.log(`${ANSI.green}AWS Profil:${ANSI.reset} ${nextContext.profile}`);
          if (identityLabel) {
            console.log(`${ANSI.green}Identitaet:${ANSI.reset} ${identityLabel}`);
          }
          console.log(`${ANSI.green}Region:${ANSI.reset} ${creds.region}`);
          console.log(`${ANSI.gray}Verlauf geleert.${ANSI.reset}`);
          console.log(terminalLine());
        } catch (err) {
          console.error(`${ANSI.yellow}${err.message}${ANSI.reset}`);
          console.log(terminalLine());
        }
        continue;
      }
      if (input === "/model") {
        const selected = await promptForModelSelection(models, modelId);
        if (selected) {
          modelId = selected.id;
          currentModel = selected;
          inferenceConfig = buildInferenceConfig(currentModel, activeInferenceOverrides);
          try {
            writeLastModelId(modelId);
          } catch {}
          console.log(`${ANSI.green}Modell:${ANSI.reset} ${currentModel.label || modelId}`);
          console.log(terminalLine());
        }
        continue;
      }
      if (input.startsWith("/")) {
        const commandName = input.split(/\s+/, 1)[0];
        console.log(`${ANSI.yellow}Unbekannter Befehl:${ANSI.reset} ${commandName}`);
        printSlashCommands(commandName);
        continue;
      }

      const userMessage = { role: "user", content: [{ text: input }] };
      const requestMessages = [...messages, userMessage];
      process.stdout.write("\n");

      const bedrockModelId = getModelInvocationId(currentModel);

      try {
        if (debugMode) {
          printDebugLines("Debug Request", formatDebugRequestLines({
            model: currentModel,
            modelId: bedrockModelId,
            region: creds.region,
            profile: process.env.AWS_PROFILE || "default",
            inferenceConfig,
            historyMessages: messages,
            requestMessages,
            system: cliArgs.system,
            maxTurns: cliArgs.maxTurns
          }));
        }

        resetResponseFormatting();
        let fullResponse = "";
        let lineBuffer = "";
        let usageRecord = null;

        for await (const event of streamConverse(bedrockClient, {
          modelId: bedrockModelId,
          messages: requestMessages,
          system: cliArgs.system,
          inferenceConfig
        })) {
          if (event.type === "usage") {
            usageRecord = addUsageRecord(usageTotals, {
              model: currentModel,
              usage: event.usage,
              metrics: event.metrics
            });
            continue;
          }

          const text = event.text;
          fullResponse += text;
          lineBuffer += text;

          if (lineBuffer.includes("\n")) {
            const lines = lineBuffer.split("\n");
            for (let i = 0; i < lines.length - 1; i++) {
              const formatted = formatLine(lines[i]);
              if (formatted !== null) {
                console.log(formatted);
              }
            }
            lineBuffer = lines[lines.length - 1];
          }
        }

        if (lineBuffer) {
          const formatted = formatLine(lineBuffer);
          if (formatted !== null) {
            console.log(formatted);
          }
        }

        messages = trimMessagesToMaxTurns([
          ...requestMessages,
          { role: "assistant", content: [{ text: fullResponse }] }
        ], cliArgs.maxTurns);
        if (usageRecord) {
          console.log("");
          console.log(`${ANSI.gray}${formatInteger(usageRecord.totalTokens)} Tokens, Session-Schaetzung ${formatUsd(usageRecord.costUsd)}${ANSI.reset}`);
        }
      } catch (err) {
        console.error(`\n${ANSI.yellow}API Fehler: ${formatBedrockErrorMessage(err)}${ANSI.reset}`);
        if (debugMode) {
          printDebugLines("Debug Fehler", formatBedrockErrorDiagnostics(err, {
            model: currentModel,
            modelId: bedrockModelId,
            region: creds.region,
            inferenceConfig
          }));
        } else {
          console.error(`${ANSI.gray}Debug: /debug einschalten oder mit --debug starten fuer Details.${ANSI.reset}`);
        }
        if ((err.message || "").includes("bedrock:InvokeModelWithResponseStream")) {
          console.error(`${ANSI.yellow}Hinweis:${ANSI.reset} Die aktive AWS-Identität braucht bedrock:InvokeModelWithResponseStream für das gewählte Modell bzw. Inference Profile.`);
        }
      }
      process.stdout.write(ANSI.reset);
      console.log("");
    }

    console.log(`\n${ANSI.gray}Chat beendet.${ANSI.reset}`);
  } catch (err) {
    console.error(`\nFehler: ${err.message}`);
    process.exitCode = 1;
  }
}
