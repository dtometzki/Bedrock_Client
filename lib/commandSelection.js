import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { ANSI } from "./ansi.js";
import { askStyledQuestion } from "./prompts.js";

const COMMANDS = [
  { command: "/model", description: "Modell wechseln" },
  { command: "/clear", description: "Chat-Verlauf löschen" },
  { command: "/exit", description: "Chat beenden" }
];

function buildCommandSelectionLines(selectedIndex) {
  const lines = ["Verfügbare Befehle:"];

  COMMANDS.forEach((item, index) => {
    const pointer = index === selectedIndex ? `${ANSI.cyan}>${ANSI.reset}` : " ";
    lines.push(`${pointer} ${item.command} ${ANSI.gray}- ${item.description}${ANSI.reset}`);
  });

  lines.push("");
  lines.push(
    `${ANSI.gray}Pfeiltasten zum Wählen, Enter zum Bestätigen, Esc zum Abbrechen.${ANSI.reset}`
  );
  return lines;
}

async function promptForCommandSelectionInteractive() {
  emitKeypressEvents(input);

  let selectedIndex = 0;
  let renderedLineCount = 0;

  const render = () => {
    const lines = buildCommandSelectionLines(selectedIndex);
    if (renderedLineCount > 0) {
      output.write(`\u001b[${renderedLineCount}A\u001b[0J`);
    }
    output.write(`${lines.join("\n")}\n`);
    renderedLineCount = lines.length;
  };

  return new Promise((resolve) => {
    const previousRawMode = input.isRaw;

    const cleanup = (result) => {
      input.off("keypress", handleKeypress);
      input.setRawMode(previousRawMode ?? false);
      output.write(`\u001b[${renderedLineCount}A\u001b[0J`);
      resolve(result);
    };

    const handleKeypress = (_, key) => {
      if (!key) return;

      if (key.name === "up") {
        selectedIndex = selectedIndex === 0 ? COMMANDS.length - 1 : selectedIndex - 1;
        render();
        return;
      }

      if (key.name === "down") {
        selectedIndex = selectedIndex === COMMANDS.length - 1 ? 0 : selectedIndex + 1;
        render();
        return;
      }

      if (key.name === "return") {
        cleanup(COMMANDS[selectedIndex]);
        return;
      }

      if (key.name === "escape") {
        cleanup(null);
        return;
      }

      if (key.ctrl && key.name === "c") {
        cleanup(null);
      }
    };

    input.setRawMode(true);
    input.on("keypress", handleKeypress);
    render();
  });
}

export async function promptForCommandSelection(rl) {
  if (input.isTTY && typeof input.setRawMode === "function") {
    return promptForCommandSelectionInteractive();
  }

  console.log("Verfügbare Befehle:");
  COMMANDS.forEach((item, index) => {
    console.log(`[${index + 1}] ${item.command} - ${item.description}`);
  });

  const choice = await askStyledQuestion(rl, "Befehl wählen (1-3, Enter zum Abbrechen)");
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
