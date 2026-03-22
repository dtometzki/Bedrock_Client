import path from "node:path";

/**
 * Gets the command name of the current process.
 * @returns {string} The command name.
 */
export function getCommandName() {
  const scriptPath = process.argv[1];
  return scriptPath ? path.basename(scriptPath) : "bedrock-chat";
}

/**
 * Parses command line arguments.
 * @returns {{help: boolean, model: string|null, system: string|null}} Parsed arguments.
 */
export function parseCliArgs() {
  const args = process.argv.slice(2);
  const parsedArgs = {
    help: false,
    model: null,
    system: "Du bist ein hilfreicher und präziser KI-Assistent."
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      parsedArgs.help = true;
      continue;
    }

    if (arg === "-m" || arg === "--model") {
      parsedArgs.model = args[index + 1]?.trim() || null;
      index += 1;
      continue;
    }

    if (arg === "-s" || arg === "--system") {
      parsedArgs.system = args[index + 1]?.trim() || null;
      index += 1;
      continue;
    }
  }

  return parsedArgs;
}

/**
 * Prints the help menu to the console.
 * @param {Array<{id: string, label: string}>} models List of available models.
 */
export function printHelp(models) {
  const commandName = getCommandName();
  console.log(`Verwendung: ${commandName} [Optionen]\n`);
  console.log("Optionen:");
  console.log("  -m, --model <name>  Modell beim Start direkt setzen");
  console.log("  -s, --system <text> System Prompt initial setzen");
  console.log("  -h, --help          Diese Hilfe anzeigen\n");
  console.log("Verfügbare Modelle:");
  models.forEach((model) => {
    console.log(`  - ${model.label} (${model.id})`);
  });
}
