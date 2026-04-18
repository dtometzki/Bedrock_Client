import { stdout as output } from "node:process";
import { ANSI } from "./ansi.js";

export function formatSpeakerLabel(label) {
  return `${ANSI.bold}${ANSI.cyan}${label}${ANSI.reset}`;
}

function buildInputPrompt(label) {
  const barWidth = Math.max(output.columns ?? 80, 20);
  const promptText = ` ${label} `;
  const blankLine = `${ANSI.bgLightGray}${ANSI.white}${" ".repeat(barWidth)}`;

  return `\n${blankLine}\n${blankLine}\n${blankLine}\u001b[1A\r${ANSI.bgLightGray}${ANSI.white}${promptText}`;
}

export async function askStyledQuestion(rl, label) {
  const answer = await rl.question(buildInputPrompt(label));
  output.write(`${ANSI.reset}\n`);
  return answer;
}
