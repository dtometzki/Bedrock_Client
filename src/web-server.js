import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  buildAdaptiveThinkingFields,
  buildInferenceConfig,
  createBedrockClient,
  formatBedrockErrorMessage,
  regionForModelId,
  streamConverseWithRetry
} from "./bedrock.js";
import { consumeConverseStream } from "./stream-consumer.js";
import { findModel, getModelInvocationId, normalizeEffort, resolveEffortLevel } from "./models.js";
import { appendAssistantResponse, countHistoryTurns } from "./history.js";
import { clearSession, writeSession } from "./session.js";
import { tryPersist, writeLastModelId, writeSavedEffort } from "./config.js";
import { emptyUsageTotals, loadCurrentBedrockBillingCost } from "./usage.js";

export const DEFAULT_WEB_PORT = 3456;

const INDEX_HTML_URL = new URL("./web/index.html", import.meta.url);

// GUI-Skripte, die neben index.html ausgeliefert werden. Bewusst eine feste
// Liste exakter Routen statt eines Dateisystem-Lookups aus dem Request-Pfad –
// damit gibt es keinerlei Pfad-Traversal-Flaeche.
const STATIC_SCRIPTS = new Map([
  ["GET /app.js", new URL("./web/app.js", import.meta.url)],
  ["GET /vendor/marked.min.js", new URL("./web/vendor/marked.min.js", import.meta.url)],
  ["GET /vendor/purify.min.js", new URL("./web/vendor/purify.min.js", import.meta.url)]
]);

// Routen ohne Token-Pflicht: statisches HTML/JS ohne Geheimnisse. Die
// Index-Seite muss ohne Token laden koennen (Browser-Reload, nachdem die GUI
// das Token aus der URL entfernt und in sessionStorage uebernommen hat), und
// die Script-Tags der Seite senden den Token-Header prinzipbedingt nicht mit.
// Alle API-Routen, die Kosten verursachen oder Verlauf preisgeben, verlangen
// weiterhin das Token.
const PUBLIC_ROUTES = new Set(["GET /", ...STATIC_SCRIPTS.keys()]);

// Einzige Quelle der Content-Security-Policy (index.html setzt bewusst kein
// Meta-Tag mehr: zwei Policies werden beide durchgesetzt und blockieren sich
// bei Abweichungen gegenseitig). script-src 'self' ohne 'unsafe-inline' ist
// der zentrale XSS-Schutz der GUI: Selbst wenn ein Sanitizer-Bypass Markup in
// eine Antwort schmuggelt, fuehrt der Browser injizierte Inline-Skripte und
// Event-Handler nicht aus. img-src bleibt ohne https:, damit Modell-Antworten
// keine Daten ueber Remote-Bild-URLs (Tracking-Pixel) exfiltrieren koennen.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'"
].join("; ");

const MAX_BODY_BYTES = 1_000_000;
const MAX_CHAT_BODY_BYTES = 40_000_000;

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 4_500_000;

