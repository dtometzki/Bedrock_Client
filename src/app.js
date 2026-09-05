import { combineAbortSignals } from "./abort-signals.js";
import { AuthService, safeAwsError } from "./auth.js";
import { manageAuth } from "./auth-prompt.js";
import {
  ANSI,
  formatAccountSummary,
  formatEffortLabel,
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
  readSavedEffort,
  readSavedInferenceOverrides,
  tryPersist,
  writeLastModelId,
  writeSavedEffort,
  writeSavedInferenceOverrides
} from "./config.js";
import { clearSession, readSession, writeSession } from "./session.js";
import { appendAssistantResponse, countHistoryTurns, formatHistoryLimit, trimMessagesToMaxTurns } from "./history.js";
import { findModel, getModelInvocationId, loadModels, normalizeEffort, resolveEffortLevel, resolveModelsPath, resolveStartupModel } from "./models.js";
import {
  printAwsProfiles,
} from "./aws-context.js";
import {
  accountMismatchFromError,
  buildAdaptiveThinkingFields,
  buildInferenceConfig,
  createBedrockClient,
  formatBedrockErrorDiagnostics,
  formatBedrockErrorMessage,
  regionForModelId,
  streamConverseWithRetry
} from "./bedrock.js";
import { consumeConverseStream } from "./stream-consumer.js";
import { createStreamInterruptController, promptForModelSelection, readPrompt } from "./prompt.js";
import { exportHistoryToMarkdown } from "./export.js";
import { createBrowserBootstrap, DEFAULT_WEB_PORT, openInBrowser, startWebServer } from "./web-server.js";
import { formatLine, resetResponseFormatting, sanitizeTerminalText } from "./response-format.js";
import { emptyUsageTotals, printUsageSummary } from "./usage.js";

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

const DEBUG_TRUTHY = new Set(["1", "an", "ein", "on", "true", "yes"]);
const DEBUG_FALSY = new Set(["0", "aus", "off", "false", "no"]);

function isDebugEnvEnabled(value) {
  return DEBUG_TRUTHY.has(String(value || "").toLowerCase());
}

