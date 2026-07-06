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
  // Ohne Effort-Unterstuetzung erscheint keine Effort-Zeile und kein Hinweis.
  assert(!lines.some((line) => line.includes("Effort")));
});

test("formatModelSelectionLines shows an effort row for the highlighted model", () => {
  const lines = formatModelSelectionLines([
    { id: "plain", label: "Plain" },
    { id: "thinker", label: "Thinker", effort: { levels: ["low", "medium", "high"], default: "high" } }
  ], "thinker", 1, "low");

  // Effort-Zeile vorhanden, gewaehltes Level "low" ist hervorgehoben.
  assert(lines.some((line) => line.includes("Effort") && line.includes(`${ANSI.inverse} Niedrig ${ANSI.reset}`)));
  assert(lines.some((line) => line.includes("Effort") && line.includes("Enter uebernimmt")));
});