// Von Bedrock Converse unterstuetzte Formate.
const DOCUMENT_FORMATS = {
  pdf: "pdf", csv: "csv", doc: "doc", docx: "docx",
  xls: "xls", xlsx: "xlsx", html: "html", htm: "html",
  txt: "txt", md: "md"
};
const IMAGE_FORMATS = { png: "png", jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp" };

function sanitizeDocumentName(name) {
  // Converse erlaubt in Dokumentnamen nur Alphanumerik, Leerzeichen,
  // Bindestriche und Klammern – ohne aufeinanderfolgende Leerzeichen.
  const base = String(name || "dokument").replace(/\.[^.]+$/, "");
  const cleaned = base
    .replace(/[^a-zA-Z0-9 \-()[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "dokument";
}

export function buildAttachmentBlock(attachment) {
  const name = String(attachment?.name || "");
  const extension = (name.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  const dataBase64 = String(attachment?.dataBase64 || "");

  if (!dataBase64) {
    return { error: `Anhang ohne Inhalt: ${name || "unbenannt"}` };
  }

  // Buffer.from wirft bei ungueltigem Base64 nicht, sondern ignoriert
  // ungueltige Zeichen still – daher explizit vorab validieren.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64) || dataBase64.length % 4 !== 0) {
    return { error: `Anhang konnte nicht dekodiert werden: ${name}` };
  }
  const bytes = Buffer.from(dataBase64, "base64");
  if (!bytes.length) {
    return { error: `Anhang ohne Inhalt: ${name || "unbenannt"}` };
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    return { error: `Anhang zu gross (max. 4,5 MB): ${name}` };
  }

  if (IMAGE_FORMATS[extension]) {
    return {
      block: { image: { format: IMAGE_FORMATS[extension], source: { bytes } } },
      displayName: name
    };
  }
  if (DOCUMENT_FORMATS[extension]) {
    return {
      block: {
        document: {
          format: DOCUMENT_FORMATS[extension],
          name: sanitizeDocumentName(name),
          source: { bytes }
        }
      },
      displayName: name
    };
  }

  const supported = [...new Set([...Object.keys(DOCUMENT_FORMATS), ...Object.keys(IMAGE_FORMATS)])].join(", ");
  return { error: `Dateityp nicht unterstuetzt: ${name} (unterstuetzt: ${supported})` };
}

export function buildAttachmentBlocks(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) {
    return { blocks: [], displayNames: [] };
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    return { error: `Zu viele Anhaenge (max. ${MAX_ATTACHMENTS}).` };
  }

  const blocks = [];
  const displayNames = [];
  for (const attachment of attachments) {
    const result = buildAttachmentBlock(attachment);
    if (result.error) {
      return { error: result.error };
    }
    blocks.push(result.block);
    displayNames.push(result.displayName);
  }
  return { blocks, displayNames };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function tryPersistWeb(action, label) {
  tryPersist(action, `[Web] ${label}`, true);
}

const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

// Schutz gegen DNS-Rebinding und CSRF von anderen lokalen Ursprüngen:
// Der Host-Header muss auf localhost zeigen (ein rebindeter Angreifer-Host
// sendet Host: evil.com), und ein vorhandener Origin-Header muss zum Host
// passen. Fehlt Origin (direkte Navigation, Tools ohne Browser), wird die
// Anfrage zugelassen.
export function isRequestAllowed(req) {
  const hostHeader = req.headers?.host || "";
  const hostname = hostHeader.replace(/:\d+$/, "");
  if (!ALLOWED_HOSTNAMES.has(hostname)) {
    return false;
  }

  const origin = req.headers?.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== hostHeader) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

// Liest das Auth-Token ausschliesslich aus dem x-bedrock-token-Header.
// Der ?token=-Query-Parameter wird serverseitig bewusst NICHT akzeptiert:
// Tokens in URLs landen in Logs und Verlaeufen. Die GUI liest das Token beim
// ersten Laden clientseitig aus der URL (die Index-Seite ist ohne Token
// erreichbar, siehe PUBLIC_ROUTES) und sendet es danach nur noch als Header.
function getRequestToken(req) {
  const header = req.headers?.["x-bedrock-token"];
  return header ? String(header) : "";
}

// Konstantzeit-Vergleich ueber die gepruefte Node-Implementierung (C-seitig,
// keine JIT-/Compiler-Effekte), damit die Antwortzeit das Token nicht Zeichen
// fuer Zeichen preisgibt.
export function timingSafeEqualStrings(a, b) {
  const bufferA = Buffer.from(String(a), "utf8");
  const bufferB = Buffer.from(String(b), "utf8");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

export function isTokenValid(req, authToken) {
  if (!authToken) return true;
  return timingSafeEqualStrings(getRequestToken(req), authToken);
}

export function readJsonBody(req, { limit = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request Body zu gross."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Ungueltiges JSON im Request Body."));
      }
    });
    req.on("error", reject);
  });
}

