import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readSavedEffort } from "../src/config.js";
import { readSession } from "../src/session.js";
import {
  buildAttachmentBlocks,
  getBrowserOpenCommand,
  isRequestAllowed,
  isTokenValid,
  openInBrowser,
  startWebServer,
  timingSafeEqualStrings
} from "../src/web-server.js";

const MODELS = [
  { id: "model-a", label: "Modell A" },
  { id: "model-b", label: "Modell B", profileArn: "arn:aws:bedrock:eu:1:profile/b" }
];

const EFFORT_MODELS = [
  {
    id: "reason-a",
    label: "Reasoning A",
    effort: { levels: ["low", "medium", "high"], default: "high" }
  },
  { id: "plain-b", label: "Plain B" },
  {
    id: "reason-c",
    label: "Reasoning C",
    effort: { levels: ["low", "medium", "high"], default: "high", style: "output_config" }
  }
];

function createServerOptions(overrides = {}) {
  return {
    models: MODELS,
    model: MODELS[0],
    client: null,
    region: "eu-central-1",
    profile: "default",
    identityLabel: "tester",
    systemPrompt: "Testsystem",
    maxTurns: 5,
    autoSave: false,
    persistModelSelection: false,
    port: 0,
    // Token-Pruefung in den Funktionstests aus; ein eigener Test deckt sie ab.
    authToken: "",
    ...overrides
  };
}

async function withServer(options, run) {
  const { server, url, getState } = await startWebServer(createServerOptions(options));
  try {
    await run({ url, getState });
  } finally {
    server.close();
  }
}

async function postJson(url, payload = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return { response, data: await response.json().catch(() => null) };
}

function parseSseEvents(rawBody) {
  return rawBody
    .split("\n\n")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("data:"))
    .map((part) => JSON.parse(part.slice(5)));
}

test("GET /api/state liefert Modelle, aktives Modell und Verlauf", async () => {
  await withServer({
    messages: [
      { role: "user", content: [{ text: "Hallo" }] },
      { role: "assistant", content: [{ text: "Hi!" }] }
    ]
  }, async ({ url }) => {
    const response = await fetch(`${url}/api/state`);
    assert.equal(response.status, 200);
    const state = await response.json();

    assert.deepEqual(state.models, [
      { id: "model-a", label: "Modell A", effort: null },
      { id: "model-b", label: "Modell B", effort: null }
    ]);
    assert.equal(state.modelId, "model-a");
    assert.equal(state.effort, null);
    assert.equal(state.region, "eu-central-1");
    assert.equal(state.systemPrompt, "Testsystem");
    assert.equal(state.turns, 1);
    assert.deepEqual(state.messages, [
      { role: "user", text: "Hallo", attachments: [] },
      { role: "assistant", text: "Hi!", attachments: [] }
    ]);
  });
});

test("POST /api/chat streamt Events und haengt Antwort an den Verlauf an", async () => {
  const receivedParams = [];
  async function* fakeStream(client, params) {
    receivedParams.push(params);
    yield { type: "reasoning", text: "denke nach" };
    yield { type: "text", text: "Hallo " };
    yield { type: "text", text: "Welt" };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  }

  await withServer({ streamFn: fakeStream }, async ({ url, getState }) => {
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Sag hallo" })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);

    const events = parseSseEvents(await response.text());
    assert.deepEqual(events[0], { type: "reasoning", text: "denke nach" });
    assert.deepEqual(events[1], { type: "text", text: "Hallo " });
    assert.deepEqual(events[2], { type: "text", text: "Welt" });

    const done = events.at(-1);
    assert.equal(done.type, "done");
    assert.equal(done.aborted, false);
    assert.equal(done.failed, false);
    assert.equal(done.usage.totalTokens, 15);

    assert.equal(receivedParams[0].modelId, "model-a");
    assert.equal(receivedParams[0].system, "Testsystem");

    const state = getState();
    assert.deepEqual(state.messages, [
      { role: "user", text: "Sag hallo", attachments: [] },
      { role: "assistant", text: "Hallo Welt", attachments: [] }
    ]);
    assert.equal(state.usage.totalTokens, 15);
    assert.equal(state.busy, false);
  });
});

