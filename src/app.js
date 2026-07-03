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
import { parseCliArgs, DEFAULT_SYSTEM_PROMPT } from "./cli-args.js";
import {
  readLastModelId,
  readSavedInferenceOverrides,
  writeLastModelId,
  writeSavedInferenceOverrides
} from "./config.js";
import { clearSession, readSession, writeSession } from "./session.js";
import { countHistoryTurns, formatHistoryLimit, trimMessagesToMaxTurns } from "./history.js";
import { findModel, getModelInvocationId, loadModels, resolveStartupModel } from "./models.js";
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
  isAbortError,
  streamConverseWithRetry
} from "./bedrock.js";
import { createStreamInterruptController, promptForModelSelection, readPrompt } from "./prompt.js";
import { exportHistoryToMarkdown } from "./export.js";
import { formatLine, resetResponseFormatting } from "./response-format.js";
import { addUsageRecord, emptyUsageTotals, printUsageSummary } from "./usage.js";

function printHistorySummary(messages, maxTurns) {
  console.log(`${ANSI.green}Verlauf:${ANSI.reset} ${countHistoryTurns(messages)} Turns, ${messages.length} Nachrichten`);
  console.log(`${ANSI.green}Limit:${ANSI.reset} ${formatHistoryLimit(maxTurns)}`);
  console.log(terminalLine());
}