function toPublicMessages(messages) {
  return messages.map((message) => {
    const content = message.content ?? [];
    const textParts = [];
    const attachmentParts = [];

    // Ein Durchlauf ueber content statt zweier separater filter/map-Ketten.
    for (const block of content) {
      if (typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block.document || block.image) {
        attachmentParts.push(block.document?.name || "Bild");
      }
    }

    return {
      role: message.role,
      text: textParts.join(""),
      attachments: message.attachmentNames ?? attachmentParts
    };
  });
}

function toBedrockMessages(messages) {
  // attachmentNames ist nur fuer die Anzeige gedacht und wird nicht an Bedrock gesendet.
  return messages.map(({ role, content }) => ({ role, content }));
}

function toPersistableMessages(messages) {
  // Session-Dateien speichern nur Text-Bloecke; Anhaenge (Binaerdaten)
  // werden beim Persistieren entfernt. Reine Anhang-Nachrichten erhalten einen
  // Textplatzhalter, damit kein verwaistes Assistant-Element gespeichert wird.
  return messages
    .map((message) => {
      const attachmentNames = Array.isArray(message.attachmentNames)
        ? message.attachmentNames.filter((name) => typeof name === "string" && name)
        : [];
      const content = (message.content ?? []).filter((block) => typeof block.text === "string");
      if (!content.length && attachmentNames.length) {
        content.push({ text: `[Anhang${attachmentNames.length === 1 ? "" : "e"}: ${attachmentNames.join(", ")}]` });
      }
      return {
        role: message.role,
        content,
        ...(attachmentNames.length && { attachmentNames })
      };
    })
    .filter((message) => message.content.length);
}

// Anzahl der juengsten Nutzer-Turns, fuer die Anhaenge als Binaerdaten im
// Verlauf bleiben. 1 = der zuletzt gesendete Anhang steht genau einer
// Folgefrage noch vollstaendig zur Verfuegung.
export const ATTACHMENT_HISTORY_TURNS = 1;

// Ersetzt Bild-/Dokument-Bloecke einer Nachricht durch einen Textplatzhalter
// mit den Dateinamen. attachmentNames bleibt erhalten, damit die GUI den
// Anhang weiterhin anzeigt.
function stripAttachmentBytes(message) {
  const blocks = message.content ?? [];
  const binaryBlocks = blocks.filter((block) => block.document || block.image);
  if (!binaryBlocks.length) {
    return message;
  }

  const names = message.attachmentNames?.length
    ? message.attachmentNames
    : binaryBlocks.map((block) => block.document?.name || "Bild");
  const placeholder = { text: `[Anhang${names.length === 1 ? "" : "e"}: ${names.join(", ")}]` };
  const textBlocks = blocks.filter((block) => typeof block.text === "string");

  return {
    ...message,
    content: [...textBlocks, placeholder]
  };
}

// Begrenzt, wie lange Anhaenge als Binaerdaten im Verlauf mitgefuehrt werden.
// Ohne diese Grenze schickt jede Folgefrage saemtliche frueheren Anhaenge
// erneut an Bedrock – ein 4,5-MB-PDF wuerde bei zehn Rueckfragen zehnmal
// hochgeladen und zehnmal als Input-Tokens abgerechnet.
export function limitAttachmentHistory(messages, keepTurns = ATTACHMENT_HISTORY_TURNS) {
  const userIndexes = [];
  messages.forEach((message, index) => {
    if (message.role === "user") {
      userIndexes.push(index);
    }
  });

  let keepFrom = messages.length;
  if (keepTurns > 0) {
    keepFrom = userIndexes.length > keepTurns ? userIndexes[userIndexes.length - keepTurns] : 0;
  }

  return messages.map((message, index) => (
    index >= keepFrom ? message : stripAttachmentBytes(message)
  ));
}

function toPublicUsageRecord(record) {
  if (!record) return null;
  return {
    modelLabel: record.modelLabel,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    totalTokens: record.totalTokens,
    costUsd: record.costUsd,
    latencyMs: record.latencyMs ?? null
  };
}

