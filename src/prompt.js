import readline from "node:readline";
import * as readlinePromises from "node:readline/promises";
import { ANSI, terminalLine } from "./ui.js";
import {
  completeSlashCommand,
  formatSlashCommandLines,
  getMatchingSlashCommands,
  getSlashCommandInsertText,
  getVisibleSlashCommands,
  isCompleteSlashCommand
} from "./slash-commands.js";

export async function promptForModelSelection(models, currentModelId) {
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
  console.log("");
  console.log(terminalLine());
  console.log(`${ANSI.bold}Modelle${ANSI.reset}`);
  models.forEach((m, i) => {
    const active = m.id === currentModelId ? ` ${ANSI.gray}(aktiv)${ANSI.reset}` : "";
    console.log(`${ANSI.gray}[${i + 1}]${ANSI.reset} ${m.label}${active}`);
  });
  console.log(terminalLine());

  const choice = await rl.question(`${ANSI.bold}>${ANSI.reset} `);
  rl.close();
  const index = parseInt(choice.trim(), 10) - 1;
  return (index >= 0 && index < models.length) ? models[index] : null;
}

function longestCommonPrefix(values) {
  if (!values.length) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix) && prefix) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

export async function readPrompt() {
  if (!process.stdin.isTTY) {
    const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(`${ANSI.bold}>${ANSI.reset} `);
    } finally {
      rl.close();
    }
  }

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return await new Promise((resolve) => {
    let line = "";
    let selectedSlashIndex = 0;
    let done = false;

    const promptVisibleColumns = 2;
    const promptText = `${ANSI.bold}>${ANSI.reset} `;

    function slashSuggestionLines() {
      return line.startsWith("/") ? formatSlashCommandLines(line, selectedSlashIndex) : [];
    }

    function visibleSlashCommands() {
      return line.startsWith("/") ? getVisibleSlashCommands(line) : [];
    }

    function clampSlashSelection() {
      const commands = visibleSlashCommands();
      if (!commands.length) {
        selectedSlashIndex = 0;
        return;
      }
      selectedSlashIndex = Math.max(0, Math.min(selectedSlashIndex, commands.length - 1));
    }

    function render() {
      clampSlashSelection();
      const suggestions = slashSuggestionLines();
      process.stdout.write("\r\u001b[0J");
      process.stdout.write(`${promptText}${line}`);
      if (suggestions.length) {
        process.stdout.write(`\n${suggestions.join("\n")}`);
        process.stdout.write(`\u001b[${suggestions.length}A`);
        process.stdout.write(`\r\u001b[${promptVisibleColumns + line.length}C`);
      }
    }

    function replaceLine(nextLine) {
      line = nextLine;
      selectedSlashIndex = 0;
    }

    function cleanup(value) {
      if (done) return;
      done = true;
      process.stdin.off("keypress", onKeypress);
      process.stdout.write("\r\u001b[0J");
      if (value !== null) {
        process.stdout.write(`${promptText}${line}\n`);
      }
      if (!wasRaw) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      resolve(value);
    }

    function applyCompletion() {
      if (!line.startsWith("/")) return;
      const [hits] = completeSlashCommand(line);
      if (hits.length === 1) {
        replaceLine(hits[0]);
        return;
      }

      const prefix = longestCommonPrefix(hits);
      if (prefix.length > line.length) {
        replaceLine(prefix);
        return;
      }

      const commands = visibleSlashCommands();
      if (commands[selectedSlashIndex]) {
        replaceLine(getSlashCommandInsertText(commands[selectedSlashIndex]));
      }
    }

    function applySlashSelection({ submit = false } = {}) {
      if (!getMatchingSlashCommands(line).length) return false;

      const commands = visibleSlashCommands();
      const command = commands[selectedSlashIndex];
      if (!command) return false;

      const insertText = getSlashCommandInsertText(command);
      if (submit && !isCompleteSlashCommand(command) && line.length > insertText.length) {
        cleanup(line);
        return true;
      }

      replaceLine(insertText);
      if (submit && isCompleteSlashCommand(command)) {
        cleanup(line);
      } else {
        render();
      }
      return true;
    }

    function moveSlashSelection(delta) {
      const commands = visibleSlashCommands();
      if (!commands.length) return false;
      selectedSlashIndex = (selectedSlashIndex + delta + commands.length) % commands.length;
      render();
      return true;
    }

    function onKeypress(str, key = {}) {
      if (key.ctrl && key.name === "c") {
        cleanup(null);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        if (line.startsWith("/") && applySlashSelection({ submit: true })) {
          return;
        }
        cleanup(line);
        return;
      }
      if (key.name === "backspace") {
        replaceLine(line.slice(0, -1));
        render();
        return;
      }
      if (key.name === "up" && line.startsWith("/")) {
        moveSlashSelection(-1);
        return;
      }
      if (key.name === "down" && line.startsWith("/")) {
        moveSlashSelection(1);
        return;
      }
      if (key.name === "tab") {
        if (line.startsWith("/")) {
          const beforeCompletion = line;
          applyCompletion();
          if (beforeCompletion === line) {
            applySlashSelection();
            return;
          }
        }
        render();
        return;
      }
      if (key.ctrl && key.name === "u") {
        replaceLine("");
        render();
        return;
      }
      if (str && !key.ctrl && !key.meta && str >= " ") {
        replaceLine(line + str);
        render();
      }
    }

    process.stdin.on("keypress", onKeypress);
    render();
  });
}
