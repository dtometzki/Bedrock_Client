import fs from "node:fs";
import { ANSI, formatInteger, formatUsd, getPackageVersion, printStartupBanner, terminalLine } from "./ui.js";
import { SLASH_COMMANDS, printSlashCommands } from "./slash-commands.js";
import { parseCliArgs } from "./cli-args.js";
import {
  formatProfileList,
  listAwsProfiles,
  loadAwsContext,
  printAwsProfiles,
  switchAwsProfile
} from "./aws-context.js";
import { createBedrockClient, streamConverse } from "./bedrock.js";
import { promptForModelSelection, readPrompt } from "./prompt.js";
import { formatLine, resetResponseFormatting } from "./response-format.js";
import { addUsageRecord, emptyUsageTotals, printUsageSummary } from "./usage.js";

export async function main() {
  try {
    const modelsPath = new URL("../models.json", import.meta.url);
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

    if (cliArgs.profile) {
      switchAwsProfile(cliArgs.profile);
    }

    let { creds, identityLabel } = loadAwsContext();
    let bedrockClient = createBedrockClient(creds);
    const lastModelPath = new URL("../.last_model", import.meta.url);
    let lastModelId = "";
    try {
      if (fs.existsSync(lastModelPath)) {
        lastModelId = fs.readFileSync(lastModelPath, "utf8").trim();
      }
    } catch {}

    const defaultModel = models.find(m => m.id === lastModelId) ?? models[0];
    const activeModel = models.find(m => m.id === cliArgs.model || m.label === cliArgs.model) ?? defaultModel;
    let modelId = activeModel.id;

    if (!cliArgs.model && !lastModelId && models.length > 1) {
      const selected = await promptForModelSelection(models, modelId);
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
      if (input === "/usage") {
        printUsageSummary(usageTotals);
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
          try {
            fs.writeFileSync(lastModelPath, modelId, "utf8");
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

      messages.push({ role: "user", content: [{ text: input }] });
      process.stdout.write("\n");

      try {
        resetResponseFormatting();
        let fullResponse = "";
        let lineBuffer = "";
        let usageRecord = null;

        for await (const event of streamConverse(bedrockClient, {
          modelId,
          messages,
          system: cliArgs.system
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

        messages.push({ role: "assistant", content: [{ text: fullResponse }] });
        if (usageRecord) {
          console.log("");
          console.log(`${ANSI.gray}${formatInteger(usageRecord.totalTokens)} Tokens, Session-Schaetzung ${formatUsd(usageRecord.costUsd)}${ANSI.reset}`);
        }
      } catch (err) {
        messages.pop();
        console.error(`\n${ANSI.yellow}API Fehler: ${err.message}${ANSI.reset}`);
        if (err.message.includes("bedrock:InvokeModelWithResponseStream")) {
          console.error(`${ANSI.yellow}Hinweis:${ANSI.reset} Die aktive AWS-Identität braucht bedrock:InvokeModelWithResponseStream für das gewählte Modell bzw. Inference Profile.`);
        }
      }
      process.stdout.write(ANSI.reset);
      console.log("");
    }

    console.log(`\n${ANSI.gray}Chat beendet.${ANSI.reset}`);
  } catch (err) {
    console.error(`\nFehler: ${err.message}`);
  }
}