export function createWebServer(options = {}) {
  const {
    models = [],
    model = null,
    client = null,
    inferenceOverrides = {},
    effort = null,
    systemPrompt = "",
    region = "",
    identityLabel = "",
    profile = "default",
    maxTurns = 0,
    autoSave = false,
    messages: initialMessages = [],
    streamFn = streamConverseWithRetry,
    billingFn = loadCurrentBedrockBillingCost,
    createClient = createBedrockClient,
    indexHtmlPath = INDEX_HTML_URL,
    persistModelSelection = true,
    persistEffortSelection = persistModelSelection,
    authToken = ""
  } = options;

  if (!model) {
    throw new Error("Web-Server benoetigt ein aktives Modell.");
  }

  // Ein Inference-Profile-ARN ist an die Region im ARN gebunden. Modelle koennen
  // im Web-GUI gewechselt werden, daher wird der passende Client anhand der
  // modelId aufgeloest: die Umgebungsregion nutzt den uebergebenen Client, davon
  // abweichende ARN-Regionen bekommen einen eigenen, zwischengespeicherten Client.
  const regionalClients = new Map();
  function resolveInvocationClient(modelId) {
    const targetRegion = regionForModelId(modelId, region);
    if (!targetRegion || targetRegion === region) {
      return client;
    }
    let regionalClient = regionalClients.get(targetRegion);
    if (!regionalClient) {
      regionalClient = createClient({ region: targetRegion });
      regionalClients.set(targetRegion, regionalClient);
    }
    return regionalClient;
  }

  const state = {
    model,
    inferenceConfig: buildInferenceConfig(model, inferenceOverrides),
    effort: resolveEffortLevel(model, effort),
    preferredEffort: effort,
    systemPrompt,
    messages: [...initialMessages],
    usageTotals: emptyUsageTotals(),
    abortController: null,
    busy: false
  };

  function persistSession() {
    if (autoSave) {
      writeSession(toPersistableMessages(state.messages), { modelId: state.model.id });
    }
  }

  function getStatePayload() {
    return {
      models: models.map((entry) => ({
        id: entry.id,
        label: entry.label,
        effort: normalizeEffort(entry)
      })),
      modelId: state.model.id,
      modelLabel: state.model.label,
      effort: state.effort,
      region,
      identityLabel,
      profile,
      systemPrompt: state.systemPrompt,
      maxTurns,
      busy: state.busy,
      turns: countHistoryTurns(state.messages),
      messages: toPublicMessages(state.messages),
      usage: {
        requests: state.usageTotals.requests,
        inputTokens: state.usageTotals.inputTokens,
        outputTokens: state.usageTotals.outputTokens,
        totalTokens: state.usageTotals.totalTokens,
        costUsd: state.usageTotals.costUsd
      }
    };
  }

  async function handleUsage(res) {
    const billing = await billingFn().catch((err) => ({ error: err.message }));
    sendJson(res, 200, {
      billing,
      session: {
        requests: state.usageTotals.requests,
        inputTokens: state.usageTotals.inputTokens,
        outputTokens: state.usageTotals.outputTokens,
        totalTokens: state.usageTotals.totalTokens,
        costUsd: state.usageTotals.costUsd,
        last: toPublicUsageRecord(state.usageTotals.last),
        byModel: [...state.usageTotals.byModel.entries()].map(([modelLabel, totals]) => ({
          modelLabel,
          requests: totals.requests,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          totalTokens: totals.totalTokens,
          costUsd: totals.costUsd,
          hasUnknownCost: totals.hasUnknownCost
        }))
      }
    });
  }

  // Die statischen Dateien aendern sich zur Laufzeit nicht; einmal lesen
  // statt bei jedem Reload synchron von der Platte.
  const staticFileCache = new Map();

  function readStaticFile(cacheKey, filePath) {
    let contents = staticFileCache.get(cacheKey);
    if (contents === undefined) {
      contents = fs.readFileSync(filePath, "utf8");
      staticFileCache.set(cacheKey, contents);
    }
    return contents;
  }

  function handleIndex(res) {
    let html;
    try {
      html = readStaticFile("index", indexHtmlPath);
    } catch {
      sendJson(res, 500, { error: "index.html nicht gefunden." });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer"
    });
    res.end(html);
  }

  function handleStaticScript(res, route) {
    let script;
    try {
      script = readStaticFile(route, STATIC_SCRIPTS.get(route));
    } catch {
      sendJson(res, 500, { error: "GUI-Skript nicht gefunden." });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(script);
  }

  function handleAbort(res) {
    if (state.abortController) {
      state.abortController.abort();
    }
    sendJson(res, 200, { ok: true, busy: state.busy });
  }

  function handleClear(res) {
    if (state.busy) {
      sendJson(res, 409, { error: "Anfrage laeuft noch. Erst abbrechen." });
      return;
    }
    state.messages = [];
    if (autoSave) {
      clearSession();
    }
    sendJson(res, 200, getStatePayload());
  }

  async function handleModelSwitch(req, res) {
    // Body zuerst lesen, dann busy pruefen: Waehrend des await koennte eine
    // Chat-Anfrage starten; der Check danach verhindert Wechsel mid-stream.
    const body = await readJsonBody(req);
    if (state.busy) {
      sendJson(res, 409, { error: "Anfrage laeuft noch. Erst abbrechen." });
      return;
    }
    const requested = String(body?.model ?? "").trim();
    const selected = findModel(models, requested);
    if (!selected) {
      sendJson(res, 404, { error: `Modell nicht gefunden: ${requested}` });
      return;
    }
    state.model = selected;
    state.inferenceConfig = buildInferenceConfig(selected, inferenceOverrides);
    state.effort = resolveEffortLevel(selected, state.preferredEffort);
    if (persistModelSelection) {
      tryPersistWeb(() => writeLastModelId(selected.id), "Modell speichern");
    }
    sendJson(res, 200, getStatePayload());
  }

  async function handleEffort(req, res) {
    // Body zuerst lesen, dann busy pruefen (siehe handleModelSwitch).
    const body = await readJsonBody(req);
    if (state.busy) {
      sendJson(res, 409, { error: "Anfrage laeuft noch. Erst abbrechen." });
      return;
    }
    const effortConfig = normalizeEffort(state.model);
    if (!effortConfig) {
      sendJson(res, 400, { error: "Aktuelles Modell unterstuetzt kein Effort Level." });
      return;
    }
    const requested = String(body?.effort ?? "").trim();
    if (!effortConfig.levels.includes(requested)) {
      sendJson(res, 400, { error: `Ungueltiges Effort Level: ${requested}` });
      return;
    }
    state.effort = requested;
    state.preferredEffort = requested;
    if (persistEffortSelection) {
      tryPersistWeb(() => writeSavedEffort(requested), "Effort speichern");
    }
    sendJson(res, 200, getStatePayload());
  }

  async function handleSystemPrompt(req, res) {
    // Body zuerst lesen, dann busy pruefen (siehe handleModelSwitch).
    const body = await readJsonBody(req);
    if (state.busy) {
      sendJson(res, 409, { error: "Anfrage laeuft noch. Erst abbrechen." });
      return;
    }
    state.systemPrompt = String(body?.system ?? "").trim();
    sendJson(res, 200, getStatePayload());
  }

  async function handleChat(req, res) {
    if (state.busy) {
      sendJson(res, 409, { error: "Es laeuft bereits eine Anfrage." });
      return;
    }
    // busy sofort (synchron) setzen: Der Body-Read unten ist ein await, und
    // eine zweite parallele Anfrage wuerde sonst den busy-Check ebenfalls
    // passieren und gleichzeitig streamen (Race auf state.messages/abortController).
    state.busy = true;

    let body;
    try {
      body = await readJsonBody(req, { limit: MAX_CHAT_BODY_BYTES });
    } catch (err) {
      state.busy = false;
      sendJson(res, 400, { error: err.message });
      return;
    }

    const message = String(body?.message ?? "").trim();
    const attachmentResult = buildAttachmentBlocks(body?.attachments);
    if (attachmentResult.error) {
      state.busy = false;
      sendJson(res, 400, { error: attachmentResult.error });
      return;
    }
    if (!message && !attachmentResult.blocks.length) {
      state.busy = false;
      sendJson(res, 400, { error: "Leere Nachricht." });
      return;
    }

    const abortController = new AbortController();
    state.abortController = abortController;

    // try/finally stellt sicher, dass busy/abortController auch bei einem
    // unerwarteten Fehler zurueckgesetzt werden. Sonst blockiert der Server
    // dauerhaft alle weiteren Anfragen mit 409.
    try {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      // Nach einem Client-Disconnect ist die Response beendet; weitere Writes
      // wuerden fehlschlagen. Der Guard verwirft solche Events still.
      const send = (event) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      };
      res.on("close", () => {
        if (state.busy && state.abortController === abortController) {
          abortController.abort();
        }
      });

      const userMessage = {
        role: "user",
        content: [
          ...(message ? [{ text: message }] : []),
          ...attachmentResult.blocks
        ],
        ...(attachmentResult.displayNames.length && { attachmentNames: attachmentResult.displayNames })
      };
      const requestMessages = [...state.messages, userMessage];

      const effortConfig = normalizeEffort(state.model);
      const invocationModelId = getModelInvocationId(state.model);

      const { fullResponse, usageRecord, aborted, error } = await consumeConverseStream(
        streamFn(resolveInvocationClient(invocationModelId), {
          modelId: invocationModelId,
          messages: toBedrockMessages(requestMessages),
          system: state.systemPrompt || undefined,
          inferenceConfig: state.inferenceConfig,
          additionalModelRequestFields: effortConfig
            ? buildAdaptiveThinkingFields(state.effort, effortConfig.style)
            : undefined,
          abortSignal: abortController.signal
        }),
        {
          usageTotals: state.usageTotals,
          model: state.model,
          abortSignal: abortController.signal,
          onRetry: (event) => {
            send({
              type: "retry",
              attempt: event.attempt,
              maxRetries: event.maxRetries,
              delayMs: Math.round(event.delayMs),
              message: formatBedrockErrorMessage(event.error)
            });
          },
          onReasoning: (text) => {
            send({ type: "reasoning", text });
          },
          onText: (text) => {
            send({ type: "text", text });
          }
        }
      );
      const failed = Boolean(error);
      if (failed) {
        send({ type: "error", message: formatBedrockErrorMessage(error) });
      }

      if (!failed && fullResponse) {
        state.messages = limitAttachmentHistory(
          appendAssistantResponse(requestMessages, fullResponse, { aborted, maxTurns })
        );
        persistSession();
      }

      send({
        type: "done",
        aborted,
        failed,
        usage: toPublicUsageRecord(usageRecord)
      });
      if (!res.writableEnded) {
        res.end();
      }
    } finally {
      state.busy = false;
      state.abortController = null;
    }
  }

  const routes = new Map([
    ["GET /", (_req, res) => handleIndex(res)],
    ...[...STATIC_SCRIPTS.keys()].map((route) => [
      route,
      (_req, res) => handleStaticScript(res, route)
    ]),
    ["GET /api/state", (_req, res) => sendJson(res, 200, getStatePayload())],
    ["GET /api/usage", (_req, res) => handleUsage(res)],
    ["POST /api/chat", handleChat],
    ["POST /api/abort", (_req, res) => handleAbort(res)],
    ["POST /api/clear", (_req, res) => handleClear(res)],
    ["POST /api/model", handleModelSwitch],
    ["POST /api/effort", handleEffort],
    ["POST /api/system", handleSystemPrompt]
  ]);

  const server = http.createServer((req, res) => {
    if (!isRequestAllowed(req)) {
      sendJson(res, 403, { error: "Zugriff nur von localhost erlaubt." });
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;
    const route = `${req.method} ${pathname}`;

    // Statische GUI-Dateien bleiben ohne Token erreichbar (siehe
    // PUBLIC_ROUTES; Host-/Origin-Pruefung oben gilt weiterhin).
    if (!PUBLIC_ROUTES.has(route) && !isTokenValid(req, authToken)) {
      sendJson(res, 403, { error: "Ungueltiges oder fehlendes Token." });
      return;
    }

    const handler = routes.get(route);

    if (!handler) {
      sendJson(res, 404, { error: `Unbekannte Route: ${route}` });
      return;
    }

    Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err.message });
      } else {
        res.end();
      }
    });
  });

  // Die zusaetzlich pro ARN-Region angelegten Clients gehoeren dem Server; der
  // uebergebene Basis-Client wird vom Aufrufer verwaltet und hier nicht zerstoert.
  server.on("close", () => {
    for (const regionalClient of regionalClients.values()) {
      regionalClient?.destroy?.();
    }
    regionalClients.clear();
  });

  // Begrenzt, wie lange der Server auf den vollstaendigen Request-Body wartet.
  // Ohne Timeout koennte ein langsamer Client die Verbindung unbegrenzt halten.
  server.requestTimeout = 60_000;

  return { server, getState: getStatePayload };
}

