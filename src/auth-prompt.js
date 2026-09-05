import { AuthError } from "./credential-vault.js";
import { sanitizeTerminalText } from "./response-format.js";
import { StringDecoder } from "node:string_decoder";
import { authModeExplanation, formatAuthSummary } from "./auth-display.js";

// Raw input: no echo, readline history, command-line arguments or env secrets.
export function readSecret(label, { input = process.stdin, output = process.stdout, onActivity = () => {} } = {}) {
  if (!input.isTTY || !output.isTTY) return Promise.reject(new AuthError("AWS-Einstellungen benoetigen ein interaktives Terminal. Alternativ die Weboberflaeche verwenden."));
  return new Promise((resolve, reject) => {
    let value = "";
    const decoder = new StringDecoder("utf8");
    const wasRaw = input.isRaw;
    const wasPaused = input.isPaused();
    const finish = (err) => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.setRawMode(Boolean(wasRaw));
      if (wasPaused) input.pause();
      output.write("\n");
      const result = value;
      value = "";
      if (err) reject(err); else resolve(result);
    };
    const onEnd = () => finish(new AuthError("Eingabe abgebrochen."));
    const onError = () => finish(new AuthError("Terminaleingabe fehlgeschlagen."));
    const onData = (chunk) => {
      onActivity();
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (text.includes("\x03") || text.includes("\x04")) { onEnd(); return; }
      // Escape sequences (arrows, paste markers) are never part of secrets.
      if (text.includes("\x1b")) return;
      for (const char of text) {
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\x7f" || char === "\b") value = [...value].slice(0, -1).join("");
        else if (char >= " " && char !== "\x7f") value += char;
        if (Buffer.byteLength(value) > 1024) { finish(new AuthError("Eingabe zu lang.")); return; }
      }
    };
    output.write(sanitizeTerminalText(label) + " ");
    input.setRawMode(true);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.resume();
  });
}

export async function manageAuth(auth, action = "status", ask = (label) => readSecret(label, { onActivity: () => auth.touch() })) {
  if (action === "status") {
    const status = auth.status();
    console.log("AWS-Anmeldung: " + sanitizeTerminalText(formatAuthSummary(status)));
    console.log("/auth setup | unlock | lock | update | password | delete | check | aws | vault");
    return;
  }
  if (["setup", "update"].includes(action)) {
    console.log("AWS-Profile: " + (await auth.listProfiles({ rolesOnly: true })).map(sanitizeTerminalText).join(", "));
    const data = {
      profile: await ask("AWS-Rollenprofil:"),
      accessKeyId: await ask("Access Key ID (verdeckt):"),
      secretAccessKey: await ask("Secret Access Key (verdeckt):")
    };
    try {
      if (action === "setup") {
        const password = await ask("Neues Masterpasswort (mindestens 12 Zeichen):");
        await auth.setup(data, password, await ask("Masterpasswort wiederholen:"));
      } else await auth.update(data);
    } finally { data.accessKeyId = ""; data.secretAccessKey = ""; }
  } else if (action === "unlock") {
    await auth.unlock(await ask("Masterpasswort:"));
  } else if (action === "lock") {
    auth.lock();
  } else if (action === "password") {
    const oldPassword = await ask("Bisheriges Masterpasswort:");
    const password = await ask("Neues Masterpasswort (mindestens 12 Zeichen):");
    await auth.changePassword(oldPassword, password, await ask("Neues Masterpasswort wiederholen:"));
  } else if (action === "delete") {
    console.log("Der gespeicherte AWS-Zugang wird geloescht. Ohne Masterpasswort ist keine Wiederherstellung moeglich.");
    await auth.remove(await ask("Zum Bestaetigen TRESOR LOESCHEN eingeben:"));
  } else if (action === "check") {
    await auth.checkConnection();
  } else if (["aws", "vault"].includes(action)) {
    console.log(authModeExplanation(action));
    await auth.selectMode(action);
  } else throw new AuthError("Unbekannter /auth-Befehl. Zugangsdaten nur in die verdeckte Eingabe eingeben.");
  if (!["setup", "unlock"].includes(action)) await manageAuth(auth, "status", ask);
}
