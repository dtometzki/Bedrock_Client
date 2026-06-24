import assert from "node:assert/strict";
import test from "node:test";
import { formatModelSelectionLines } from "../src/prompt.js";
import { ANSI } from "../src/ui.js";

test("formatModelSelectionLines highlights selected and active model", () => {
  const lines = formatModelSelectionLines([
    { id: "model-a", label: "Model A" },
    { id: "model-b", label: "Model B" }
  ], "model-b", 1);

  assert(lines.some((line) => line.includes(`${ANSI.gray}[1]${ANSI.reset} Model A`)));
  assert(lines.some((line) => line === `${ANSI.inverse}> [2] Model B (aktiv)${ANSI.reset}`));
  assert(lines.some((line) => line.includes("Pfeile waehlen")));
});
