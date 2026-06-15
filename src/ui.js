import fs from "node:fs";
import os from "node:os";

export const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  inverse: "\u001b[7m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  magenta: "\u001b[35m"
};

export function terminalWidth() {
  return Math.max(40, Math.min(process.stdout.columns || 120, 180));
}

export function terminalLine() {
  return `${ANSI.gray}${"-".repeat(terminalWidth())}${ANSI.reset}`;
}

export function centerText(text, width = terminalWidth()) {
  const left = Math.max(0, Math.floor((width - text.length) / 2));
  return " ".repeat(left) + text;
}

export function getPackageVersion() {
  try {
    const packageJsonPath = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return packageJson.version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

export function formatHomePath(path) {
  const home = os.homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

export function printStartupBanner({ model, region, identityLabel }) {
  const width = terminalWidth();
  const profile = process.env.AWS_PROFILE || "default";
  const modelLabel = model.label || model.id;

  console.log("");
  console.log(`${ANSI.bold}${centerText(`AWS Bedrock CLI ${getPackageVersion()}`, width)}${ANSI.reset}`);
  if (identityLabel) {
    console.log(centerText(identityLabel, width));
  }
  console.log(centerText(`${profile} (${region})`, width));
  console.log(centerText(modelLabel, width));
  console.log(centerText(formatHomePath(process.cwd()), width));
  console.log("");
  console.log(terminalLine());
}

export function formatInteger(value) {
  return new Intl.NumberFormat("de-DE").format(value || 0);
}

export function formatUsd(value) {
  if (value == null) return "n/a";
  if (value > 0 && value < 0.0001) return "< $0.0001";
  return `$${value.toFixed(4)}`;
}

export function formatLatency(latencyMs) {
  return Number.isFinite(latencyMs) ? `${Math.round(latencyMs)} ms` : "n/a";
}