test("POST /api/chat meldet Fehler als error-Event ohne Verlaufsaenderung", async () => {
  async function* fakeStream() {
    const err = new Error("Zugriff verweigert");
    err.name = "AccessDeniedException";
    throw err;
  }

  await withServer({ streamFn: fakeStream }, async ({ url, getState }) => {
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hallo" })
    });
    const events = parseSseEvents(await response.text());

    const errorEvent = events.find((event) => event.type === "error");
    assert.match(errorEvent.message, /AccessDeniedException: Zugriff verweigert/);
    assert.equal(events.at(-1).failed, true);
    assert.deepEqual(getState().messages, []);
  });
});

test("POST /api/chat lehnt leere Nachrichten ab", async () => {
  await withServer({}, async ({ url }) => {
    const { response, data } = await postJson(`${url}/api/chat`, { message: "   " });
    assert.equal(response.status, 400);
    assert.match(data.error, /Leere Nachricht/);
  });
});

test("POST /api/model wechselt Modell und nutzt Inference Profile ARN", async () => {
  const modelIds = [];
  async function* fakeStream(client, params) {
    modelIds.push(params.modelId);
    yield { type: "text", text: "ok" };
  }

  await withServer({ streamFn: fakeStream }, async ({ url }) => {
    const { response, data } = await postJson(`${url}/api/model`, { model: "Modell B" });
    assert.equal(response.status, 200);
    assert.equal(data.modelId, "model-b");

    await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hallo" })
    }).then((res) => res.text());
    assert.deepEqual(modelIds, ["arn:aws:bedrock:eu:1:profile/b"]);
  });
});

test("POST /api/model liefert 404 fuer unbekannte Modelle", async () => {
  await withServer({}, async ({ url }) => {
    const { response, data } = await postJson(`${url}/api/model`, { model: "gibts-nicht" });
    assert.equal(response.status, 404);
    assert.match(data.error, /Modell nicht gefunden/);
  });
});

test("Effort-Modelle liefern Effort-Optionen und Default im State", async () => {
  await withServer({ models: EFFORT_MODELS, model: EFFORT_MODELS[0] }, async ({ url }) => {
    const state = await fetch(`${url}/api/state`).then((res) => res.json());
    assert.deepEqual(state.models[0].effort, { levels: ["low", "medium", "high"], default: "high", style: "thinking" });
    assert.equal(state.models[1].effort, null);
    assert.deepEqual(state.models[2].effort, { levels: ["low", "medium", "high"], default: "high", style: "output_config" });
    assert.equal(state.effort, "high");
  });
});

test("POST /api/effort setzt gueltiges Effort Level", async () => {
  await withServer({ models: EFFORT_MODELS, model: EFFORT_MODELS[0] }, async ({ url, getState }) => {
    const { response, data } = await postJson(`${url}/api/effort`, { effort: "low" });
    assert.equal(response.status, 200);
    assert.equal(data.effort, "low");
    assert.equal(getState().effort, "low");
  });
});

test("Web-Effort wird initial wiederhergestellt und nach Aenderung gespeichert", async () => {
  const previousConfigDir = process.env.BEDROCK_CHAT_CONFIG_DIR;
  process.env.BEDROCK_CHAT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-chat-web-effort-"));

  try {
    await withServer({
      models: EFFORT_MODELS,
      model: EFFORT_MODELS[0],
      effort: "low",
      persistEffortSelection: true
    }, async ({ url }) => {
      const initialState = await fetch(`${url}/api/state`).then((res) => res.json());
      assert.equal(initialState.effort, "low");

      await postJson(`${url}/api/effort`, { effort: "medium" });
      assert.equal(readSavedEffort(), "medium");
    });
  } finally {
    if (previousConfigDir == null) delete process.env.BEDROCK_CHAT_CONFIG_DIR;
    else process.env.BEDROCK_CHAT_CONFIG_DIR = previousConfigDir;
  }
});

