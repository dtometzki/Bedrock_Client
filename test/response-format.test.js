import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeTerminalText } from "../src/response-format.js";

test("sanitizeTerminalText entfernt ANSI-, OSC- und sonstige Steuerzeichen", () => {
  const value = [
    "normal ",
    "\u001b[31mrot\u001b[0m ",
    "\u001b]52;c;Z2VoZWlt\u0007",
    "ende\u0000\u0008\nzeile\tspalte"
  ].join("");

  assert.equal(sanitizeTerminalText(value), "normal rot ende\nzeile\tspalte");
});
