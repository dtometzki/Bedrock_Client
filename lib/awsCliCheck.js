import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ANSI } from "./ansi.js";

const execFileAsync = promisify(execFile);

function buildAwsCliErrorMessage(error) {
  if (error?.code === "ENOENT") {
    return "AWS CLI wurde nicht gefunden. Bitte installiere `aws` und konfiguriere deine Credentials.";
  }

  const stderr = error?.stderr?.trim();
  if (stderr) {
    return `AWS CLI Prüfung fehlgeschlagen: ${stderr}`;
  }

  return "AWS CLI Prüfung fehlgeschlagen. Bitte überprüfe Installation, Credentials und Netzwerkzugriff.";
}

export async function verifyAwsCliConnection() {
  try {
    const { stdout } = await execFileAsync(
      "aws",
      ["sts", "get-caller-identity", "--output", "json"],
      { timeout: 15000 }
    );

    const identity = JSON.parse(stdout);
    if (!identity?.Arn || !identity?.Account) {
      throw new Error("AWS CLI lieferte keine gültige Identität.");
    }

    return identity;
  } catch (error) {
    throw new Error(buildAwsCliErrorMessage(error));
  }
}

export function printAwsCliStatus(identity) {
  console.log(`${ANSI.gray}[AWS CLI verbunden: ${identity.Account} | ${identity.Arn}]${ANSI.reset}\n`);
}
