import { askStyledQuestion } from "./prompts.js";

const COMMANDS = [
  { command: "/help", description: "Befehlsübersicht anzeigen" },
  { command: "/models", description: "Modelle anzeigen" },
  { command: "/stats", description: "Chat-Statistik anzeigen" },
  { command: "/model", description: "Modell wechseln" },
  { command: "/export", description: "Chat exportieren" },
  { command: "/clear", description: "Chat-Verlauf löschen" },
  { command: "/exit", description: "Chat beenden" }
];

export async function promptForCommandSelection() {
  console.log("Verfügbare Befehle:");
  COMMANDS.forEach((item, index) => {
    console.log(`[${index + 1}] ${item.command} - ${item.description}`);
  });

  const choice = await askStyledQuestion(`Befehl wählen (1-${COMMANDS.length}, Enter zum Abbrechen)`);
  const trimmedChoice = choice.trim();

  if (!trimmedChoice) {
    return null;
  }

  const selectedIndex = parseInt(trimmedChoice, 10) - 1;
  if (selectedIndex >= 0 && selectedIndex < COMMANDS.length) {
    return COMMANDS[selectedIndex];
  }

  console.log("\n[System: Ungültige Befehlsauswahl.]\n");
  return null;
}