function parseDebugCommand(input, currentDebugMode) {
  const value = commandArg(input, "/debug").toLowerCase();
  if (!value) return !currentDebugMode;
  if (DEBUG_TRUTHY.has(value)) return true;
  if (DEBUG_FALSY.has(value)) return false;
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
  effort,
  additionalModelRequestFields,
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
    ...(effort ? [`Effort: ${effort}`] : []),
    ...(additionalModelRequestFields ? [`Additional Fields: ${JSON.stringify(additionalModelRequestFields)}`] : []),
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

function clearSessionIfEnabled(ctx) {
  if (ctx.autoSaveEnabled && !clearSession()) {
    console.error(`${ANSI.yellow}Gespeicherter Verlauf konnte nicht geloescht werden.${ANSI.reset}`);
    return false;
  }
  return true;
}

function persistSession(ctx) {
  if (ctx.autoSaveEnabled && !writeSession(ctx.messages, { modelId: ctx.modelId })) {
    console.error(`${ANSI.yellow}Warnung: Verlauf konnte nicht gespeichert werden. Neue Nachrichten sind nur in dieser Sitzung verfuegbar.${ANSI.reset}`);
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

async function cmdExit() {
  return { signal: "break" };
}

async function cmdHelp(input) {
  printSlashCommands(input);
  return { signal: "handled" };
}

async function cmdClear(_input, ctx) {
  if (!clearSessionIfEnabled(ctx)) {
    return { signal: "handled" };
  }
  ctx.messages = [];
  console.log(`${ANSI.gray}Verlauf geleert.${ANSI.reset}`);
  console.log(terminalLine());
  return { signal: "handled" };
}

async function cmdSystem(input, ctx) {
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

async function cmdDebug(input, ctx) {
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

async function cmdUsage(_input, ctx) {
  await printUsageSummary(ctx.usageTotals, { auth: ctx.auth });
  return { signal: "handled" };
}

async function cmdExport(input, ctx) {
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

async function cmdHistory(_input, ctx) {
  printHistorySummary(ctx.messages, ctx.maxTurns);
  return { signal: "handled" };
}

async function cmdAccount(_input, ctx) {
  console.log(formatAccountSummary({
    profile: ctx.auth.profile,
    region: ctx.region,
    identityLabel: ctx.auth.identityLabel
  }).join("\n"));
  console.log(terminalLine());
  return { signal: "handled" };
}

async function cmdProfile(input, ctx) {
  const requestedProfile = commandArg(input, "/profile");
  if (!requestedProfile) {
    console.log(`${ANSI.green}AWS Profile:${ANSI.reset} ${(await ctx.auth.listProfiles()).map(sanitizeTerminalText).join(", ")}`);
    console.log(`${ANSI.green}Aktiv:${ANSI.reset} ${sanitizeTerminalText(ctx.auth.status().profile || "Tresor gesperrt")}`);
    console.log(terminalLine());
    return { signal: "handled" };
  }

  try {
    await ctx.auth.changeProfile(requestedProfile);
    ctx.region = ctx.auth.region;
    console.log(`AWS Profil: ${sanitizeTerminalText(requestedProfile)}. Verbindung mit /auth check pruefen.`);
  } catch (err) { console.error(sanitizeTerminalText(err.message)); }

  return { signal: "handled" };
}

async function cmdAuth(input, ctx) {
  try { await manageAuth(ctx.auth, commandArg(input, "/auth") || "status"); }
  catch (err) { console.error(sanitizeTerminalText(err.message)); }
  return { signal: "handled" };
}

async function cmdModel(input, ctx) {
  const requestedModel = commandArg(input, "/model");
  let nextModel = null;
  let nextEffort = ctx.effort;
  if (requestedModel) {
    nextModel = findModel(ctx.models, requestedModel);
    if (!nextModel) {
      console.error(`${ANSI.yellow}Modell nicht gefunden:${ANSI.reset} ${requestedModel}`);
      console.error(`${ANSI.gray}Verfuegbar: ${ctx.models.map((m) => m.label).join(", ")}${ANSI.reset}`);
      console.log(terminalLine());
      return { signal: "handled" };
    }
    // Effort-Wunsch beibehalten, falls das neue Modell ihn unterstuetzt.
    // ctx.preferredEffort bleibt auch ueber Modelle ohne Effort hinweg
    // erhalten (sticky), damit die Wahl beim Zurueckwechseln nicht verloren geht.
    nextEffort = resolveEffortLevel(nextModel, ctx.preferredEffort);
  } else {
    const selection = await promptForModelSelection(ctx.models, ctx.modelId, ctx.preferredEffort);
    if (selection) {
      nextModel = selection.model;
      nextEffort = selection.effort;
    }
  }
  if (nextModel) {
    ctx.modelId = nextModel.id;
    ctx.currentModel = nextModel;
    ctx.effort = nextEffort;
    ctx.inferenceConfig = buildInferenceConfig(ctx.currentModel, ctx.activeInferenceOverrides);
    tryPersist(() => writeLastModelId(ctx.modelId), "Modell speichern", ctx.debugMode);
    // Nur speichern, wenn das Modell Effort unterstuetzt. writeSavedEffort(null)
    // wuerde die gespeicherte Praeferenz loeschen, obwohl der Nutzer sie beim
    // naechsten Effort-Modell wieder erwartet.
    if (nextEffort) {
      ctx.preferredEffort = nextEffort;
      tryPersist(() => writeSavedEffort(nextEffort), "Effort speichern", ctx.debugMode);
    }
    const effortLabel = formatEffortLabel(ctx.effort);
    const effortSuffix = effortLabel ? ` ${ANSI.gray}(Effort: ${effortLabel})${ANSI.reset}` : "";
    console.log(`${ANSI.green}Modell:${ANSI.reset} ${ctx.currentModel.label || ctx.modelId}${effortSuffix}`);
    console.log(terminalLine());
  }
  return { signal: "handled" };
}

async function cmdRetry(_input, ctx) {
  if (!ctx.lastPrompt) {
    console.error(`${ANSI.yellow}Kein vorheriger Prompt zum Wiederholen.${ANSI.reset}`);
    console.log(terminalLine());
    return { signal: "handled" };
  }
  ctx.messages = stripRetryPair(ctx.messages, ctx.lastPrompt);
  console.log(`${ANSI.gray}Wiederhole: ${ctx.lastPrompt}${ANSI.reset}`);
  return { signal: "run", promptText: ctx.lastPrompt };
}

const COMMAND_DISPATCH = [
  { match: (i) => i === "/exit", handle: cmdExit },
  { match: (i) => i === "/" || i === "/help", handle: cmdHelp },
  { match: (i) => i === "/clear", handle: cmdClear },
  { match: (i) => matchesCommand(i, "/system"), handle: cmdSystem },
  { match: (i) => matchesCommand(i, "/debug"), handle: cmdDebug },
  { match: (i) => i === "/usage", handle: cmdUsage },
  { match: (i) => matchesCommand(i, "/export"), handle: cmdExport },
  { match: (i) => i === "/history", handle: cmdHistory },
  { match: (i) => i === "/account", handle: cmdAccount },
  { match: (i) => matchesCommand(i, "/profile"), handle: cmdProfile },
  { match: (i) => matchesCommand(i, "/auth"), handle: cmdAuth },
  { match: (i) => matchesCommand(i, "/model"), handle: cmdModel },
  { match: (i) => i === "/retry", handle: cmdRetry }
];

async function handleCommand(input, ctx) {
  for (const { match, handle } of COMMAND_DISPATCH) {
    if (match(input)) {
      return handle(input, ctx);
    }
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

// Begrenzt die Eingabe-History, damit sie in sehr langen Sessions nicht
// unbegrenzt im Speicher waechst.
const MAX_PROMPT_HISTORY = 500;

// Merkt sich den Prompt in der History, ohne aufeinanderfolgende Duplikate.
// Das Array darf bis zum 1.5-fachen Limit wachsen, bevor es periodisch
// getrimmt wird – so entfallen ~99% der splice-Allokationen.
function rememberPrompt(ctx, input) {
  if (ctx.promptHistory[ctx.promptHistory.length - 1] !== input) {
    ctx.promptHistory.push(input);
    if (ctx.promptHistory.length > MAX_PROMPT_HISTORY * 1.5) {
      ctx.promptHistory = ctx.promptHistory.slice(-MAX_PROMPT_HISTORY);
    }
  }
}

// Liefert den Bedrock-Client fuer die effektive Anfrageregion. Ein
// Inference-Profile-ARN ist an die Region im ARN gebunden; ambient
// (Profil/Env) konfigurierte Regionen wuerden sonst zu "The provided model
// identifier is invalid." fuehren. Fuer die Umgebungsregion wird der bestehende
// Client wiederverwendet, abweichende ARN-Regionen bekommen einen eigenen,
// zwischengespeicherten Client.
async function resolveBedrockClient(ctx, region) {
  const config = await ctx.auth.clientConfig();
  ctx.region = config.region;
  if (!region || region === ctx.region) {
    ctx.bedrockClient ??= ctx.auth.track(createBedrockClient(config));
    return ctx.bedrockClient;
  }
  ctx.regionalBedrockClients ??= new Map();
  let client = ctx.regionalBedrockClients.get(region);
  if (!client) {
    client = ctx.auth.track(createBedrockClient({ ...config, region }));
    ctx.regionalBedrockClients.set(region, client);
  }
  return client;
}

// Verwirft die zusaetzlich pro ARN-Region angelegten Clients. Wird beim
// Profilwechsel gebraucht, damit keine mit alten Credentials erzeugten Clients
// weiterverwendet werden, und beim Beenden zum Aufraeumen offener Sockets.
function destroyRegionalBedrockClients(ctx) {
  if (!ctx.regionalBedrockClients) return;
  for (const client of ctx.regionalBedrockClients.values()) {
    client?.destroy?.();
  }
  ctx.regionalBedrockClients.clear();
}

// Sendet einen Prompt an das Modell, streamt die Antwort und aktualisiert ctx.
async function streamModelResponse(ctx, promptText, operation) {
  ctx.lastPrompt = promptText;
  const userMessage = { role: "user", content: [{ text: promptText }] };
  const requestMessages = [...ctx.messages, userMessage];
  process.stdout.write("\n");

  const bedrockModelId = getModelInvocationId(ctx.currentModel);
  const requestRegion = regionForModelId(bedrockModelId, ctx.region);
  const bedrockClient = await resolveBedrockClient(ctx, requestRegion);
  const effortConfig = normalizeEffort(ctx.currentModel);
  const additionalModelRequestFields = effortConfig
    ? buildAdaptiveThinkingFields(ctx.effort, effortConfig.style)
    : undefined;
  const interrupter = createStreamInterruptController();
  const abortSignal = combineAbortSignals([interrupter.signal, operation.signal]);
  interrupter.signal.addEventListener("abort", operation.cancel, { once: true });

  try {
    let lineBuffer = "";
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

    if (ctx.debugMode) {
      printDebugLines("Debug Request", formatDebugRequestLines({
        model: ctx.currentModel,
        modelId: bedrockModelId,
        region: requestRegion,
        profile: ctx.auth.profile,
        inferenceConfig: ctx.inferenceConfig,
        effort: ctx.effort,
        additionalModelRequestFields,
        historyMessages: ctx.messages,
        requestMessages,
        system: ctx.systemPrompt,
        maxTurns: ctx.maxTurns
      }));
    }

    resetResponseFormatting();

    const { fullResponse, usageRecord, aborted, error: requestError } = await consumeConverseStream(
      streamConverseWithRetry(bedrockClient, {
        modelId: bedrockModelId,
        messages: requestMessages,
        system: ctx.systemPrompt,
        inferenceConfig: ctx.inferenceConfig,
        additionalModelRequestFields,
        abortSignal
      }),
      {
        usageTotals: ctx.usageTotals,
        model: ctx.currentModel,
        abortSignal,
        onRetry: (event) => {
          console.error(`${ANSI.gray}Erneuter Versuch ${event.attempt}/${event.maxRetries} in ${Math.round(event.delayMs)} ms (${ctx.auth.mode === "vault" ? safeAwsError(event.error) : formatBedrockErrorMessage(event.error)})${ANSI.reset}`);
        },
        onReasoning: (text) => {
          if (!reasoningOpen) {
            process.stdout.write(`${ANSI.gray}[Reasoning]\n`);
            reasoningOpen = true;
          }
          process.stdout.write(sanitizeTerminalText(text));
        },
        onText: (text) => {
          if (reasoningOpen) {
            process.stdout.write(`${ANSI.reset}\n\n`);
            reasoningOpen = false;
          }
          lineBuffer += sanitizeTerminalText(text);

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
      }
    );

    // Offenen Reasoning-Block auch bei Fehler/Abbruch sauber schliessen.
    if (reasoningOpen) {
      process.stdout.write(`${ANSI.reset}\n`);
      reasoningOpen = false;
    }

    // Bereits gepufferte Teil-Zeile in jedem Fall ausgeben (auch bei Fehler/Abbruch).
    flushLineBuffer();

    if (requestError) {
      console.error(`\n${ANSI.yellow}API Fehler: ${ctx.auth.mode === "vault" ? safeAwsError(requestError) : formatBedrockErrorMessage(requestError)}${ANSI.reset}`);
      if (ctx.debugMode && ctx.auth.mode !== "vault") {
        printDebugLines("Debug Fehler", formatBedrockErrorDiagnostics(requestError, {
          model: ctx.currentModel,
          modelId: bedrockModelId,
          region: requestRegion,
          inferenceConfig: ctx.inferenceConfig
        }));
      } else {
        console.error(`${ANSI.gray}Debug: /debug einschalten oder mit --debug starten fuer Details.${ANSI.reset}`);
      }
      const accountMismatch = accountMismatchFromError(requestError);
      if (accountMismatch) {
        console.error(`${ANSI.yellow}Hinweis:${ANSI.reset} Das Inference Profile gehoert zu AWS-Konto ${accountMismatch.resourceAccount}, deine Identität nutzt aber Konto ${accountMismatch.callerAccount}. Setze profileArn auf dein eigenes Konto oder nutze die reine Inference-Profile-ID (z. B. ${ctx.currentModel.id}).`);
      } else if ((requestError.message || "").includes("bedrock:InvokeModelWithResponseStream")) {
        console.error(`${ANSI.yellow}Hinweis:${ANSI.reset} Die aktive AWS-Identität braucht bedrock:InvokeModelWithResponseStream für das gewählte Modell bzw. Inference Profile.`);
      }
    } else {
      if (aborted) {
        console.log(`\n${ANSI.gray}Antwort abgebrochen.${ANSI.reset}`);
      }

      // Der Verlauf speichert den sanitizierten Text (keine Terminal-Steuersequenzen).
      const responseText = sanitizeTerminalText(fullResponse);
      if (responseText) {
        ctx.messages = appendAssistantResponse(requestMessages, responseText, {
          aborted,
          maxTurns: ctx.maxTurns
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
  } finally {
    interrupter.signal.removeEventListener("abort", operation.cancel);
    interrupter.dispose();
  }
}

// Liest Prompts, verarbeitet Slash-Befehle und streamt Modellantworten bis zum Ende.
async function runChatLoop(ctx) {
  while (true) {
    const prompt = await readPrompt({ history: ctx.promptHistory, onActivity: () => ctx.auth.touch() });
    if (prompt === null) break;
    const input = prompt.trim();

    if (!input) continue;
    ctx.auth.touch();
    if (!input.startsWith("/auth")) rememberPrompt(ctx, input);

    const result = await handleCommand(input, ctx);
    if (result.signal === "break") break;
    if (result.signal === "handled") continue;

    let operation;
    try {
      if (ctx.auth.mode === "vault" && ctx.auth.status().locked) await manageAuth(ctx.auth, "unlock");
      operation = ctx.auth.begin();
      await ctx.auth.clientConfig();
      ctx.region = ctx.auth.region;
      await streamModelResponse(ctx, result.promptText, operation);
    } catch (err) { console.error(sanitizeTerminalText(err.message)); }
    finally { operation?.finish(); }
  }

  console.log(`\n${ANSI.gray}Chat beendet.${ANSI.reset}`);
}

export async function main() {
  let auth;
  let webStarted = false;
  try {
    const cliArgs = parseCliArgs();

    if (cliArgs.version) {
      console.log(`bedrock-chat ${getPackageVersion()}`);
      return;
    }

    // Eine nutzereigene ~/.config/bedrock-chat/models.json hat Vorrang vor der
    // mitgelieferten Datei (account-spezifische ARNs gehoeren nicht ins Paket).
    const modelsPath = resolveModelsPath(new URL("../models.json", import.meta.url));
    const models = loadModels(modelsPath);

    if (cliArgs.help) {
      printHelp(models);
      return;
    }

    if (cliArgs.profile === "-list" || cliArgs.profile === "--list" || cliArgs.profile === "list") {
      await printAwsProfiles();
      return;
    }

    auth = new AuthService({ mode: cliArgs.authSetup ? "vault" : cliArgs.auth, profile: cliArgs.profile, region: cliArgs.region });
    if (cliArgs.authSetup && !cliArgs.web) await manageAuth(auth, "setup");
    if (!cliArgs.web && auth.mode === "vault" && auth.status().exists && auth.status().locked) {
      try { await manageAuth(auth, "unlock"); }
      catch (err) { console.error(sanitizeTerminalText(err.message)); }
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

    const savedEffort = readSavedEffort();
    let startupEffort = savedEffort;

    if (!cliArgs.web && !cliArgs.model && !resumeModelId && !lastModelId && models.length > 1) {
      const selection = await promptForModelSelection(models, modelId, savedEffort);
      if (selection) {
        modelId = selection.model.id;
        startupEffort = selection.effort ?? startupEffort;
        tryPersist(() => writeLastModelId(modelId), "Modell speichern", startupDebugMode);
        if (selection.effort) {
          tryPersist(() => writeSavedEffort(selection.effort), "Effort speichern", startupDebugMode);
        }
      }
    }

    const currentModel = findModel(models, modelId) ?? activeModel;
    const effort = resolveEffortLevel(currentModel, startupEffort);
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
    // The GUI and /auth remain accessible with missing, expired or locked credentials.
    const startupContext = auth.status();

    const autoSaveEnabled = !cliArgs.noSave;

    // Gebuendelter, veraenderlicher Zustand der Chat-Sitzung.
    const ctx = {
      models,
      auth,
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
      effort,
      // Effort-Wunsch des Nutzers, unabhaengig davon, ob das aktuelle Modell
      // ihn unterstuetzt (analog zu preferredEffort im Web-Server).
      preferredEffort: effort ?? startupEffort,
      inferenceConfig,
      region: startupContext.region,
      identityLabel: startupContext.identityLabel,
      bedrockClient: null
    };

    auth.on("change", () => {
      ctx.bedrockClient = null;
      ctx.regionalBedrockClients?.clear();
      ctx.identityLabel = "";
    });
    process.on("SIGTERM", () => {
      auth.close();
      ctx.bedrockClient?.destroy?.();
      destroyRegionalBedrockClients(ctx);
      process.exit(0);
    });

    printStartupBanner({ model: ctx.currentModel, inferenceConfig: ctx.inferenceConfig, effort: ctx.effort });
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
      const { server, url, authToken } = await startWebServer({
        models,
        auth,
        model: ctx.currentModel,
        client: ctx.bedrockClient,
        inferenceOverrides: activeInferenceOverrides,
        systemPrompt: ctx.systemPrompt,
        region: ctx.region,
        identityLabel: ctx.auth.identityLabel,
        profile: ctx.auth.profile,
        maxTurns: cliArgs.maxTurns,
        autoSave: autoSaveEnabled,
        messages: ctx.messages,
        effort: ctx.effort,
        port: cliArgs.port ?? DEFAULT_WEB_PORT
      });
      webStarted = true;
      server.once("close", () => auth.close());
      let bootstrap = null;
      try {
        bootstrap = authToken ? createBrowserBootstrap(url, authToken) : null;
      } catch (err) {
        server.close();
        throw err;
      }

      const cleanupBootstrap = () => bootstrap?.cleanup();
      server.once("close", cleanupBootstrap);
      process.once("exit", cleanupBootstrap);

      console.log(`${ANSI.green}Web-GUI:${ANSI.reset} ${url}`);
      const launchTarget = bootstrap?.path || url;
      if (cliArgs.noOpen) {
        console.log(`${ANSI.green}Sichere Startdatei:${ANSI.reset} ${launchTarget}`);
      } else {
        const opened = openInBrowser(launchTarget);
        if (opened && bootstrap) {
          // Genug Zeit fuer einen langsamen Browserstart; danach liegt das
          // Token nicht mehr als Datei auf der Platte. cleanup ist idempotent.
          setTimeout(cleanupBootstrap, 30_000).unref();
        } else if (!opened) {
          console.log(`${ANSI.yellow}Browser konnte nicht geoeffnet werden.${ANSI.reset}`);
          console.log(`${ANSI.green}Sichere Startdatei:${ANSI.reset} ${launchTarget}`);
        }
      }
      console.log(`${ANSI.gray}Beenden mit Ctrl+C.${ANSI.reset}`);
      return;
    }

    await runChatLoop(ctx);
  } catch (err) {
    console.error(`\nFehler: ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (!webStarted) auth?.close();
  }
}
