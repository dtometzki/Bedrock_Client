// Browser access is shared by tabs through an HttpOnly cookie. JavaScript only
// handles a legacy startup token long enough to exchange it, never stores it.
export function initBrowserSession({ onLock, onUnlock }) {
  const el = (id) => document.getElementById(id);
  const dialog = el("browserDialog");
  let ready = false;
  let generation = 0;
  let controller = new AbortController();
  let checking = null;
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("bedrock-browser-session") : null;
  const expired = () => new Error("Browser-Sitzung gesperrt. Bitte erneut entsperren.");
  const rawFetch = (url, options = {}) => fetch(url, { ...options, credentials: "same-origin",
    headers: { "x-bedrock-request": "1", ...options.headers } });

  function lock(notify = false) {
    ready = false;
    generation++;
    controller.abort();
    controller = new AbortController();
    onLock();
    if (!dialog.open) dialog.showModal();
    if (notify) channel?.postMessage({ type: "locked", origin: location.origin });
  }
  channel?.addEventListener("message", (event) => {
    if (event.data?.type === "locked" && event.data.origin === location.origin) lock();
  });
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  el("browserForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    el("browserUnlock").disabled = true;
    el("browserFeedback").textContent = "Wird entsperrt …";
    let body = JSON.stringify({ password: el("browserPassword").value });
    el("browserPassword").value = "";
    try {
      const response = await rawFetch("/api/browser/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Entsperren fehlgeschlagen.");
      el("browserFeedback").textContent = "";
      await check();
    } catch (err) { el("browserFeedback").textContent = err.message; }
    finally { body = ""; el("browserUnlock").disabled = false; }
  });

  async function check() {
    if (checking) return checking;
    const epoch = generation;
    checking = (async () => {
      const response = await rawFetch("/api/browser/status");
      if (!response.ok) throw new Error("Browser-Zugang konnte nicht geprüft werden.");
      const status = await response.json();
      if (epoch !== generation) return;
      el("browserForm").hidden = !status.vaultLogin;
      el("browserUnlock").textContent = status.switchesToVault ? "Mit Tresor anmelden" : "Entsperren";
      el("browserHint").textContent = status.vaultLogin
        ? status.switchesToVault
          ? "Dein Tresor ist vorhanden. Mit deinem Masterpasswort wechselst du zur Tresor-Anmeldung und verwendest die darin gespeicherten Schlüssel. Wenn du bei der bestehenden AWS-Anmeldung bleiben möchtest, öffne die sichere Startdatei aus dem Terminal."
          : "Entsperre den Tresor mit deinem Masterpasswort. Weitere Fenster dieses Browsers verwenden dieselbe Sitzung."
        : "Hier ist noch kein Tresor eingerichtet. Öffne zur ersten Anmeldung die sichere Startdatei aus dem Terminal. Dort kannst du deinen Tresor einrichten oder die bestehende AWS-Anmeldung verwenden.";
      if (status.authenticated) {
        if (!ready) {
          ready = true;
          dialog.close();
          try { await onUnlock(); }
          catch (err) { lock(); throw err; }
        }
      } else if (ready || !dialog.open) lock();
    })().finally(() => { checking = null; });
    return checking;
  }

  async function start() {
    const params = new URLSearchParams(location.hash.slice(1));
    const query = new URLSearchParams(location.search);
    let token = params.get("token") || query.get("token") || "";
    try {
      token ||= sessionStorage.getItem("bedrock-chat-token") || "";
      sessionStorage.removeItem("bedrock-chat-token");
    } catch { /* Storage may be disabled; cookies still provide browser access. */ }
    if (params.has("token") || query.has("token")) {
      const clean = new URL(location.href);
      clean.searchParams.delete("token");
      clean.hash = "";
      history.replaceState(null, "", clean.toString());
    }
    if (token) {
      try {
        await rawFetch("/api/browser/connect", { method: "POST",
          headers: { "Content-Type": "application/json", "x-bedrock-token": token }, body: "{}" });
      } finally { token = ""; }
    }
    await check();
  }

  async function apiFetch(url, options = {}) {
    if (!ready) throw expired();
    const epoch = generation;
    const response = await rawFetch(url, { ...options, signal: controller.signal });
    if (epoch !== generation) throw expired();
    if (response.status === 403) {
      const data = await response.clone().json().catch(() => ({}));
      if (data.code === "BROWSER_SESSION_REQUIRED") {
        lock(true);
        void check().catch(() => {});
        throw expired();
      }
    }
    if (response.ok && ["/api/auth/lock", "/api/auth/delete", "/api/auth/mode"].includes(url)) {
      const status = await response.json();
      if (url !== "/api/auth/mode" || (status.mode === "vault" && status.locked)) {
        lock(true);
        void check().catch(() => {});
      }
      return new Response(JSON.stringify(status), { status: response.status, headers: { "Content-Type": "application/json" } });
    }
    // A response body can arrive after a lock even when its headers arrived before.
    for (const method of ["json", "text"]) {
      const read = response[method].bind(response);
      response[method] = async () => {
        const data = await read();
        if (epoch !== generation) throw expired();
        return data;
      };
    }
    return response;
  }
  setInterval(() => check().catch(() => {}), 5000);
  window.addEventListener("focus", () => check().catch(() => {}));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void check().catch(() => {}); });
  return { start, fetch: apiFetch, generation: () => generation, isReady: () => ready };
}
