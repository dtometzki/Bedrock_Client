#!/usr/bin/env node

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import * as readline from "node:readline/promises";
import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  magenta: "\u001b[35m"
};

const RESPONSE_INDENT = "  ";

function terminalWidth() {
  return Math.max(40, Math.min(process.stdout.columns || 120, 180));
}

function terminalLine() {
  return `${ANSI.gray}${"-".repeat(terminalWidth())}${ANSI.reset}`;
}

function centerText(text, width = terminalWidth()) {
  const left = Math.max(0, Math.floor((width - text.length) / 2));
  return " ".repeat(left) + text;
}

function getPackageVersion() {
  try {
    const packageJsonPath = new URL("./package.json", import.meta.url);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return packageJson.version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

function formatHomePath(path) {
  const home = os.homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

function printStartupBanner({ model, region, identityLabel }) {
  const width = terminalWidth();
  const profile = process.env.AWS_PROFILE || "default";
  const modelLabel = model.label || model.id;

  console.log("");
  console.log(`${ANSI.bold}${centerText(`AWS Bedrock CLI ${getPackageVersion()}`, width)}${ANSI.reset}`);
  if (identityLabel) {
    console.log(centerText(identityLabel, width));
  }
  console.log(centerText(`${profile} (${region})`, width));
  console.log(centerText(modelLabel, width));
  console.log(centerText(formatHomePath(process.cwd()), width));
  console.log("");
  console.log(terminalLine());
}

function getActiveAwsProfile() {
  return process.env.AWS_PROFILE || "default";
}

// 1. AWS Credentials & Region loading
function getCommandErrorText(err) {
  return [err?.stdout, err?.stderr, err?.message]
    .filter(Boolean)
    .map((value) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value))
    .join("\n");
}

function isExpiredAwsSession(errorText) {
  return /session has expired|reauthenticate|token has expired|sso.*expired/i.test(errorText);
}

function awsLoginCommand() {
  const profile = getActiveAwsProfile();
  const loginProfile = getAwsConfigValue("source_profile", profile) || profile;
  return loginProfile === "default" ? "aws login" : `aws login --profile ${loginProfile}`;
}

function formatAwsIdentity(identity) {
  if (!identity) return "";

  const account = identity.Account ? `, ${identity.Account}` : "";
  const arn = identity.Arn || "";
  const assumedRoleMatch = arn.match(/:assumed-role\/([^/]+)\/(.+)$/);
  const userMatch = arn.match(/:user\/(.+)$/);

  if (assumedRoleMatch) {
    const [, role, sessionName] = assumedRoleMatch;
    return `${sessionName} (${role}${account})`;
  }
  if (userMatch) {
    return `${userMatch[1]} (IAM${account})`;
  }
  if (arn.endsWith(":root")) {
    return `root (${identity.Account})`;
  }

  return identity.UserId ? `${identity.UserId}${account}` : "";
}

function loadAwsIdentity() {
  try {
    const identityJson = execSync("aws sts get-caller-identity --output json", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return formatAwsIdentity(JSON.parse(identityJson));
  } catch (err) {
    const errorText = getCommandErrorText(err);
    if (isExpiredAwsSession(errorText)) {
      throw new Error(`AWS Session abgelaufen. Bitte neu anmelden:\n\n  ${awsLoginCommand()}`);
    }
    return "";
  }
}

function getAwsConfigValue(key, profile = null) {
  try {
    const args = ["configure", "get", key];
    if (profile) {
      args.push("--profile", profile);
    }
    return execFileSync("aws", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch {
    return "";
  }
}

function loadAwsCredentials() {
  const creds = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    sessionToken: process.env.AWS_SESSION_TOKEN || "",
    region: process.env.AWS_REGION || getAwsConfigValue("region") || "us-east-1"
  };

  if (!creds.accessKeyId || !creds.secretAccessKey) {
    try {
      const exportJson = execSync("aws configure export-credentials", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      const parsed = JSON.parse(exportJson);
      if (parsed.AccessKeyId && parsed.SecretAccessKey) {
        creds.accessKeyId = parsed.AccessKeyId;
        creds.secretAccessKey = parsed.SecretAccessKey;
        creds.sessionToken = parsed.SessionToken || "";
      }
    } catch (err) {
      const errorText = getCommandErrorText(err);
      if (isExpiredAwsSession(errorText)) {
        throw new Error(`AWS Session abgelaufen. Bitte neu anmelden:\n\n  ${awsLoginCommand()}`);
      }

      // Fallback
      creds.accessKeyId = creds.accessKeyId || getAwsConfigValue("aws_access_key_id");
      creds.secretAccessKey = creds.secretAccessKey || getAwsConfigValue("aws_secret_access_key");
      creds.sessionToken = creds.sessionToken || getAwsConfigValue("aws_session_token");
    }
  }

  if (!creds.accessKeyId || !creds.secretAccessKey) {
    throw new Error(`AWS Credentials nicht gefunden. Bitte anmelden oder konfigurieren:\n\n  ${awsLoginCommand()}\n  aws configure`);
  }
  return creds;
}

function loadAwsContext() {
  const creds = loadAwsCredentials();
  const identityLabel = loadAwsIdentity();
  return { creds, identityLabel, profile: getActiveAwsProfile() };
}

function listAwsProfiles() {
  try {
    return execSync("aws configure list-profiles", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    })
      .split("\n")
      .map((profile) => profile.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function formatProfileList(profiles) {
  if (!profiles.length) return "Keine AWS-Profile gefunden.";
  const activeProfile = getActiveAwsProfile();
  return profiles
    .map((profile) => profile === activeProfile ? `${profile} (aktiv)` : profile)
    .join(", ");
}

function printAwsProfiles() {
  console.log(formatProfileList(listAwsProfiles()));
}

function switchAwsProfile(profile) {
  const profiles = listAwsProfiles();
  if (profiles.length && !profiles.includes(profile)) {
    throw new Error(`AWS Profil nicht gefunden: ${profile}\nVerfuegbar: ${profiles.join(", ")}`);
  }

  if (profile === "default") {
    delete process.env.AWS_PROFILE;
  } else {
    process.env.AWS_PROFILE = profile;
  }

  return loadAwsContext();
}

// 2. Bedrock Runtime SDK
function createBedrockClient(creds) {
  return new BedrockRuntimeClient({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken || undefined
    }
  });
}

async function* streamConverse(client, { modelId, messages, system }) {
  const command = new ConverseStreamCommand({
    modelId,
    messages,
    inferenceConfig: { maxTokens: 2000, temperature: 0.7 },
    ...(system && { system: [{ text: system }] })
  });
  const response = await client.send(command);

  for await (const event of response.stream ?? []) {
    const text = event.contentBlockDelta?.delta?.text;
    if (text) {
      yield text;
    }
  }
}

// 3. CLI Argumente & Hilfsfunktionen
function parseCliArgs() {
  const args = process.argv.slice(2);
  const parsedArgs = { help: false, version: false, model: null, profile: null, system: "Du bist ein hilfreicher KI-Assistent." };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-h" || args[i] === "--help") parsedArgs.help = true;
    else if (args[i] === "-v" || args[i] === "--version") parsedArgs.version = true;
    else if (args[i] === "-m" || args[i] === "--model") parsedArgs.model = args[++i] || null;
    else if (args[i] === "-p" || args[i] === "--profile") parsedArgs.profile = args[++i] || null;
    else if (args[i] === "-s" || args[i] === "--system") parsedArgs.system = args[++i] || null;
  }
  return parsedArgs;
}

async function promptForModelSelection(models, currentModelId, rl) {
  console.log("");
  console.log(terminalLine());
  console.log(`${ANSI.bold}Modelle${ANSI.reset}`);
  models.forEach((m, i) => {
    const active = m.id === currentModelId ? ` ${ANSI.gray}(aktiv)${ANSI.reset}` : "";
    console.log(`${ANSI.gray}[${i + 1}]${ANSI.reset} ${m.label}${active}`);
  });
  console.log(terminalLine());

  const choice = await rl.question(`${ANSI.bold}>${ANSI.reset} `);
  const index = parseInt(choice.trim(), 10) - 1;
  return (index >= 0 && index < models.length) ? models[index] : null;
}

async function readPrompt(rl) {
  try {
    return await rl.question(`${ANSI.bold}>${ANSI.reset} `);
  } catch (err) {
    if (err?.code === "ERR_USE_AFTER_CLOSE" || /readline was closed/i.test(err?.message || "")) {
      return null;
    }
    throw err;
  }
}

let inCodeBlock = false;

function formatCodeLine(line) {
  return line ? `${RESPONSE_INDENT}${line}` : "";
}

function formatLine(line) {
  if (line.trim().startsWith("```")) {
    inCodeBlock = !inCodeBlock;
    return null;
  }

  if (inCodeBlock) {
    return formatCodeLine(line);
  }

  if (!line) {
    return "";
  }

  // Überschriften bleiben Markdown-nah, nur etwas kräftiger.
  if (line.match(/^(#{1,6})\s+(.+)$/)) {
    return `${RESPONSE_INDENT}${ANSI.bold}${line}${ANSI.reset}`;
  }

  // Einfache, dezente Trennlinie
  if (line === "---") {
    return `${RESPONSE_INDENT}${ANSI.gray}${"-".repeat(Math.min(72, terminalWidth() - RESPONSE_INDENT.length))}${ANSI.reset}`;
  }

  // Standard-Textformatierung (Fett und Inline-Code)
  return RESPONSE_INDENT + line
    .replace(/\*\*([^*]+)\*\*/g, `${ANSI.bold}$1${ANSI.reset}`)
    .replace(/`([^`]+)`/g, `${ANSI.cyan}$1${ANSI.reset}`);
}

// 4. Hauptprogramm & Converse API Stream
async function main() {
  try {
    const modelsPath = new URL("./models.json", import.meta.url);
    const models = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    const cliArgs = parseCliArgs();

    if (cliArgs.version) {
      console.log(`bedrock-chat ${getPackageVersion()}`);
      return;
    }

    if (cliArgs.help) {
      console.log(`${ANSI.bold}Verwendung:${ANSI.reset} bedrock-chat [Optionen]\n`);
      console.log("Optionen:");
      console.log("  -m, --model <name>  Modell beim Start setzen");
      console.log("  -p, --profile <name> AWS Profil beim Start setzen");
      console.log("  -p -list           AWS Profile anzeigen und beenden");
      console.log("  -s, --system <text> System Prompt setzen");
      console.log("  -v, --version      Version anzeigen");
      console.log("  -h, --help          Hilfe anzeigen\n");
      console.log("Commands:");
      console.log("  /profile            AWS Profile anzeigen");
      console.log("  /profile <name>     AWS Profil wechseln");
      console.log("  /model              Modell wechseln");
      console.log("  /clear              Verlauf leeren");
      console.log("  /exit               Beenden\n");
      console.log("Modelle:");
      models.forEach((m) => console.log(`  - ${m.label} (${m.id})`));
      return;
    }

    if (cliArgs.profile === "-list" || cliArgs.profile === "--list" || cliArgs.profile === "list") {
      printAwsProfiles();
      return;
    }

    if (cliArgs.profile) {
      switchAwsProfile(cliArgs.profile);
    }

    let { creds, identityLabel } = loadAwsContext();
    let bedrockClient = createBedrockClient(creds);
    const lastModelPath = new URL("./.last_model", import.meta.url);
    let lastModelId = "";
    try {
      if (fs.existsSync(lastModelPath)) {
        lastModelId = fs.readFileSync(lastModelPath, "utf8").trim();
      }
    } catch {}

    const defaultModel = models.find(m => m.id === lastModelId) ?? models[0];
    const activeModel = models.find(m => m.id === cliArgs.model || m.label === cliArgs.model) ?? defaultModel;
    let modelId = activeModel.id;

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    if (!cliArgs.model && !lastModelId && models.length > 1) {
      const selected = await promptForModelSelection(models, modelId, rl);
      if (selected) {
        modelId = selected.id;
        try {
          fs.writeFileSync(lastModelPath, modelId, "utf8");
        } catch {}
      }
    }

    let currentModel = models.find(m => m.id === modelId) ?? activeModel;
    printStartupBanner({ model: currentModel, region: creds.region, identityLabel });

    let messages = [];

    while (true) {
      const prompt = await readPrompt(rl);
      if (prompt === null) break;
      const input = prompt.trim();

      if (!input) continue;
      if (input === "/exit") break;
      if (input === "/clear") {
        messages = [];
        console.log(`${ANSI.gray}Verlauf geleert.${ANSI.reset}`);
        console.log(terminalLine());
        continue;
      }
      if (input === "/profile" || input.startsWith("/profile ")) {
        const requestedProfile = input.slice("/profile".length).trim();
        if (!requestedProfile) {
          console.log(`${ANSI.green}AWS Profile:${ANSI.reset} ${formatProfileList(listAwsProfiles())}`);
          console.log(`${ANSI.green}Aktiv:${ANSI.reset} ${identityLabel || getActiveAwsProfile()}`);
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
        const selected = await promptForModelSelection(models, modelId, rl);
        if (selected) {
          modelId = selected.id;
          currentModel = selected;
          try {
            fs.writeFileSync(lastModelPath, modelId, "utf8");
          } catch {}
          console.log(`${ANSI.green}Modell:${ANSI.reset} ${currentModel.label || modelId}`);
          console.log(terminalLine());
        }
        continue;
      }

      messages.push({ role: "user", content: [{ text: input }] });
      process.stdout.write("\n");

      try {
        inCodeBlock = false;
        let fullResponse = "";
        let lineBuffer = "";

        for await (const text of streamConverse(bedrockClient, {
          modelId,
          messages,
          system: cliArgs.system
        })) {
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

        messages.push({ role: "assistant", content: [{ text: fullResponse }] });
      } catch (err) {
        messages.pop(); // Letzte User-Nachricht bei Fehler entfernen
        console.error(`\n${ANSI.yellow}API Fehler: ${err.message}${ANSI.reset}`);
        if (err.message.includes("bedrock:InvokeModelWithResponseStream")) {
          console.error(`${ANSI.yellow}Hinweis:${ANSI.reset} Die aktive AWS-Identität braucht bedrock:InvokeModelWithResponseStream für das gewählte Modell bzw. Inference Profile.`);
        }
      }
      process.stdout.write(ANSI.reset);
      console.log("");
    }

    rl.close();
    console.log(`\n${ANSI.gray}Chat beendet.${ANSI.reset}`);
  } catch (err) {
    console.error(`\nFehler: ${err.message}`);
  }
}

main();
