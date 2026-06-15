export function parseCliArgs() {
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
