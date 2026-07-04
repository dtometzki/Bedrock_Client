import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAttachmentBlocks,
  getBrowserOpenCommand,
  openInBrowser,
  startWebServer
} from "../src/web-server.js";

const MODELS = [
  { id: "model-a", label: "Modell A" },
  { id: "model-b", label: "Modell B", profileArn: "arn:aws:bedrock:eu:1:profile/b" }
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
      { id: "model-a", label: "Modell A" },
      { id: "model-b", label: "Modell B" }
    ]);
    assert.equal(state.modelId, "model-a");
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
