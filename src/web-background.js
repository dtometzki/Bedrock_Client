import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHILD_ENV = "BEDROCK_WEB_BACKGROUND_CHILD";

// Readiness travels over private IPC, never a URL token or a PID file.
export function launchWebBackground({ argv = process.argv.slice(2), env = process.env,
  entrypoint = fileURLToPath(new URL("../app_aws.js", import.meta.url)),
  spawnFn = spawn, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(process.execPath, [entrypoint, ...argv.filter((arg) => arg !== "--background")], {
      cwd: process.cwd(), env: { ...env, [CHILD_ENV]: "1" },
      detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    let ready;
    let finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
    };
    const fail = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      child.kill();
      if (child.connected) child.disconnect();
      child.unref();
      reject(error);
    };
    const onInterrupt = () => fail(new Error("Hintergrundstart abgebrochen."));
    const timer = setTimeout(() => fail(new Error("Webserver hat den Start nicht rechtzeitig bestaetigt.")), timeoutMs);
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    child.on("error", () => fail(new Error("Webserver konnte nicht im Hintergrund gestartet werden.")));
    child.once("exit", (code) => fail(new Error(`Webserver wurde vor dem erfolgreichen Start beendet (Exit ${code ?? "Signal"}).`)));
    child.on("message", (message) => {
      if (finished) return;
      if (message?.type === "web-error") {
        fail(new Error(typeof message.error === "string" ? message.error : "Webserver-Start fehlgeschlagen."));
      } else if (message?.type === "web-ready" && !ready) {
        ready = { url: message.url, launchTarget: message.launchTarget, opened: message.opened, pid: child.pid };
        child.send({ type: "web-detach" }, (err) => { if (err) fail(new Error("Hintergrundstart konnte nicht abgeschlossen werden.")); });
      }
    });
    child.once("disconnect", () => {
      if (finished) return;
      if (!ready) { fail(new Error("Webserver-Start wurde unterbrochen.")); return; }
      finished = true;
      cleanup();
      child.unref();
      resolve(ready);
    });
  });
}

export function createBackgroundReporter() {
  if (process.env[CHILD_ENV] !== "1" || !process.send) return null;
  delete process.env[CHILD_ENV];
  let detached = false;
  // A cancelled launcher must not leave an unannounced server behind.
  process.once("disconnect", () => { if (!detached) process.exit(1); });
  process.on("message", (message) => {
    if (message?.type !== "web-detach") return;
    detached = true;
    process.disconnect();
  });
  return {
    ready: (info) => process.send({ type: "web-ready", ...info }),
    error: (error) => { if (process.connected) process.send({ type: "web-error", error: error.message }); }
  };
}

export function backgroundStopCommand(pid, platform = process.platform) {
  return platform === "win32" ? `taskkill /PID ${pid} /T` : `kill -TERM ${pid}`;
}
