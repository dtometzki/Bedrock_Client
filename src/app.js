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
import { parseCliArgs, getCliOptionHelp, DEFAULT_SYSTEM_PROMPT } from "./cli-args.js";
import {
  readLastModelId,
  readSavedInferenceOverrides,
  writeLastModelId,
  writeSavedInferenceOverrides
} from "./config.js";
import { clearSession, readSession, writeSession } from "./session.js";
import { appendAssistantResponse, countHistoryTurns, formatHistoryLimit, trimMessagesToMaxTurns } from "./history.js";
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
import { DEFAULT_WEB_PORT, openInBrowser, startWebServer } from "./web-server.js";
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
  const value = commandArg(input, "/debug").toLowerCase();
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

// Liefert das Argument eines Slash-Befehls, z. B. commandArg("/model foo", "/model") -> "foo".
function commandArg(input, name) {
  return input.slice(name.length).trim();
}

// True, wenn input exakt der Befehl ist oder mit "<name> " beginnt.
function matchesCommand(input, name) {
  return input === name || input.startsWith(`${name} `);
}

// Fuehrt eine Schreiboperation aus und meldet Fehler nur im Debug-Modus,
// statt sie still zu verschlucken.
function tryPersist(action, label, debugMode) {
  try {
    action();
  } catch (err) {
    if (debugMode) {
      console.error(`${ANSI.gray}Warnung: ${label} fehlgeschlagen: ${err.message}${ANSI.reset}`);
    }
  }
}

function clearSessionIfEnabled(ctx) {
  if (ctx.autoSaveEnabled) {
    clearSession();
  }
}

function persistSession(ctx) {
  if (ctx.autoSaveEnabled) {
    writeSession(ctx.messages, { modelId: ctx.modelId });
  }
}

// Entfernt das letzte user/assistant-Paar, falls es zum wiederholten Prompt passt.
// Sucht gezielt nach dem Paar am Ende statt feste Indizes anzunehmen.
function stripRetryPair(messages, prompt) {
  const assistant = messages[messages.length - 1];
  const user = messages[messages.length - 2];
  if (assistant?.role === "assistant" &&
      user?.role === "user" &&
      user.content?.[0]?.text === prompt) {
    return messages.slice(0, -2);
  }
  return messages;
}