export function getBrowserOpenCommand(url, platform = process.platform) {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    // "start" ist ein cmd-Builtin; das leere Argument ist der Fenstertitel.
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Uebergibt das Auth-Token ueber eine private temporaere HTML-Datei an den
// Browser. Der Browser-Prozess erhaelt dadurch nur den Dateipfad als Argument;
// das Token erscheint weder in der Prozessliste noch in der Terminalausgabe.
// Das URL-Fragment wird nicht an den HTTP-Server gesendet und von der GUI nach
// dem Einlesen sofort aus der Adresszeile entfernt.
export function createBrowserBootstrap(url, authToken, { tempRoot = os.tmpdir() } = {}) {
  const bootstrapDir = fs.mkdtempSync(path.join(tempRoot, "bedrock-chat-"));
  const bootstrapPath = path.join(bootstrapDir, "open.html");

  try {
    if (process.platform !== "win32") {
      fs.chmodSync(bootstrapDir, 0o700);
    }
    const targetUrl = new URL(url);
    targetUrl.hash = new URLSearchParams({ token: String(authToken) }).toString();
    const escapedTarget = escapeHtmlAttribute(targetUrl.toString());
    const html = [
      "<!doctype html>",
      "<html><head><meta charset=\"utf-8\">",
      "<meta name=\"referrer\" content=\"no-referrer\">",
      `<meta http-equiv="refresh" content="0;url=${escapedTarget}">`,
      "<title>Bedrock Chat wird geoeffnet</title></head>",
      `<body><a href="${escapedTarget}">Bedrock Chat oeffnen</a></body></html>\n`
    ].join("");
    fs.writeFileSync(bootstrapPath, html, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
  } catch (err) {
    try {
      fs.rmSync(bootstrapDir, { recursive: true, force: true });
    } catch {
      // Der urspruengliche Erstellungsfehler ist fuer den Aufrufer relevant.
    }
    throw err;
  }

  let cleanedUp = false;
  return {
    path: bootstrapPath,
    cleanup() {
      if (cleanedUp) return;
      try {
        fs.rmSync(bootstrapDir, { recursive: true, force: true });
        cleanedUp = true;
      } catch {
        // Best effort, z. B. wenn Windows die gerade geoeffnete Datei noch
        // sperrt. Beim Schliessen des Servers wird cleanup erneut versucht.
      }
    }
  };
}

export function openInBrowser(url, { platform = process.platform, spawnFn = spawn } = {}) {
  try {
    const { command, args } = getBrowserOpenCommand(url, platform);
    const child = spawnFn(command, args, { stdio: "ignore", detached: true });
    child.on?.("error", () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

export function startWebServer(options = {}) {
  const { port = DEFAULT_WEB_PORT, host = "127.0.0.1", ...rest } = options;
  // Standardmaessig ein zufaelliges Token erzeugen; leeres Token deaktiviert
  // die Pruefung (z. B. in Tests). Bewusst per authToken === null abschaltbar.
  const authToken = rest.authToken === undefined
    ? randomBytes(24).toString("hex")
    : rest.authToken;
  const { server, getState } = createWebServer({ ...rest, authToken });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        getState,
        authToken,
        port: address.port,
        url: `http://${host}:${address.port}`
      });
    });
  });
}
