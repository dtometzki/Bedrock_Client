import { randomBytes } from "node:crypto";
import { AuthError } from "./credential-vault.js";

// Cookies are host scoped, so use a separate name for each listening port.
// Tokens and revocation state only live in this server process.
export class BrowserSessions {
  constructor() { this.sessions = new Map(); }
  name(req) { return `bedrock_session_${req.socket.localPort}`; }
  get(req) {
    const prefix = `${this.name(req)}=`;
    const values = (req.headers.cookie || "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(prefix));
    return values.length === 1 ? this.sessions.get(values[0].slice(prefix.length)) : undefined;
  }
  issue(req, res) {
    if (this.get(req)?.valid) return;
    if (this.sessions.size >= 64) throw new AuthError("Zu viele Browser-Sitzungen. Server neu starten.", 429);
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { valid: true, responses: new Set() });
    res.setHeader("Set-Cookie", `${this.name(req)}=${token}; HttpOnly; SameSite=Strict; Path=/`);
  }
  clearCookie(req, res) {
    res.setHeader("Set-Cookie", `${this.name(req)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }
  track(req, res, session, mutation = false) {
    req.browserSession = session;
    req.checkBrowserSession = () => {
      if (!session.valid) throw new AuthError("Browser-Sitzung gesperrt. Bitte erneut entsperren.", 403);
    };
    // Auth mutations return only their new status and may rotate their own session.
    // All other in-flight responses must stop immediately on revocation.
    if (!mutation) {
      session.responses.add(res);
      res.once("close", () => session.responses.delete(res));
    }
  }
  revokeAll() {
    for (const session of this.sessions.values()) {
      session.valid = false;
      for (const res of session.responses) res.destroy();
    }
    this.sessions.clear();
  }
}

export function isBrowserRequest(req) {
  const host = req.headers.host;
  const site = req.headers["sec-fetch-site"];
  return req.headers["x-bedrock-request"] === "1" &&
    (!site || site === "same-origin" || site === "none") &&
    (req.method === "GET" || (req.headers.origin === `http://${host}` &&
      req.headers["content-type"]?.split(";")[0].trim() === "application/json"));
}