// Verarbeitet einen Slash-Befehl. Rueckgabe:
//   { signal: "break" }               -> Chat beenden
//   { signal: "handled" }             -> Eingabe erledigt, naechster Prompt
//   { signal: "run", promptText }     -> Text an das Modell senden
async function handleCommand(input, ctx) {
  if (input === "/exit") {
    return { signal: "break" };
  }

  if (input === "/" || input === "/help") {
    printSlashCommands(input);
    return { signal: "handled" };
  }

  if (input === "/clear") {
    ctx.messages = [];
    clearSessionIfEnabled(ctx);
    console.log(`${ANSI.gray}Verlauf geleert.${ANSI.reset}`);
    console.log(terminalLine());
    return { signal: "handled" };
  }

  if (matchesCommand(input, "/system")) {
    const value = commandArg(input, "/system");
    if (!value) {
      printSystemStatus(ctx.systemPrompt);
      return { signal: "handled" };
    }
    if (["reset", "clear", "default"].includes(value.toLowerCase())) {
      ctx.systemPrompt = value.toLowerCase() === "clear" ? "" : DEFAULT_SYSTEM_PROMPT;
    } else {
      ctx.systemPrompt = value;
    }
    printSystemStatus(ctx.systemPrompt);
    return { signal: "handled" };
  }

  if (matchesCommand(input, "/debug")) {
    const nextDebugMode = parseDebugCommand(input, ctx.debugMode);
    if (nextDebugMode === null) {
      console.error(`${ANSI.yellow}Ungueltiger Debug-Wert:${ANSI.reset} ${commandArg(input, "/debug")}`);
      console.error(`${ANSI.gray}Nutze /debug, /debug on oder /debug off.${ANSI.reset}`);
      console.log(terminalLine());
      return { signal: "handled" };
    }
    ctx.debugMode = nextDebugMode;
    printDebugStatus(ctx.debugMode);
    return { signal: "handled" };
  }

  if (input === "/usage") {
    await printUsageSummary(ctx.usageTotals);
    return { signal: "handled" };
  }

  if (matchesCommand(input, "/export")) {
    if (!ctx.messages.length) {
      console.log(`${ANSI.gray}Kein Verlauf zum Exportieren.${ANSI.reset}`);
      console.log(terminalLine());
      return { signal: "handled" };
    }
    const targetPath = commandArg(input, "/export");
    try {
      const exportedPath = exportHistoryToMarkdown(ctx.messages, targetPath, {
        modelLabel: ctx.currentModel.label || ctx.modelId,
        systemPrompt: ctx.systemPrompt
      });
      console.log(`${ANSI.green}Exportiert:${ANSI.reset} ${exportedPath}`);
    } catch (err) {
      console.error(`${ANSI.yellow}Export fehlgeschlagen: ${err.message}${ANSI.reset}`);
    }
    console.log(terminalLine());
    return { signal: "handled" };
  }

  if (input === "/history") {
    printHistorySummary(ctx.messages, ctx.maxTurns);
    return { signal: "handled" };
  }

  if (input === "/account") {
    console.log(formatAccountSummary({
      profile: process.env.AWS_PROFILE || "default",
      region: ctx.region,
      identityLabel: ctx.identityLabel
    }).join("\n"));
    console.log(terminalLine());
    return { signal: "handled" };
  }

  if (matchesCommand(input, "/profile")) {
    const requestedProfile = commandArg(input, "/profile");
    if (!requestedProfile) {
      console.log(`${ANSI.green}AWS Profile:${ANSI.reset} ${formatProfileList(listAwsProfiles())}`);
      console.log(`${ANSI.green}Aktiv:${ANSI.reset} ${ctx.identityLabel || process.env.AWS_PROFILE || "default"}`);
      console.log(terminalLine());
      return { signal: "handled" };
    }

    try {
      const nextContext = switchAwsProfile(requestedProfile);
      ctx.region = nextContext.region;
      ctx.identityLabel = nextContext.identityLabel;
      ctx.bedrockClient = createBedrockClient({ region: ctx.region });
      ctx.messages = [];
      clearSessionIfEnabled(ctx);
      console.log(`${ANSI.green}AWS Profil:${ANSI.reset} ${nextContext.profile}`);
      if (ctx.identityLabel) {
        console.log(`${ANSI.green}Identitaet:${ANSI.reset} ${ctx.identityLabel}`);
      }
      console.log(`${ANSI.green}Region:${ANSI.reset} ${ctx.region}`);
      console.log(`${ANSI.gray}Verlauf geleert.${ANSI.reset}`);
      console.log(terminalLine());
    } catch (err) {
      console.error(`${ANSI.yellow}${err.message}${ANSI.reset}`);
      console.log(terminalLine());
    }
    return { signal: "handled" };
  }

  if (matchesCommand(input, "/model")) {
    const requestedModel = commandArg(input, "/model");
    let selected = null;
    if (requestedModel) {
      selected = findModel(ctx.models, requestedModel);
      if (!selected) {
        console.error(`${ANSI.yellow}Modell nicht gefunden:${ANSI.reset} ${requestedModel}`);
        console.error(`${ANSI.gray}Verfuegbar: ${ctx.models.map((m) => m.label).join(", ")}${ANSI.reset}`);
        console.log(terminalLine());
        return { signal: "handled" };
      }
    } else {
      selected = await promptForModelSelection(ctx.models, ctx.modelId);
    }
    if (selected) {
      ctx.modelId = selected.id;
      ctx.currentModel = selected;
      ctx.inferenceConfig = buildInferenceConfig(ctx.currentModel, ctx.activeInferenceOverrides);
      tryPersist(() => writeLastModelId(ctx.modelId), "Modell speichern", ctx.debugMode);
      console.log(`${ANSI.green}Modell:${ANSI.reset} ${ctx.currentModel.label || ctx.modelId}`);
      console.log(terminalLine());
    }
    return { signal: "handled" };
  }

  if (input === "/retry") {
    if (!ctx.lastPrompt) {
      console.error(`${ANSI.yellow}Kein vorheriger Prompt zum Wiederholen.${ANSI.reset}`);
      console.log(terminalLine());
      return { signal: "handled" };
    }
    ctx.messages = stripRetryPair(ctx.messages, ctx.lastPrompt);
    console.log(`${ANSI.gray}Wiederhole: ${ctx.lastPrompt}${ANSI.reset}`);
    return { signal: "run", promptText: ctx.lastPrompt };
  }

  if (input.startsWith("/")) {
    const commandName = input.split(/\s+/, 1)[0];
    console.error(`${ANSI.yellow}Unbekannter Befehl:${ANSI.reset} ${commandName}`);
    printSlashCommands(commandName);
    return { signal: "handled" };
  }

  return { signal: "run", promptText: input };
}

