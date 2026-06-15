import { ANSI, terminalWidth } from "./ui.js";

const RESPONSE_INDENT = "  ";
let inCodeBlock = false;

export function resetResponseFormatting() {
  inCodeBlock = false;
}

export function formatCodeLine(line) {
  return line ? `${RESPONSE_INDENT}${line}` : "";
}

export function formatLine(line) {
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
