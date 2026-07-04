import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import {
  buildInferenceConfig,
  formatBedrockErrorMessage,
  isAbortError,
  streamConverseWithRetry
} from "./bedrock.js";
import { findModel, getModelInvocationId } from "./models.js";
import { countHistoryTurns, trimMessagesToMaxTurns } from "./history.js";
import { clearSession, writeSession } from "./session.js";
import { writeLastModelId } from "./config.js";
import { addUsageRecord, emptyUsageTotals, loadCurrentBedrockBillingCost } from "./usage.js";

export const DEFAULT_WEB_PORT = 3456;

const INDEX_HTML_URL = new URL("./web/index.html", import.meta.url);
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

  let bytes;
  try {
    bytes = Buffer.from(dataBase64, "base64");
  } catch {
    return { error: `Anhang konnte nicht dekodiert werden: ${name}` };
  }
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
  return messages.map((message) => ({
    role: message.role,
    text: message.content?.find((block) => typeof block.text === "string")?.text ?? "",
    attachments: message.attachmentNames ?? (message.content ?? [])
      .filter((block) => block.document || block.image)
      .map((block) => block.document?.name || "Bild")
  }));
}

function toBedrockMessages(messages) {
  // attachmentNames ist nur fuer die Anzeige gedacht und wird nicht an Bedrock gesendet.
  return messages.map(({ role, content }) => ({ role, content }));
}

function toPersistableMessages(messages) {
  // Session-Dateien speichern nur Text-Bloecke; Anhaenge (Binaerdaten)
  // werden beim Persistieren entfernt, der Nachrichtentext bleibt erhalten.
  return messages
    .map((message) => ({
      role: message.role,
      content: (message.content ?? []).filter((block) => typeof block.text === "string")
    }))
    .filter((message) => message.content.length);
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
    systemPrompt = "",
    region = "",
    identityLabel = "",
    profile = "default",
    maxTurns = 0,
    autoSave = false,
    messages: initialMessages = [],
    streamFn = streamConverseWithRetry,
    billingFn = loadCurrentBedrockBillingCost,
    indexHtmlPath = INDEX_HTML_URL,
    persistModelSelection = true
  } = options;

  if (!model) {
    throw new Error("Web-Server benoetigt ein aktives Modell.");
  }

  const state = {
    model,
    inferenceConfig: buildInferenceConfig(model, inferenceOverrides),
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
      models: models.map((entry) => ({ id: entry.id, label: entry.label })),
      modelId: state.model.id,
      modelLabel: state.model.label,
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

  function handleIndex(res) {
    let html;
    try {
      html = fs.readFileSync(indexHtmlPath, "utf8");
    } catch {
      sendJson(res, 500, { error: "index.html nicht gefunden." });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
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
    if (state.busy) {
      sendJson(res, 409, { error: "Anfrage laeuft noch. Erst abbrechen." });
      return;
    }
    const body = await readJsonBody(req);
    const requested = String(body?.model ?? "").trim();
    const selected = findModel(models, requested);
    if (!selected) {
      sendJson(res, 404, { error: `Modell nicht gefunden: ${requested}` });
      return;
    }
    state.model = selected;
    state.inferenceConfig = buildInferenceConfig(selected, inferenceOverrides);
    if (persistModelSelection) {
      try {
        writeLastModelId(selected.id);
      } catch {}
    }
    sendJson(res, 200, getStatePayload());
  }

  async function handleSystemPrompt(req, res) {
    if (state.busy) {
      sendJson(res, 409, { error: "Anfrage laeuft noch. Erst abbrechen." });
      return;
    }
    const body = await readJsonBody(req);
    state.systemPrompt = String(body?.system ?? "").trim();
    sendJson(res, 200, getStatePayload());
  }

  async function handleChat(req, res) {
    if (state.busy) {
      sendJson(res, 409, { error: "Es laeuft bereits eine Anfrage." });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req, { limit: MAX_CHAT_BODY_BYTES });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }

    const message = String(body?.message ?? "").trim();
    const attachmentResult = buildAttachmentBlocks(body?.attachments);
    if (attachmentResult.error) {
      sendJson(res, 400, { error: attachmentResult.error });
      return;
    }
    if (!message && !attachmentResult.blocks.length) {
      sendJson(res, 400, { error: "Leere Nachricht." });
      return;
    }

    state.busy = true;
    const abortController = new AbortController();
    state.abortController = abortController;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    const send = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
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

    let fullResponse = "";
    let usageRecord = null;
    let aborted = false;
    let failed = false;

    try {
      for await (const event of streamFn(client, {
        modelId: getModelInvocationId(state.model),
        messages: toBedrockMessages(requestMessages),
        system: state.systemPrompt || undefined,
        inferenceConfig: state.inferenceConfig,
        abortSignal: abortController.signal
      })) {
        if (event.type === "retry") {
          send({
            type: "retry",
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            delayMs: Math.round(event.delayMs),
            message: formatBedrockErrorMessage(event.error)
          });
          continue;
        }
        if (event.type === "usage") {
          usageRecord = addUsageRecord(state.usageTotals, {
            model: state.model,
            usage: event.usage,
            metrics: event.metrics
          });
          continue;
        }
        if (event.type === "reasoning") {
          send({ type: "reasoning", text: event.text });
          continue;
        }
        fullResponse += event.text;
        send({ type: "text", text: event.text });
      }
    } catch (err) {
      if (isAbortError(err) || abortController.signal.aborted) {
        aborted = true;
      } else {
        failed = true;
        send({ type: "error", message: formatBedrockErrorMessage(err) });
      }
    }

    if (!failed && fullResponse) {
      const responseText = aborted
        ? `${fullResponse}\n\n[Antwort abgebrochen – unvollstaendig]`
        : fullResponse;
      state.messages = trimMessagesToMaxTurns([
        ...requestMessages,
        { role: "assistant", content: [{ text: responseText }] }
      ], maxTurns);
      persistSession();
    }

    send({
      type: "done",
      aborted,
      failed,
      usage: toPublicUsageRecord(usageRecord)
    });
    res.end();
    state.busy = false;
    state.abortController = null;
  }

  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    const route = `${req.method} ${pathname}`;

    const handler = {
      "GET /": () => handleIndex(res),
      "GET /api/state": () => sendJson(res, 200, getStatePayload()),
      "GET /api/usage": () => handleUsage(res),
      "POST /api/chat": () => handleChat(req, res),
      "POST /api/abort": () => handleAbort(res),
      "POST /api/clear": () => handleClear(res),
      "POST /api/model": () => handleModelSwitch(req, res),
      "POST /api/system": () => handleSystemPrompt(req, res)
    }[route];

    if (!handler) {
      sendJson(res, 404, { error: `Unbekannte Route: ${route}` });
      return;
    }

    Promise.resolve(handler()).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err.message });
      } else {
        res.end();
      }
    });
  });

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
  const { server, getState } = createWebServer(rest);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        getState,
        port: address.port,
        url: `http://${host}:${address.port}`
      });
    });
  });
}
