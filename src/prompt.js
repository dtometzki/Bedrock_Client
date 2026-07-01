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

function isCurrentModel(model, currentModelId) {
  return model.id === currentModelId ||
    model.profileArn === currentModelId ||
    model.inferenceProfileArn === currentModelId ||
    model.aliases?.includes(currentModelId);
}

function getInitialModelSelectionIndex(models, currentModelId) {
  const index = models.findIndex((model) => isCurrentModel(model, currentModelId));
  return index >= 0 ? index : 0;
}

export function formatModelSelectionLines(models, currentModelId, selectedIndex = -1) {
  const lines = [terminalLine(), `${ANSI.bold}Modelle${ANSI.reset}`];

  models.forEach((model, index) => {
    const marker = index === selectedIndex ? ">" : " ";
    const number = `[${index + 1}]`;
    const active = isCurrentModel(model, currentModelId) ? " (aktiv)" : "";
    const line = `${marker} ${number} ${model.label}${active}`;

    if (index === selectedIndex) {
      lines.push(`${ANSI.inverse}${line}${ANSI.reset}`);
      return;
    }

    lines.push(`${marker} ${ANSI.gray}${number}${ANSI.reset} ${model.label}${active}`);
  });

  lines.push(`${ANSI.gray}Pfeile waehlen, Enter uebernimmt.${ANSI.reset}`);
  lines.push(terminalLine());
  return lines;
}

async function promptForModelSelectionByNumber(models, currentModelId) {
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
  console.log("");
  console.log(formatModelSelectionLines(models, currentModelId).join("\n"));

  const choice = await rl.question(`${ANSI.bold}>${ANSI.reset} `);
  rl.close();
  const index = parseInt(choice.trim(), 10) - 1;
  return (index >= 0 && index < models.length) ? models[index] : null;
}

export async function promptForModelSelection(models, currentModelId) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return await promptForModelSelectionByNumber(models, currentModelId);
  }

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return await new Promise((resolve) => {
    let selectedIndex = getInitialModelSelectionIndex(models, currentModelId);
    let renderedLineCount = 0;
    let done = false;

    process.stdout.write("\n");

    function render() {
      if (renderedLineCount) {
        process.stdout.write(`[${renderedLineCount}A`);
        process.stdout.write("\r[0J");
      }

      const lines = formatModelSelectionLines(models, currentModelId, selectedIndex);
      process.stdout.write(`${lines.join("\n")}\n`);
      renderedLineCount = lines.length;
    }

    function cleanup(value) {
      if (done) return;
      done = true;
      process.stdin.off("keypress", onKeypress);
      if (!wasRaw) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      resolve(value);
    }

    function moveSelection(delta) {
      selectedIndex = (selectedIndex + delta + models.length) % models.length;
      render();
    }

    function onKeypress(str, key = {}) {
      if (key.ctrl && key.name === "c") {
        cleanup(null);
        return;
      }
      if (key.name === "escape") {
        cleanup(null);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup(models[selectedIndex]);
        return;
      }
      if (key.name === "up") {
        moveSelection(-1);
        return;
      }
      if (key.name === "down" || key.name === "tab") {
        moveSelection(1);
        return;
      }
      if (key.name === "home") {
        selectedIndex = 0;
        render();
        return;
      }
      if (key.name === "end") {
        selectedIndex = models.length - 1;
        render();
        return;
      }
      if (/^[1-9]$/.test(str || "")) {
        const index = Number(str) - 1;
        if (index < models.length) {
          selectedIndex = index;
          render();
        }
      }
    }

    process.stdin.on("keypress", onKeypress);
    render();
  });
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

export async function readPrompt({ history = [] } = {}) {
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
    let cursor = 0;
    let selectedSlashIndex = 0;
    let done = false;

    let historyIndex = history.length;
    let historyDraft = "";

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
      process.stdout.write("\r[0J");
      process.stdout.write(`${promptText}${line}`);
      if (suggestions.length) {
        process.stdout.write(`\n${suggestions.join("\n")}`);
        process.stdout.write(`[${suggestions.length}A`);
      }
      process.stdout.write("\r");
      const column = promptVisibleColumns + cursor;
      if (column > 0) {
        process.stdout.write(`[${column}C`);
      }
    }

    function replaceLine(nextLine, nextCursor = nextLine.length) {
      line = nextLine;
      cursor = Math.max(0, Math.min(nextCursor, nextLine.length));
      selectedSlashIndex = 0;
    }

    function insertText(text) {
      line = line.slice(0, cursor) + text + line.slice(cursor);
      cursor += text.length;
      selectedSlashIndex = 0;
    }

    function recallHistory(delta) {
      if (!history.length) return;
      if (delta < 0) {
        if (historyIndex === 0) return;
        if (historyIndex === history.length) {
          historyDraft = line;
        }
        historyIndex -= 1;
      } else {
        if (historyIndex >= history.length) return;
        historyIndex += 1;
      }
      const nextLine = historyIndex >= history.length ? historyDraft : history[historyIndex];
      replaceLine(nextLine);
      render();
    }

    function cleanup(value) {
      if (done) return;
      done = true;
      process.stdin.off("keypress", onKeypress);
      process.stdout.write("\r[0J");
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

      const insert = getSlashCommandInsertText(command);
      if (submit && !isCompleteSlashCommand(command) && line.length > insert.length) {
        cleanup(line);
        return true;
      }

      replaceLine(insert);
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
        if (cursor > 0) {
          line = line.slice(0, cursor - 1) + line.slice(cursor);
          cursor -= 1;
          selectedSlashIndex = 0;
        }
        render();
        return;
      }
      if (key.name === "delete") {
        if (cursor < line.length) {
          line = line.slice(0, cursor) + line.slice(cursor + 1);
          selectedSlashIndex = 0;
        }
        render();
        return;
      }
      if (key.name === "left") {
        cursor = Math.max(0, cursor - 1);
        render();
        return;
      }
      if (key.name === "right") {
        cursor = Math.min(line.length, cursor + 1);
        render();
        return;
      }
      if (key.name === "home" || (key.ctrl && key.name === "a")) {
        cursor = 0;
        render();
        return;
      }
      if (key.name === "end" || (key.ctrl && key.name === "e")) {
        cursor = line.length;
        render();
        return;
      }
      if (key.name === "up") {
        if (line.startsWith("/")) {
          moveSlashSelection(-1);
        } else {
          recallHistory(-1);
        }
        return;
      }
      if (key.name === "down") {
        if (line.startsWith("/")) {
          moveSlashSelection(1);
        } else {
          recallHistory(1);
        }
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
        insertText(str);
        render();
      }
    }

    process.stdin.on("keypress", onKeypress);
    render();
  });
}

export function createStreamInterruptController() {
  const controller = new AbortController();

  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return { signal: controller.signal, dispose() {} };
  }

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  function onKeypress(str, key = {}) {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      controller.abort();
    }
  }

  process.stdin.on("keypress", onKeypress);

  return {
    signal: controller.signal,
    dispose() {
      process.stdin.off("keypress", onKeypress);
      if (!wasRaw) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    }
  };
}
