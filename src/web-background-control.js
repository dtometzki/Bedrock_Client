import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { getConfigDir } from "./config.js";

function statePath(directory, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Ungueltiger Webserver-Port.");
  return path.join(directory, `web-background-${port}.json`);
}

function readState(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) throw new Error();
    const raw = fs.readFileSync(fd, "utf8");
    const data = JSON.parse(raw);
    if (data.version !== 1 || !Number.isInteger(data.port) || data.port < 1 || data.port > 65535 ||
        !Number.isInteger(data.pid) || data.pid < 1 || typeof data.token !== "string" || !/^[a-f0-9]{48}$/.test(data.token)) throw new Error();
    return { raw, data };
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error("Hintergrundserver-Datei ist nicht lesbar oder ungueltig.");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function removeState(file, expected) {
  const current = readState(file);
  if (!current) return;
  if (current.raw !== expected) throw new Error("Hintergrundserver wurde inzwischen gewechselt. Bitte erneut versuchen.");
  try { fs.unlinkSync(file); }
  catch { throw new Error("Hintergrundserver-Datei konnte nicht entfernt werden."); }
}

export function registerBackgroundServer({ port, token, directory = getConfigDir() }) {
  const file = statePath(directory, port);
  const raw = JSON.stringify({ version: 1, port, pid: process.pid, token });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temporary, raw, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* Preserve the original failure. */ }
    throw new Error("Hintergrundserver konnte nicht fuer --web-stop registriert werden.");
  }
  return { cleanup: () => removeState(file, raw) };
}

function requestServer(data, method, route) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: data.port, path: route, method,
      signal: AbortSignal.timeout(2000),
      headers: { "x-bedrock-token": data.token, "Content-Type": "application/json" } }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
      res.once("error", reject);
    });
    req.setTimeout(2000, () => req.destroy(new Error("Webserver antwortet nicht.")));
    req.once("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

export async function stopWebBackground({ port, directory = getConfigDir() } = {}) {
  if (port == null) {
    let names;
    try { names = fs.readdirSync(directory).filter((name) => /^web-background-\d+\.json$/.test(name)); }
    catch (err) {
      if (err.code === "ENOENT") return false;
      throw new Error("Hintergrundserver-Verzeichnis konnte nicht gelesen werden.");
    }
    if (!names.length) return false;
    if (names.length > 1) throw new Error("Mehrere Hintergrundserver registriert. Bitte mit --web-stop --port <Port> auswaehlen.");
    port = Number(names[0].match(/\d+/)[0]);
  }
  const file = statePath(directory, port);
  const state = readState(file);
  if (!state) return false;
  if (state.data.port !== port) throw new Error("Hintergrundserver-Datei passt nicht zum Port.");
  let status;
  try { status = await requestServer(state.data, "POST", "/api/server/stop"); }
  catch (err) {
    if (err.code === "ECONNREFUSED") { removeState(file, state.raw); return false; }
    throw new Error("Hintergrundserver konnte nicht erreicht werden. Es wurde kein Prozess beendet.");
  }
  if (status !== 200) throw new Error("Hintergrundserver hat das Beenden abgelehnt. Es wurde kein fremder Prozess beendet.");
  // Confirm that this exact server is gone; never send a signal to a saved PID.
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      if (await requestServer(state.data, "GET", "/api/auth/status") === 403) return true;
    } catch (err) {
      if (err.code === "ECONNREFUSED") return true;
      throw new Error("Beenden angefordert, aber der Serverstatus konnte nicht bestaetigt werden.");
    }
  }
  throw new Error("Beenden angefordert, aber der Hintergrundserver laeuft noch.");
}
