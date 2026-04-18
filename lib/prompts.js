import { stdout as output, stdin as input } from "node:process";
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
  const ac = new globalThis.AbortController();

  const onKeypress = () => {
    // If the user types "/" as the very first character, abort immediately
    // so we can show the command selection menu.
    if (rl.line === "/" && rl.cursor === 1) {
      ac.abort();
    }
  };

  input.on("keypress", onKeypress);

  try {
    const answer = await rl.question(buildInputPrompt(label), { signal: ac.signal });
    input.removeListener("keypress", onKeypress);
    output.write(`${ANSI.reset}\n`);
    return answer;
  } catch (err) {
    input.removeListener("keypress", onKeypress);
    if (err.name === "AbortError") {
      // Clear the prompt line to make way for the menu
      output.write("\r\x1b[K");
      output.write(`${ANSI.reset}\n`);
      return "/";
    }
    throw err;
  }
}
