import { ANSI } from "./ansi.js";

const LOGO = [
  " ____          _                 _    ",
  "| __ )  ___  __| |_ __ ___   ___| | __",
  "|  _ \\/ _ \\/ _` | '__/ _ \\\\ / __| |/ /",
  "| |_) |  __/ (_| | | | (_) | (__|   < ",
  "|____/ \\___|\\__,_|_|  \\___/ \\___|_|\\_\\"
];

export function printLogo() {
  console.log(`\n${ANSI.cyan}${LOGO.join("\n")}${ANSI.reset}`);
  console.log(`${ANSI.gray}interactive cli${ANSI.reset}`);
  console.log(`${ANSI.gray}by Damian Tometzki${ANSI.reset}\n`);
}
