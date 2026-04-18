import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { setImmediate } from "node:timers";
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

async function promptForModelSelectionInteractive(rl, models, currentModelId, promptLabel) {
  emitKeypressEvents(input);

  const initialIndex = models.findIndex((model) => model.id === currentModelId);
  let selectedIndex = initialIndex >= 0 ? initialIndex : 0;
  let renderedLineCount = 0;

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
    rl?.pause?.();
    output.write("\n");

    const cleanup = (result) => {
      input.off("keypress", handleKeypress);
      input.setRawMode(previousRawMode ?? false);
      output.write(`\u001b[${renderedLineCount}A\u001b[0J`);
      rl?.resume?.();
      resolve(result);
    };

    const handleKeypress = (_, key) => {
      if (!key) return;

      if (key.name === "up") {
        selectedIndex = selectedIndex === 0 ? models.length - 1 : selectedIndex - 1;
        render();
        return;
      }

      if (key.name === "down") {
        selectedIndex = selectedIndex === models.length - 1 ? 0 : selectedIndex + 1;
        render();
        return;
      }

      if (key.name === "return") {
        cleanup(models[selectedIndex]);
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
    setImmediate(() => {
      input.on("keypress", handleKeypress);
      render();
    });
  });
}

export async function promptForModelSelection(
  rl,
  models,
  currentModelId,
  promptLabel = "Wähle ein Modell"
) {
  if (input.isTTY && typeof input.setRawMode === "function") {
    return promptForModelSelectionInteractive(rl, models, currentModelId, promptLabel);
  }

  console.log("Verfügbare Modelle:");
  models.forEach((model, index) => {
    const isActive = model.id === currentModelId ? " (aktiv)" : "";
    console.log(`[${index + 1}] ${model.label}${isActive}`);
  });

  const choice = await askStyledQuestion(
    rl,
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
