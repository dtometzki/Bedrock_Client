import { ANSI, terminalWidth } from "./ui.js";

const RESPONSE_INDENT = "  ";

// Modelltext ist nicht vertrauenswuerdig. Entfernt Terminal-Steuersequenzen
// (einschliesslich OSC/CSI) sowie sonstige C0/C1-Zeichen, behaelt aber die fuer
// Chattext relevanten Tabs und Zeilenumbrueche bei.
export function sanitizeTerminalText(value) {
  return String(value ?? "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

export function formatCodeLine(line) {
  return line ? `${RESPONSE_INDENT}${line}` : "";
}

// Kapselt den Formatierungszustand (offener Codeblock) pro Instanz, statt ihn
// modul-global zu halten. So koennen mehrere Streams unabhaengig formatiert
// werden; die CLI nutzt die unten exportierte Default-Instanz.
export function createResponseFormatter() {
  let inCodeBlock = false;

  return {
    reset() {
      inCodeBlock = false;
    },
    formatLine(line) {
      if (line.trim().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        return null;
      }

      if (inCodeBlock) {
        return formatCodeLine(line);
      }

      if (!line) {
        return "";
      }

      if (line.match(/^(#{1,6})\s+(.+)$/)) {
        return `${RESPONSE_INDENT}${ANSI.bold}${line}${ANSI.reset}`;
      }

      if (line === "---") {
        return `${RESPONSE_INDENT}${ANSI.gray}${"-".repeat(Math.min(72, terminalWidth() - RESPONSE_INDENT.length))}${ANSI.reset}`;
      }

      return RESPONSE_INDENT + line
        .replace(/\*\*([^*]+)\*\*/g, `${ANSI.bold}$1${ANSI.reset}`)
        .replace(/`([^`]+)`/g, `${ANSI.cyan}$1${ANSI.reset}`);
    }
  };
}

const defaultFormatter = createResponseFormatter();

export function resetResponseFormatting() {
  defaultFormatter.reset();
}

export function formatLine(line) {
  return defaultFormatter.formatLine(line);
}
