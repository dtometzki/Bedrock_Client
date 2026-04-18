import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { ANSI } from "./ansi.js";
import { askStyledQuestion } from "./prompts.js";

function buildModelSelectionLines(models, currentModelId, selectedIndex, promptLabel) {
  const lines = ["Verfügbare Modelle:"];

  models.forEach((model, index) => {
    const pointer = index === selectedIndex ? `${ANSI.cyan}>${ANSI.reset}` : " ";
    const isActive = model.id === currentModelId ? ` ${ANSI.gray}(aktiv)${ANSI.reset}` : "";
    lines.push(`${pointer} ${model.label}${isActive}`);
  });

  lines.push("");
  lines.push(promptLabel);
  lines.push(
    `${ANSI.gray}Pfeiltasten zum Wählen, Enter zum Bestätigen, Esc zum Abbrechen.${ANSI.reset}`
  );
  return lines;
}

async function promptForModelSelectionInteractive(models, currentModelId, promptLabel) {
  emitKeypressEvents(input);

  const initialIndex = models.findIndex((model) => model.id === currentModelId);
  let selectedIndex = initialIndex >= 0 ? initialIndex : 0;
  let renderedLineCount = 0;
  let hasSeenNavigation = false;
  const openedAt = Date.now();

  const render = () => {
    const lines = buildModelSelectionLines(models, currentModelId, selectedIndex, promptLabel);
    if (renderedLineCount > 0) {
      output.write(`\u001b[${renderedLineCount}A\u001b[0J`);
    }
    output.write(`${lines.join("\n")}\n`);
    renderedLineCount = lines.length;
  };

  return new Promise((resolve) => {
    const previousRawMode = input.isRaw;
    input.resume();
    input.setEncoding("utf8");
    output.write("\n");

    const cleanup = (result) => {
      input.off("keypress", handleKeypress);
      if (typeof input.setRawMode === "function") {
        input.setRawMode(previousRawMode ?? false);
      }
      if (renderedLineCount > 0) {
        output.write(`\u001b[${renderedLineCount}A\u001b[0J`);
      }
      resolve(result);
    };

    const handleKeypress = (_, key) => {
      if (!key) return;

      if (key.ctrl && key.name === "c") {
        cleanup(null);
        return;
      }

      if (key.name === "up") {
        hasSeenNavigation = true;
        selectedIndex = selectedIndex === 0 ? models.length - 1 : selectedIndex - 1;
        render();
        return;
      }

      if (key.name === "down") {
        hasSeenNavigation = true;
        selectedIndex = selectedIndex === models.length - 1 ? 0 : selectedIndex + 1;
        render();
        return;
      }

      if (key.name === "escape") {
        cleanup(null);
        return;
      }

      if (key.name === "return") {
        const elapsedMs = Date.now() - openedAt;
        if (!hasSeenNavigation && elapsedMs < 200) {
          return;
        }
        cleanup(models[selectedIndex]);
      }
    };

    input.on("keypress", handleKeypress);
    input.setRawMode(true);
    render();
  });
}

export async function promptForModelSelection(
  models,
  currentModelId,
  promptLabel = "Wähle ein Modell"
) {
  if (input.isTTY && typeof input.setRawMode === "function") {
    return promptForModelSelectionInteractive(models, currentModelId, promptLabel);
  }

  console.log("Verfügbare Modelle:");
  models.forEach((model, index) => {
    const isActive = model.id === currentModelId ? " (aktiv)" : "";
    console.log(`[${index + 1}] ${model.label}${isActive}`);
  });

  const choice = await askStyledQuestion(
    `${promptLabel} (1-${models.length}, Enter zum Abbrechen)`
  );
  const trimmedChoice = choice.trim();

  if (!trimmedChoice) {
    return null;
  }

  const selectedIndex = parseInt(trimmedChoice, 10) - 1;
  if (selectedIndex >= 0 && selectedIndex < models.length) {
    return models[selectedIndex];
  }

  console.log("\n[System: Ungültige Modellnummer.]\n");
  return null;
}
