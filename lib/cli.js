import path from "node:path";

export function getCommandName() {
  const scriptPath = process.argv[1];
  return scriptPath ? path.basename(scriptPath) : "bedrock-chat";
}

export function parseCliArgs() {
  const args = process.argv.slice(2);
  const parsedArgs = {
    help: false,
    model: null
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
    }
  }

  return parsedArgs;
}

export function printHelp(models) {
  const commandName = getCommandName();
  console.log(`Verwendung: ${commandName} [Optionen]\n`);
  console.log("Optionen:");
  console.log("  -m, --model <name>  Modell beim Start direkt setzen");
  console.log("  -h, --help          Diese Hilfe anzeigen\n");
  console.log("Verfügbare Modelle:");
  models.forEach((model) => {
    console.log(`  - ${model.label} (${model.id})`);
  });
}
