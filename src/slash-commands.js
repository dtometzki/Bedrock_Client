import { ANSI, terminalLine } from "./ui.js";

export const SLASH_COMMANDS = [
  { name: "/", description: "Befehlsliste anzeigen" },
  { name: "/help", description: "Befehlsliste anzeigen" },
  { name: "/profile", description: "AWS Profile anzeigen" },
  { name: "/profile <name>", completion: "/profile", description: "AWS Profil wechseln" },
  { name: "/model", description: "Modell wechseln" },
  { name: "/usage", description: "AWS Billing und Session-Nutzung anzeigen" },
  { name: "/clear", description: "Verlauf leeren" },
  { name: "/exit", description: "Beenden" }
];

export function getSlashCommandCompletions() {
  return [...new Set(SLASH_COMMANDS.map((command) => command.completion || command.name))]
    .filter((name) => name !== "/");
}

export function completeSlashCommand(line) {
  if (!line.startsWith("/")) {
    return [[], line];
  }

  const commandNames = getSlashCommandCompletions();
  const hits = commandNames.filter((command) => command.startsWith(line));
  return [hits.length ? hits : commandNames, line];
}

function commandMatchesFilter(command, normalizedFilter) {
  if (!normalizedFilter || normalizedFilter === "/") return true;
  if (command.name.toLowerCase().startsWith(normalizedFilter)) return true;
  return Boolean(command.completion && normalizedFilter.startsWith(`${command.completion.toLowerCase()} `));
}

export function getMatchingSlashCommands(filter = "") {
  const normalizedFilter = filter.toLowerCase();
  return SLASH_COMMANDS.filter((command) => commandMatchesFilter(command, normalizedFilter));
}

export function getVisibleSlashCommands(filter = "") {
  const visibleCommands = getMatchingSlashCommands(filter);
  return visibleCommands.length ? visibleCommands : SLASH_COMMANDS;
}

export function getSlashCommandInsertText(command) {
  if (command.completion) return `${command.completion} `;
  return command.name.replace(/\s+<[^>]+>/g, " ");
}

export function isCompleteSlashCommand(command) {
  return !command.name.includes("<");
}

export function formatSlashCommandLines(filter = "", selectedIndex = -1) {
  const commands = getVisibleSlashCommands(filter);
  const nameWidth = Math.max(...commands.map((command) => command.name.length));

  const lines = [terminalLine()];
  commands.forEach((command, index) => {
    const marker = index === selectedIndex ? ">" : " ";
    if (index === selectedIndex) {
      lines.push(`${ANSI.inverse}${marker} ${command.name.padEnd(nameWidth)}  ${command.description}${ANSI.reset}`);
      return;
    }
    lines.push(`${marker} ${ANSI.cyan}${command.name.padEnd(nameWidth)}${ANSI.reset}  ${command.description}`);
  });
  lines.push(`${ANSI.gray}Pfeile waehlen, Enter uebernimmt, Tab vervollstaendigt.${ANSI.reset}`);
  lines.push(terminalLine());
  return lines;
}

export function printSlashCommands(filter = "") {
  console.log(formatSlashCommandLines(filter).join("\n"));
}