function printSystemStatus(systemPrompt) {
  if (systemPrompt) {
    console.log(`${ANSI.green}System Prompt:${ANSI.reset} ${systemPrompt}`);
  } else {
    console.log(`${ANSI.green}System Prompt:${ANSI.reset} ${ANSI.gray}nicht gesetzt${ANSI.reset}`);
  }
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
      console.log("  -r, --region <name> AWS Region ueberschreiben");
      console.log("  -s, --system <text> System Prompt setzen");
      console.log("  --system-file <pfad> System Prompt aus Datei laden");
      console.log("  --max-tokens <n>    Max. Antwort-Tokens setzen");
      console.log("  --temperature <n>   Temperatur setzen (0 bis 1)");
      console.log("  --top-p <n>         Top-P / Nucleus Sampling setzen (0 bis 1)");
      console.log("  --stop <text>       Stop-Sequenz setzen (mehrfach moeglich)");
      console.log("  --max-turns <n>     Verlauf auf n Chat-Turns begrenzen, 0 = unbegrenzt");
      console.log("  --resume            Letzten gespeicherten Verlauf fortsetzen");
      console.log("  --no-save           Verlauf nicht automatisch speichern");
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
    const savedSession = cliArgs.resume ? readSession() : null;
    const resumeModelId = savedSession?.modelId && findModel(models, savedSession.modelId)
      ? savedSession.modelId
      : null;
    const activeModel = resolveStartupModel(models, {
      requestedModel: cliArgs.model,
      lastModelId: resumeModelId ?? lastModelId
    });
    let modelId = activeModel.id;

    if (!cliArgs.model && !resumeModelId && !lastModelId && models.length > 1) {
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
    if (cliArgs.region) {
      // Ueberschreibt die Region der Default-Aufloesung (Env, Profil-Konfiguration).
      // Gilt auch nach /profile-Wechseln, da resolveAwsRegion AWS_REGION bevorzugt.
      process.env.AWS_REGION = cliArgs.region;
    }
    const startupContext = cliArgs.profile ? switchAwsProfile(cliArgs.profile) : loadAwsContext();
    let { region, identityLabel } = startupContext;
    let bedrockClient = createBedrockClient({ region });
    let debugMode = cliArgs.debug || isDebugEnvEnabled(process.env.BEDROCK_CHAT_DEBUG);
    let systemPrompt = cliArgs.system;
    const autoSaveEnabled = !cliArgs.noSave;
    printStartupBanner({ model: currentModel, inferenceConfig });
    if (debugMode) {
      printDebugStatus(debugMode);
    }

    let messages = [];
    let lastPrompt = null;
    const promptHistory = [];
    const usageTotals = emptyUsageTotals();

    function persistSession() {
      if (autoSaveEnabled) {
        writeSession(messages, { modelId });
      }
    }

    if (cliArgs.resume) {
      const saved = savedSession;
      if (saved.messages.length) {
        messages = trimMessagesToMaxTurns(saved.messages, cliArgs.maxTurns);
        console.log(`${ANSI.green}Verlauf fortgesetzt:${ANSI.reset} ${countHistoryTurns(messages)} Turns${saved.savedAt ? ` (${saved.savedAt})` : ""}`);
        if (resumeModelId && !cliArgs.model) {
          console.log(`${ANSI.green}Modell wiederhergestellt:${ANSI.reset} ${currentModel.label || modelId}`);
        }
        console.log(terminalLine());
      } else {
        console.log(`${ANSI.gray}Kein gespeicherter Verlauf gefunden.${ANSI.reset}`);
        console.log(terminalLine());
      }
    }

    while (true) {
      const prompt = await readPrompt({ history: promptHistory });
      if (prompt === null) break;
      const input = prompt.trim();

      if (!input) continue;
      if (promptHistory[promptHistory.length - 1] !== input) {
        promptHistory.push(input);
      }
      if (input === "/exit") break;
      if (input === "/" || input === "/help") {
        printSlashCommands(input);
        continue;
      }
      if (input === "/clear") {
        messages = [];
        if (autoSaveEnabled) {
          clearSession();
        }
        console.log(`${ANSI.gray}Verlauf geleert.${ANSI.reset}`);
        console.log(terminalLine());
        continue;
      }
      if (input === "/system" || input.startsWith("/system ")) {
        const value = input.slice("/system".length).trim();
        if (!value) {
          printSystemStatus(systemPrompt);
          continue;
        }
        if (["reset", "clear", "default"].includes(value.toLowerCase())) {
          systemPrompt = value.toLowerCase() === "clear" ? "" : DEFAULT_SYSTEM_PROMPT;
        } else {
          systemPrompt = value;
        }
        printSystemStatus(systemPrompt);
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
        await printUsageSummary(usageTotals);
        continue;
      }
      if (input === "/export" || input.startsWith("/export ")) {
        if (!messages.length) {
          console.log(`${ANSI.gray}Kein Verlauf zum Exportieren.${ANSI.reset}`);
          console.log(terminalLine());
          continue;
        }
        const targetPath = input.slice("/export".length).trim();
        try {
          const exportedPath = exportHistoryToMarkdown(messages, targetPath, {
            modelLabel: currentModel.label || modelId,
            systemPrompt
          });
          console.log(`${ANSI.green}Exportiert:${ANSI.reset} ${exportedPath}`);
        } catch (err) {
          console.error(`${ANSI.yellow}Export fehlgeschlagen: ${err.message}${ANSI.reset}`);
        }
        console.log(terminalLine());
        continue;
      }
      if (input === "/history") {
        printHistorySummary(messages, cliArgs.maxTurns);
        continue;
      }
      if (input === "/account") {
        console.log(formatAccountSummary({
          profile: process.env.AWS_PROFILE || "default",
          region,
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
          region = nextContext.region;
          identityLabel = nextContext.identityLabel;
          bedrockClient = createBedrockClient({ region });
          messages = [];
          if (autoSaveEnabled) {
            clearSession();
          }
          console.log(`${ANSI.green}AWS Profil:${ANSI.reset} ${nextContext.profile}`);
          if (identityLabel) {
            console.log(`${ANSI.green}Identitaet:${ANSI.reset} ${identityLabel}`);
          }
          console.log(`${ANSI.green}Region:${ANSI.reset} ${region}`);
          console.log(`${ANSI.gray}Verlauf geleert.${ANSI.reset}`);
          console.log(terminalLine());
        } catch (err) {
          console.error(`${ANSI.yellow}${err.message}${ANSI.reset}`);
          console.log(terminalLine());
        }
        continue;
      }
      if (input === "/model" || input.startsWith("/model ")) {
        const requestedModel = input.slice("/model".length).trim();
        let selected = null;
        if (requestedModel) {
          selected = findModel(models, requestedModel);
          if (!selected) {
            console.log(`${ANSI.yellow}Modell nicht gefunden:${ANSI.reset} ${requestedModel}`);
            console.log(`${ANSI.gray}Verfuegbar: ${models.map((m) => m.label).join(", ")}${ANSI.reset}`);
            console.log(terminalLine());
            continue;
          }
        } else {
          selected = await promptForModelSelection(models, modelId);
        }
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
      let promptText = input;
      if (input === "/retry") {
        if (!lastPrompt) {
          console.log(`${ANSI.yellow}Kein vorheriger Prompt zum Wiederholen.${ANSI.reset}`);
          console.log(terminalLine());
          continue;
        }
        promptText = lastPrompt;
        const lastUser = messages[messages.length - 2];
        const lastAssistant = messages[messages.length - 1];
        if (lastAssistant?.role === "assistant" &&
            lastUser?.role === "user" &&
            lastUser.content?.[0]?.text === lastPrompt) {
          messages = messages.slice(0, -2);
        }
        console.log(`${ANSI.gray}Wiederhole: ${promptText}${ANSI.reset}`);
      } else if (input.startsWith("/")) {
        const commandName = input.split(/\s+/, 1)[0];
        console.log(`${ANSI.yellow}Unbekannter Befehl:${ANSI.reset} ${commandName}`);
        printSlashCommands(commandName);
        continue;
      }

      lastPrompt = promptText;
      const userMessage = { role: "user", content: [{ text: promptText }] };
      const requestMessages = [...messages, userMessage];
      process.stdout.write("\n");

      const bedrockModelId = getModelInvocationId(currentModel);
      const interrupter = createStreamInterruptController();

      let fullResponse = "";
      let lineBuffer = "";
      let usageRecord = null;
      let aborted = false;
      let requestError = null;
      let reasoningOpen = false;

      try {
        if (debugMode) {
          printDebugLines("Debug Request", formatDebugRequestLines({
            model: currentModel,
            modelId: bedrockModelId,
            region,
            profile: process.env.AWS_PROFILE || "default",
            inferenceConfig,
            historyMessages: messages,
            requestMessages,
            system: systemPrompt,
            maxTurns: cliArgs.maxTurns
          }));
        }

        resetResponseFormatting();

        for await (const event of streamConverseWithRetry(bedrockClient, {
          modelId: bedrockModelId,
          messages: requestMessages,
          system: systemPrompt,
          inferenceConfig,
          abortSignal: interrupter.signal
        })) {
          if (event.type === "retry") {
            console.error(`${ANSI.gray}Erneuter Versuch ${event.attempt}/${event.maxRetries} in ${Math.round(event.delayMs)} ms (${formatBedrockErrorMessage(event.error)})${ANSI.reset}`);
            continue;
          }
          if (event.type === "usage") {
            usageRecord = addUsageRecord(usageTotals, {
              model: currentModel,
              usage: event.usage,
              metrics: event.metrics
            });
            continue;
          }
          if (event.type === "reasoning") {
            if (!reasoningOpen) {
              process.stdout.write(`${ANSI.gray}[Reasoning]\n`);
              reasoningOpen = true;
            }
            process.stdout.write(event.text);
            continue;
          }
          if (reasoningOpen) {
            process.stdout.write(`${ANSI.reset}\n\n`);
            reasoningOpen = false;
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
      } catch (err) {
        if (isAbortError(err) || interrupter.signal.aborted) {
          aborted = true;
        } else {
          requestError = err;
        }
      } finally {
        if (reasoningOpen) {
          process.stdout.write(`${ANSI.reset}\n`);
          reasoningOpen = false;
        }
        interrupter.dispose();
      }

      if (requestError) {
        console.error(`\n${ANSI.yellow}API Fehler: ${formatBedrockErrorMessage(requestError)}${ANSI.reset}`);
        if (debugMode) {
          printDebugLines("Debug Fehler", formatBedrockErrorDiagnostics(requestError, {
            model: currentModel,
            modelId: bedrockModelId,
            region,
            inferenceConfig
          }));
        } else {
          console.error(`${ANSI.gray}Debug: /debug einschalten oder mit --debug starten fuer Details.${ANSI.reset}`);
        }
        if ((requestError.message || "").includes("bedrock:InvokeModelWithResponseStream")) {
          console.error(`${ANSI.yellow}Hinweis:${ANSI.reset} Die aktive AWS-Identität braucht bedrock:InvokeModelWithResponseStream für das gewählte Modell bzw. Inference Profile.`);
        }
      } else {
        if (lineBuffer) {
          const formatted = formatLine(lineBuffer);
          if (formatted !== null) {
            console.log(formatted);
          }
        }

        if (aborted) {
          console.log(`\n${ANSI.gray}Antwort abgebrochen.${ANSI.reset}`);
        }

        if (fullResponse) {
          const responseText = aborted
            ? `${fullResponse}\n\n[Antwort abgebrochen – unvollstaendig]`
            : fullResponse;
          messages = trimMessagesToMaxTurns([
            ...requestMessages,
            { role: "assistant", content: [{ text: responseText }] }
          ], cliArgs.maxTurns);
          persistSession();
        }

        if (usageRecord) {
          console.log("");
          console.log(`${ANSI.gray}${formatInteger(usageRecord.totalTokens)} Tokens, Session-Schaetzung ${formatUsd(usageRecord.costUsd)}${ANSI.reset}`);
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
