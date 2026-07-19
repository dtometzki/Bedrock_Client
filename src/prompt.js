import readline from "node:readline";
import * as readlinePromises from "node:readline/promises";
import { ANSI, formatEffortLabel, terminalLine } from "./ui.js";
import { modelMatches, normalizeEffort, resolveEffortLevel } from "./models.js";
import {
  completeSlashCommand,
  formatSlashCommandLines,
  getMatchingSlashCommands,
  getSlashCommandInsertText,
  getVisibleSlashCommands,
  isCompleteSlashCommand
} from "./slash-commands.js";

function getInitialModelSelectionIndex(models, currentModelId) {
  const index = models.findIndex((model) => modelMatches(model, currentModelId));
  return index >= 0 ? index : 0;
}

// Baut die Effort-Zeile fuer das aktuell markierte Modell. Liefert null, wenn
// das Modell kein Effort Level unterstuetzt.
function formatEffortSelectionLine(model, selectedEffort) {
  const config = normalizeEffort(model);
  if (!config) return null;

  const level = config.levels.includes(selectedEffort) ? selectedEffort : config.default;
  const options = config.levels
    .map((lvl) => {
      const label = formatEffortLabel(lvl);
      return lvl === level ? `${ANSI.inverse} ${label} ${ANSI.reset}` : `${ANSI.gray}${label}${ANSI.reset}`;
    })
    .join("  ");
  return `${ANSI.bold}Effort${ANSI.reset}  ${options}`;
}

export function formatModelSelectionLines(models, currentModelId, selectedIndex = -1, selectedEffort = null) {
  const lines = [terminalLine(), `${ANSI.bold}Modelle${ANSI.reset}`];

  models.forEach((model, index) => {
    const marker = index === selectedIndex ? ">" : " ";
    const number = `[${index + 1}]`;
    const active = modelMatches(model, currentModelId) ? " (aktiv)" : "";
    const line = `${marker} ${number} ${model.label}${active}`;

    if (index === selectedIndex) {
      lines.push(`${ANSI.inverse}${line}${ANSI.reset}`);
      return;
    }

    lines.push(`${marker} ${ANSI.gray}${number}${ANSI.reset} ${model.label}${active}`);
  });

  const effortLine = formatEffortSelectionLine(models[selectedIndex], selectedEffort);
  if (effortLine) {
    lines.push(effortLine);
    lines.push(`${ANSI.gray}Pfeile waehlen, Pfeil links/rechts Effort, Enter uebernimmt.${ANSI.reset}`);
  } else {
    lines.push(`${ANSI.gray}Pfeile waehlen, Enter uebernimmt.${ANSI.reset}`);
  }
  lines.push(terminalLine());
  return lines;
}

async function promptForModelSelectionByNumber(models, currentModelId, preferredEffort = null) {
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
  console.log("");
  console.log(formatModelSelectionLines(models, currentModelId).join("\n"));

  const choice = await rl.question(`${ANSI.bold}>${ANSI.reset} `);
  rl.close();
  const index = parseInt(choice.trim(), 10) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= models.length) return null;
  const model = models[index];
  return { model, effort: resolveEffortLevel(model, preferredEffort) };
}