function printHelp(models) {
  console.log(`${ANSI.bold}Verwendung:${ANSI.reset} bedrock-chat [Optionen]\n`);
  console.log("Optionen:");
  const optionHelp = getCliOptionHelp(DEFAULT_WEB_PORT);
  const optionWidth = Math.max(...optionHelp.map(([flag]) => flag.length));
  optionHelp.forEach(([flag, description]) => {
    console.log(`  ${flag.padEnd(optionWidth)}  ${description}`);
  });
  console.log("");
  console.log("Commands:");
  const commandNameWidth = Math.max(...SLASH_COMMANDS.map((command) => command.name.length));
  SLASH_COMMANDS.forEach((command) => {
    console.log(`  ${command.name.padEnd(commandNameWidth)}  ${command.description}`);
  });
  console.log("");
  console.log("Modelle:");
  models.forEach((m) => console.log(`  - ${m.label} (${m.id})`));
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
      printHelp(models);
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

    const startupDebugMode = cliArgs.debug || isDebugEnvEnabled(process.env.BEDROCK_CHAT_DEBUG);

    if (!cliArgs.web && !cliArgs.model && !resumeModelId && !lastModelId && models.length > 1) {
      const selected = await promptForModelSelection(models, modelId);
      if (selected) {
        modelId = selected.id;
        tryPersist(() => writeLastModelId(modelId), "Modell speichern", startupDebugMode);
      }
    }

    const currentModel = models.find((m) => m.id === modelId) ?? activeModel;
    const savedInferenceOverrides = readSavedInferenceOverrides();
    const activeInferenceOverrides = {
      ...savedInferenceOverrides,
      ...cliArgs.inferenceOverrides
    };
    if (Object.keys(cliArgs.inferenceOverrides).length) {
      tryPersist(
        () => writeSavedInferenceOverrides(activeInferenceOverrides),
        "Inference-Overrides speichern",
        startupDebugMode
      );
    }
    const inferenceConfig = buildInferenceConfig(currentModel, activeInferenceOverrides);
    if (cliArgs.region) {
      // Ueberschreibt die Region der Default-Aufloesung (Env, Profil-Konfiguration).
      // Gilt auch nach /profile-Wechseln, da resolveAwsRegion AWS_REGION bevorzugt.
      process.env.AWS_REGION = cliArgs.region;
    }
    const startupContext = cliArgs.profile ? switchAwsProfile(cliArgs.profile) : loadAwsContext();

    const autoSaveEnabled = !cliArgs.noSave;

    // Gebuendelter, veraenderlicher Zustand der Chat-Sitzung.
    const ctx = {
      models,
      activeInferenceOverrides,
      autoSaveEnabled,
      usageTotals: emptyUsageTotals(),
      promptHistory: [],
      maxTurns: cliArgs.maxTurns,
      messages: [],
      lastPrompt: null,
      systemPrompt: cliArgs.system,
      debugMode: startupDebugMode,
      currentModel,
      modelId,
      inferenceConfig,
      region: startupContext.region,
      identityLabel: startupContext.identityLabel,
      bedrockClient: createBedrockClient({ region: startupContext.region })
    };

    printStartupBanner({ model: ctx.currentModel, inferenceConfig: ctx.inferenceConfig });
    if (ctx.debugMode) {
      printDebugStatus(ctx.debugMode);
    }

    if (cliArgs.resume) {
      if (savedSession.messages.length) {
        ctx.messages = trimMessagesToMaxTurns(savedSession.messages, cliArgs.maxTurns);
        console.log(`${ANSI.green}Verlauf fortgesetzt:${ANSI.reset} ${countHistoryTurns(ctx.messages)} Turns${savedSession.savedAt ? ` (${savedSession.savedAt})` : ""}`);
        if (resumeModelId && !cliArgs.model) {
          console.log(`${ANSI.green}Modell wiederhergestellt:${ANSI.reset} ${ctx.currentModel.label || ctx.modelId}`);
        }
        console.log(terminalLine());
      } else {
        console.log(`${ANSI.gray}Kein gespeicherter Verlauf gefunden.${ANSI.reset}`);
        console.log(terminalLine());
      }
    }

    if (cliArgs.web) {
      const { url } = await startWebServer({
        models,
        model: ctx.currentModel,
        client: ctx.bedrockClient,
        inferenceOverrides: activeInferenceOverrides,
        systemPrompt: ctx.systemPrompt,
        region: ctx.region,
        identityLabel: ctx.identityLabel,
        profile: process.env.AWS_PROFILE || "default",
        maxTurns: cliArgs.maxTurns,
        autoSave: autoSaveEnabled,
        messages: ctx.messages,
        port: cliArgs.port ?? DEFAULT_WEB_PORT
      });
      console.log(`${ANSI.green}Web-GUI:${ANSI.reset} ${url}`);
      if (!cliArgs.noOpen) {
        openInBrowser(url);
      }
      console.log(`${ANSI.gray}Beenden mit Ctrl+C.${ANSI.reset}`);
      return;
    }

    while (true) {
      const prompt = await readPrompt({ history: ctx.promptHistory });
      if (prompt === null) break;
      const input = prompt.trim();

      if (!input) continue;
      if (ctx.promptHistory[ctx.promptHistory.length - 1] !== input) {
        ctx.promptHistory.push(input);
      }

      const result = await handleCommand(input, ctx);
      if (result.signal === "break") break;
      if (result.signal === "handled") continue;

      const promptText = result.promptText;
      ctx.lastPrompt = promptText;
      const userMessage = { role: "user", content: [{ text: promptText }] };
      const requestMessages = [...ctx.messages, userMessage];
      process.stdout.write("\n");

      const bedrockModelId = getModelInvocationId(ctx.currentModel);
      const interrupter = createStreamInterruptController();

      let fullResponse = "";
      let lineBuffer = "";
      let usageRecord = null;
      let aborted = false;
      let requestError = null;
      let reasoningOpen = false;

      const flushLineBuffer = () => {
        if (lineBuffer) {
          const formatted = formatLine(lineBuffer);
          if (formatted !== null) {
            console.log(formatted);
          }
          lineBuffer = "";
        }
      };

      try {
        if (ctx.debugMode) {
          printDebugLines("Debug Request", formatDebugRequestLines({
            model: ctx.currentModel,
            modelId: bedrockModelId,
            region: ctx.region,
            profile: process.env.AWS_PROFILE || "default",
            inferenceConfig: ctx.inferenceConfig,
            historyMessages: ctx.messages,
            requestMessages,
            system: ctx.systemPrompt,
            maxTurns: ctx.maxTurns
          }));
        }

        resetResponseFormatting();

        for await (const event of streamConverseWithRetry(ctx.bedrockClient, {
          modelId: bedrockModelId,
          messages: requestMessages,
          system: ctx.systemPrompt,
          inferenceConfig: ctx.inferenceConfig,
          abortSignal: interrupter.signal
        })) {
          if (event.type === "retry") {
            console.error(`${ANSI.gray}Erneuter Versuch ${event.attempt}/${event.maxRetries} in ${Math.round(event.delayMs)} ms (${formatBedrockErrorMessage(event.error)})${ANSI.reset}`);
            continue;
          }
          if (event.type === "usage") {
            usageRecord = addUsageRecord(ctx.usageTotals, {
              model: ctx.currentModel,
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

      // Bereits gepufferte Teil-Zeile in jedem Fall ausgeben (auch bei Fehler/Abbruch).
      flushLineBuffer();

      if (requestError) {
        console.error(`\n${ANSI.yellow}API Fehler: ${formatBedrockErrorMessage(requestError)}${ANSI.reset}`);
        if (ctx.debugMode) {
          printDebugLines("Debug Fehler", formatBedrockErrorDiagnostics(requestError, {
            model: ctx.currentModel,
            modelId: bedrockModelId,
            region: ctx.region,
            inferenceConfig: ctx.inferenceConfig
          }));
        } else {
          console.error(`${ANSI.gray}Debug: /debug einschalten oder mit --debug starten fuer Details.${ANSI.reset}`);
        }
        if ((requestError.message || "").includes("bedrock:InvokeModelWithResponseStream")) {
          console.error(`${ANSI.yellow}Hinweis:${ANSI.reset} Die aktive AWS-Identität braucht bedrock:InvokeModelWithResponseStream für das gewählte Modell bzw. Inference Profile.`);
        }
      } else {
        if (aborted) {
          console.log(`\n${ANSI.gray}Antwort abgebrochen.${ANSI.reset}`);
        }

        if (fullResponse) {
          ctx.messages = appendAssistantResponse(requestMessages, fullResponse, {
            aborted,
            maxTurns: cliArgs.maxTurns
          });
          persistSession(ctx);
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