test("POST /api/effort lehnt ungueltige Level und nicht unterstuetzte Modelle ab", async () => {
  await withServer({ models: EFFORT_MODELS, model: EFFORT_MODELS[0] }, async ({ url }) => {
    const invalid = await postJson(`${url}/api/effort`, { effort: "turbo" });
    assert.equal(invalid.response.status, 400);
    assert.match(invalid.data.error, /Ungueltiges Effort Level/);
  });

  await withServer({ models: EFFORT_MODELS, model: EFFORT_MODELS[1] }, async ({ url }) => {
    const unsupported = await postJson(`${url}/api/effort`, { effort: "low" });
    assert.equal(unsupported.response.status, 400);
    assert.match(unsupported.data.error, /kein Effort Level/);
  });
});

test("POST /api/chat sendet adaptives Thinking mit dem gewaehlten Effort Level", async () => {
  const receivedParams = [];
  async function* fakeStream(client, params) {
    receivedParams.push(params);
    yield { type: "text", text: "ok" };
  }

  await withServer({
    models: EFFORT_MODELS,
    model: EFFORT_MODELS[0],
    streamFn: fakeStream
  }, async ({ url }) => {
    await postJson(`${url}/api/effort`, { effort: "medium" });
    await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hallo" })
    }).then((res) => res.text());

    assert.deepEqual(receivedParams[0].additionalModelRequestFields, {
      thinking: { type: "adaptive", effort: "medium" }
    });
  });
});

test("POST /api/chat nutzt den output_config-Stil bei neueren Modellen", async () => {
  const receivedParams = [];
  async function* fakeStream(client, params) {
    receivedParams.push(params);
    yield { type: "text", text: "ok" };
  }

  await withServer({
    models: EFFORT_MODELS,
    model: EFFORT_MODELS[2],
    streamFn: fakeStream
  }, async ({ url }) => {
    await postJson(`${url}/api/effort`, { effort: "low" });
    await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hallo" })
    }).then((res) => res.text());

    assert.deepEqual(receivedParams[0].additionalModelRequestFields, {
      thinking: { type: "adaptive" },
      output_config: { effort: "low" }
    });
  });
});

test("POST /api/chat ohne Effort-Unterstuetzung sendet keine Thinking-Felder", async () => {
  const receivedParams = [];
  async function* fakeStream(client, params) {
    receivedParams.push(params);
    yield { type: "text", text: "ok" };
  }

  await withServer({
    models: EFFORT_MODELS,
    model: EFFORT_MODELS[1],
    streamFn: fakeStream
  }, async ({ url }) => {
    await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hallo" })
    }).then((res) => res.text());

    assert.equal(receivedParams[0].additionalModelRequestFields, undefined);
  });
});

test("POST /api/model behaelt ein kompatibles Effort Level modelluebergreifend", async () => {
  await withServer({ models: EFFORT_MODELS, model: EFFORT_MODELS[0] }, async ({ url, getState }) => {
    await postJson(`${url}/api/effort`, { effort: "low" });
    assert.equal(getState().effort, "low");

    await postJson(`${url}/api/model`, { model: "plain-b" });
    assert.equal(getState().effort, null);

    await postJson(`${url}/api/model`, { model: "reason-a" });
    assert.equal(getState().effort, "low");
  });
});

test("POST /api/clear leert den Verlauf", async () => {
  await withServer({
    messages: [
      { role: "user", content: [{ text: "Hallo" }] },
      { role: "assistant", content: [{ text: "Hi!" }] }
    ]
  }, async ({ url, getState }) => {
    const { response, data } = await postJson(`${url}/api/clear`);
    assert.equal(response.status, 200);
    assert.deepEqual(data.messages, []);
    assert.deepEqual(getState().messages, []);
  });
});

test("POST /api/system setzt den System Prompt", async () => {
  await withServer({}, async ({ url, getState }) => {
    const { data } = await postJson(`${url}/api/system`, { system: "Antworte knapp." });
    assert.equal(data.systemPrompt, "Antworte knapp.");
    assert.equal(getState().systemPrompt, "Antworte knapp.");
  });
});