export async function promptForModelSelection(models, currentModelId, preferredEffort = null) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return await promptForModelSelectionByNumber(models, currentModelId, preferredEffort);
  }

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return await new Promise((resolve) => {
    let selectedIndex = getInitialModelSelectionIndex(models, currentModelId);
    // Merkt sich den Effort-Wunsch ueber Modellwechsel hinweg (sticky), faellt
    // aber je Modell auf einen gueltigen Wert bzw. den Default zurueck.
    let preferred = preferredEffort;
    let selectedEffort = resolveEffortLevel(models[selectedIndex], preferred);
    let renderedLineCount = 0;
    let done = false;

    process.stdout.write("\n");

    function render() {
      if (renderedLineCount) {
        process.stdout.write(`\u001b[${renderedLineCount}A`);
        process.stdout.write("\r\u001b[0J");
      }

      const lines = formatModelSelectionLines(models, currentModelId, selectedIndex, selectedEffort);
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

    function setSelection(index) {
      selectedIndex = index;
      selectedEffort = resolveEffortLevel(models[selectedIndex], preferred);
      render();
    }

    function moveSelection(delta) {
      setSelection((selectedIndex + delta + models.length) % models.length);
    }

    function changeEffort(delta) {
      const config = normalizeEffort(models[selectedIndex]);
      if (!config) return;
      const current = config.levels.includes(selectedEffort) ? selectedEffort : config.default;
      const nextIndex = (config.levels.indexOf(current) + delta + config.levels.length) % config.levels.length;
      selectedEffort = config.levels[nextIndex];
      preferred = selectedEffort;
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
        cleanup({ model: models[selectedIndex], effort: selectedEffort });
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
      if (key.name === "left") {
        changeEffort(-1);
        return;
      }
      if (key.name === "right") {
        changeEffort(1);
        return;
      }
      if (key.name === "home") {
        setSelection(0);
        return;
      }
      if (key.name === "end") {
        setSelection(models.length - 1);
        return;
      }
      if (/^[1-9]$/.test(str || "")) {
        const index = Number(str) - 1;
        if (index < models.length) {
          setSelection(index);
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

// Bracketed-Paste-Steuersequenzen: Das Terminal rahmt eingefuegten Text mit
// ESC[200~ / ESC[201~ ein (Node meldet sie als key.name "paste-start"/"paste-end").
// So laesst sich mehrzeiliges Einfuegen von echten Enter-Tastendruecken
// unterscheiden und loest kein vorzeitiges Absenden aus.
const BRACKETED_PASTE_ON = "\u001b[?2004h";
const BRACKETED_PASTE_OFF = "\u001b[?2004l";

// Hinweis/Grenze: Die Cursor-Arithmetik zaehlt UTF-16-Code-Units, nicht
// Terminalspalten. Bei Emoji oder ostasiatischen Breitzeichen kann die
// Cursorposition daher optisch verrutschen; der eingegebene Text selbst
// bleibt korrekt.
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
  process.stdout.write(BRACKETED_PASTE_ON);

  return await new Promise((resolve) => {
    let line = "";
    let cursor = 0;
    let selectedSlashIndex = 0;
    let done = false;
    let pasting = false;

    let historyIndex = history.length;
    let historyDraft = "";

    const promptVisibleColumns = 2;
    const promptText = `${ANSI.bold}>${ANSI.reset} `;

    // Zeilenumbrueche einzeilig als ⏎ darstellen, damit die Cursor-Spalten-
    // Berechnung und das Loeschen der Anzeige (eine Terminalzeile) stimmen.
    // Der tatsaechliche Eingabewert behaelt die echten "\n".
    function displayLine() {
      return line
        .replace(/\n/g, `${ANSI.gray}⏎${ANSI.reset}`)
        .replace(/\t/g, " ");
    }

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
      process.stdout.write(`${promptText}${displayLine()}`);
      if (suggestions.length) {
        process.stdout.write(`\n${suggestions.join("\n")}`);
        process.stdout.write(`\u001b[${suggestions.length}A`);
      }
      process.stdout.write("\r");
      const column = promptVisibleColumns + cursor;
      if (column > 0) {
        process.stdout.write(`\u001b[${column}C`);
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
      process.stdin.off("error", onStdinError);
      process.stdout.write(BRACKETED_PASTE_OFF);
      process.stdout.write("\r\u001b[0J");
      if (value !== null) {
        process.stdout.write(`${promptText}${displayLine()}\n`);
      }
      if (!wasRaw) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      resolve(value);
    }

    function onStdinError() {
      cleanup(null);
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
      if (key.name === "paste-start") {
        pasting = true;
        return;
      }
      if (key.name === "paste-end") {
        pasting = false;
        // Waehrend des Einfuegens wird nicht gerendert (O(n) statt O(n^2)
        // Terminal-Writes bei grossen Pastes); einmal am Ende reicht.
        render();
        return;
      }
      if (pasting) {
        // Eingefuegter Text ist Inhalt, keine Steuerung: Enter/Newline wird
        // als Zeilenumbruch uebernommen statt den Prompt abzusenden.
        if (key.name === "return" || key.name === "enter" || str === "\n" || str === "\r") {
          insertText("\n");
          return;
        }
        if (str && !key.ctrl && !key.meta) {
          insertText(str);
        }
        return;
      }
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
    process.stdin.on("error", onStdinError);
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
