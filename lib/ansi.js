export const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  black: "\u001b[30m",
  white: "\u001b[97m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  bgLight: "\u001b[48;5;255m",
  bgLightGray: "\u001b[48;5;240m"
};

export function getTerminalSeparator() {
  const separatorWidth = Math.min(process.stdout.columns ?? 60, 80);
  return "-".repeat(separatorWidth);
}

export function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function formatInlineCode(text) {
  return text.replace(/`([^`]+)`/g, `${ANSI.yellow}$1${ANSI.reset}`);
}