test("GET / liefert die Chat-Oberflaeche", async () => {
  await withServer({}, async ({ url }) => {
    const response = await fetch(`${url}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /Bedrock Chat/);
  });
});

test("Unbekannte Routen liefern 404", async () => {
  await withServer({}, async ({ url }) => {
    const response = await fetch(`${url}/api/unbekannt`);
    assert.equal(response.status, 404);
  });
});

test("GET /api/usage liefert Billing und Session-Nutzung", async () => {
  async function* fakeStream() {
    yield { type: "text", text: "Antwort" };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, metrics: { latencyMs: 1200 } };
  }
  const billingFn = async () => ({
    amount: 12.34,
    unit: "USD",
    estimated: true,
    period: { label: "2026-07-01 bis 2026-07-05 (exklusiv)" }
  });

  await withServer({ streamFn: fakeStream, billingFn }, async ({ url }) => {
    await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hallo" })
    }).then((res) => res.text());

    const response = await fetch(`${url}/api/usage`);
    assert.equal(response.status, 200);
    const data = await response.json();

    assert.equal(data.billing.amount, 12.34);
    assert.equal(data.billing.estimated, true);
    assert.equal(data.session.requests, 1);
    assert.equal(data.session.totalTokens, 150);
    assert.equal(data.session.last.latencyMs, 1200);
    assert.equal(data.session.byModel.length, 1);
    assert.equal(data.session.byModel[0].totalTokens, 150);
  });
});

test("GET /api/usage faengt Billing-Fehler ab", async () => {
  const billingFn = async () => { throw new Error("Cost Explorer nicht erreichbar"); };

  await withServer({ billingFn }, async ({ url }) => {
    const response = await fetch(`${url}/api/usage`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.match(data.billing.error, /Cost Explorer nicht erreichbar/);
    assert.equal(data.session.requests, 0);
  });
});

test("buildAttachmentBlocks erzeugt Dokument- und Bild-Bloecke", () => {
  const data = Buffer.from("Inhalt").toString("base64");
  const { blocks, displayNames } = buildAttachmentBlocks([
    { name: "bericht 2026.pdf", dataBase64: data },
    { name: "foto.jpg", dataBase64: data }
  ]);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].document.format, "pdf");
  assert.equal(blocks[0].document.name, "bericht 2026");
  assert.ok(Buffer.isBuffer(blocks[0].document.source.bytes));
  assert.equal(blocks[1].image.format, "jpeg");
  assert.deepEqual(displayNames, ["bericht 2026.pdf", "foto.jpg"]);
});

test("buildAttachmentBlocks bereinigt unerlaubte Zeichen im Dokumentnamen", () => {
  const data = Buffer.from("x").toString("base64");
  const { blocks } = buildAttachmentBlocks([{ name: "Kosten_Übersicht  v2!.md", dataBase64: data }]);
  assert.match(blocks[0].document.name, /^[a-zA-Z0-9 \-()[\]]+$/);
  assert.ok(!/\s{2,}/.test(blocks[0].document.name));
});

test("buildAttachmentBlocks lehnt unbekannte Typen, leere und zu grosse Dateien ab", () => {
  const data = Buffer.from("x").toString("base64");
  assert.match(buildAttachmentBlocks([{ name: "app.exe", dataBase64: data }]).error, /nicht unterstuetzt/);
  assert.match(buildAttachmentBlocks([{ name: "leer.txt", dataBase64: "" }]).error, /ohne Inhalt/);

  const big = Buffer.alloc(4_500_001).toString("base64");
  assert.match(buildAttachmentBlocks([{ name: "gross.pdf", dataBase64: big }]).error, /zu gross/);

  const many = Array.from({ length: 6 }, (_, i) => ({ name: `d${i}.txt`, dataBase64: data }));
  assert.match(buildAttachmentBlocks(many).error, /Zu viele Anhaenge/);
});

test("POST /api/chat sendet Anhaenge als Content-Bloecke an Bedrock", async () => {
  const receivedParams = [];
  async function* fakeStream(client, params) {
    receivedParams.push(params);
    yield { type: "text", text: "Zusammenfassung" };
  }

  await withServer({ streamFn: fakeStream }, async ({ url, getState }) => {
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Fasse das zusammen",
        attachments: [{ name: "notizen.txt", dataBase64: Buffer.from("Notizen").toString("base64") }]
      })
    });
    assert.equal(response.status, 200);
    await response.text();

    const sentContent = receivedParams[0].messages.at(-1).content;
    assert.equal(sentContent[0].text, "Fasse das zusammen");
    assert.equal(sentContent[1].document.format, "txt");
    assert.equal(sentContent[1].document.source.bytes.toString("utf8"), "Notizen");

    const lastUser = getState().messages.at(-2);
    assert.deepEqual(lastUser.attachments, ["notizen.txt"]);
  });
});

test("POST /api/chat akzeptiert Anhang ohne Text und lehnt ungueltige Anhaenge ab", async () => {
  async function* fakeStream() {
    yield { type: "text", text: "ok" };
  }

  await withServer({ streamFn: fakeStream }, async ({ url }) => {
    const onlyAttachment = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "",
        attachments: [{ name: "daten.csv", dataBase64: Buffer.from("a;b").toString("base64") }]
      })
    });
    assert.equal(onlyAttachment.status, 200);
    await onlyAttachment.text();

    const { response, data } = await postJson(`${url}/api/chat`, {
      message: "Hallo",
      attachments: [{ name: "virus.exe", dataBase64: Buffer.from("x").toString("base64") }]
    });
    assert.equal(response.status, 400);
    assert.match(data.error, /nicht unterstuetzt/);
  });
});

test("Auto-Save erhaelt reine Anhang-Turns als gueltige Text-History", async () => {
  const previousConfigDir = process.env.BEDROCK_CHAT_CONFIG_DIR;
  process.env.BEDROCK_CHAT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-chat-web-session-"));

  async function* fakeStream() {
    yield { type: "text", text: "Datei ausgewertet" };
  }

  try {
    await withServer({ autoSave: true, streamFn: fakeStream }, async ({ url }) => {
      const response = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "",
          attachments: [{ name: "daten.csv", dataBase64: Buffer.from("a;b").toString("base64") }]
        })
      });
      await response.text();

      const saved = readSession();
      assert.deepEqual(saved.messages.map((entry) => entry.role), ["user", "assistant"]);
      assert.equal(saved.messages[0].content[0].text, "[Anhang: daten.csv]");
      assert.deepEqual(saved.messages[0].attachmentNames, ["daten.csv"]);
    });
  } finally {
    if (previousConfigDir == null) delete process.env.BEDROCK_CHAT_CONFIG_DIR;
    else process.env.BEDROCK_CHAT_CONFIG_DIR = previousConfigDir;
  }
});

test("isRequestAllowed schuetzt vor DNS-Rebinding und fremden Origins", () => {
  // localhost-Hosts sind erlaubt, auch ohne Origin.
  assert.equal(isRequestAllowed({ headers: { host: "127.0.0.1:3456" } }), true);
  assert.equal(isRequestAllowed({ headers: { host: "localhost:3456" } }), true);
  // Passender Origin ist erlaubt.
  assert.equal(isRequestAllowed({
    headers: { host: "127.0.0.1:3456", origin: "http://127.0.0.1:3456" }
  }), true);
  // Fremder Host (rebindeter Angreifer) wird abgelehnt.
  assert.equal(isRequestAllowed({ headers: { host: "evil.com" } }), false);
  // Fremder Origin bei erlaubtem Host wird abgelehnt (CSRF).
  assert.equal(isRequestAllowed({
    headers: { host: "127.0.0.1:3456", origin: "http://evil.com" }
  }), false);
});

test("Server lehnt Anfragen mit fremdem Host mit 403 ab", async () => {
  await withServer({}, async ({ url }) => {
    const port = Number(new URL(url).port);
    // fetch verbietet das Setzen des Host-Headers, daher direkt ueber node:http.
    const statusCode = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/api/state", method: "GET", headers: { Host: "evil.com" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(statusCode, 403);
  });
});

test("getBrowserOpenCommand waehlt den plattformspezifischen Befehl", () => {
  const url = "http://127.0.0.1:3456";
  assert.deepEqual(getBrowserOpenCommand(url, "darwin"), { command: "open", args: [url] });
  assert.deepEqual(getBrowserOpenCommand(url, "win32"), { command: "cmd", args: ["/c", "start", "", url] });
  assert.deepEqual(getBrowserOpenCommand(url, "linux"), { command: "xdg-open", args: [url] });
});

test("openInBrowser startet den Browser-Befehl entkoppelt", () => {
  const calls = [];
  const fakeChild = { unref: () => { calls.push("unref"); }, on: () => {} };
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return fakeChild;
  };

  const ok = openInBrowser("http://127.0.0.1:3456", { platform: "darwin", spawnFn });
  assert.equal(ok, true);
  assert.deepEqual(calls[0], {
    command: "open",
    args: ["http://127.0.0.1:3456"],
    options: { stdio: "ignore", detached: true }
  });
  assert.equal(calls[1], "unref");
});

test("openInBrowser faengt Spawn-Fehler ab", () => {
  const ok = openInBrowser("http://127.0.0.1:3456", {
    platform: "linux",
    spawnFn: () => { throw new Error("nicht verfuegbar"); }
  });
  assert.equal(ok, false);
});

test("maxTurns begrenzt den gespeicherten Verlauf", async () => {
  async function* fakeStream() {
    yield { type: "text", text: "Antwort" };
  }

  await withServer({ streamFn: fakeStream, maxTurns: 1 }, async ({ url, getState }) => {
    for (const message of ["eins", "zwei"]) {
      await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      }).then((res) => res.text());
    }

    const state = getState();
    assert.equal(state.messages.length, 2);
    assert.equal(state.messages[0].text, "zwei");
  });
});

test("timingSafeEqualStrings vergleicht Werte korrekt", () => {
  assert.equal(timingSafeEqualStrings("abc", "abc"), true);
  assert.equal(timingSafeEqualStrings("abc", "abd"), false);
  assert.equal(timingSafeEqualStrings("abc", "abcd"), false);
  assert.equal(timingSafeEqualStrings("", ""), true);
});

test("isTokenValid ohne konfiguriertes Token laesst alles zu", () => {
  const req = { headers: {} };
  const url = new URL("http://localhost/api/state");
  assert.equal(isTokenValid(req, url, ""), true);
});

test("isTokenValid akzeptiert Token via Header und Query", () => {
  const url = new URL("http://localhost/api/state?token=geheim");
  assert.equal(isTokenValid({ headers: { "x-bedrock-token": "geheim" } }, new URL("http://localhost/"), "geheim"), true);
  assert.equal(isTokenValid({ headers: {} }, url, "geheim"), true);
  assert.equal(isTokenValid({ headers: {} }, new URL("http://localhost/"), "geheim"), false);
  assert.equal(isTokenValid({ headers: { "x-bedrock-token": "falsch" } }, new URL("http://localhost/"), "geheim"), false);
});

test("startWebServer erzeugt Token und blockt Requests ohne Token", async () => {
  const { server, url, authToken } = await startWebServer(createServerOptions({ authToken: undefined }));
  try {
    assert.equal(typeof authToken, "string");
    assert.ok(authToken.length >= 32);

    const denied = await fetch(`${url}/api/state`);
    assert.equal(denied.status, 403);

    const allowedHeader = await fetch(`${url}/api/state`, { headers: { "x-bedrock-token": authToken } });
    assert.equal(allowedHeader.status, 200);

    const allowedQuery = await fetch(`${url}/api/state?token=${authToken}`);
    assert.equal(allowedQuery.status, 200);
  } finally {
    server.close();
  }
});
