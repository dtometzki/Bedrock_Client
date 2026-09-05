import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readSavedEffort } from "../src/config.js";
import { getSessionPath, readSession, writeSession } from "../src/session.js";
import {
  buildAttachmentBlocks,
  createBrowserBootstrap,
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

async function withTempSession(run) {
  const previous = process.env.BEDROCK_CHAT_CONFIG_DIR;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-session-errors-"));
  process.env.BEDROCK_CHAT_CONFIG_DIR = directory;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.BEDROCK_CHAT_CONFIG_DIR;
    else process.env.BEDROCK_CHAT_CONFIG_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("Ungueltige Request-URLs liefern 400 vor Auth und lassen den Server erreichbar", async () => {
  await withServer({ authToken: "test-token" }, async ({ url }) => {
    for (const requestPath of ["//", "http://["]) {
      const status = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: "127.0.0.1", port: new URL(url).port, path: requestPath
        }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 400);
    }
    assert.equal((await fetch(`${url}/api/state`)).status, 403);
    const state = await fetch(`${url}/api/state`, { headers: { "x-bedrock-token": "test-token" } });
    assert.equal(state.status, 200);
  });
});

test("Fehlerhafte Chat-Eingaben liefern 400 und sperren folgende Nachrichten nicht", async () => {
  let calls = 0;
  async function* fakeStream() {
    calls += 1;
    yield { type: "text", text: "Antwort" };
  }
  const invalidBodies = [
    "{", "null", "[]", '"text"',
    ...[
      { message: { toString: null } },
      { message: null },
      { message: 42 },
      { message: [] },
      { message: "Hallo", attachments: {} },
      { message: "Hallo", attachments: null },
      { attachments: [null] },
      { attachments: [{ name: { toString: null }, dataBase64: "eA==" }] },
      { attachments: [{ name: "x.txt", dataBase64: { toString: null } }] }
    ].map((body) => JSON.stringify(body))
  ];
  await withServer({ streamFn: fakeStream, authToken: "test-token" }, async ({ url, getState }) => {
    const headers = { "Content-Type": "application/json", "x-bedrock-token": "test-token" };
    for (const body of invalidBodies) {
      const response = await fetch(`${url}/api/chat`, { method: "POST", headers, body });
      assert.equal(response.status, 400, body);
      assert.ok((await response.json()).error);
      assert.equal(getState().busy, false);
      assert.deepEqual(getState().messages, []);
    }
    assert.equal(calls, 0);
    const response = await fetch(`${url}/api/chat`, {
      method: "POST", headers, body: JSON.stringify({ message: "Hallo" })
    });
    assert.equal(parseSseEvents(await response.text()).at(-1).failed, false);
    assert.equal(calls, 1);
    assert.equal(getState().messages.length, 2);
  });
});

test("Fehlgeschlagenes Loeschen meldet Fehler und behaelt Verlauf bis zum erfolgreichen Retry", async (t) => {
  await withTempSession(async () => {
    const messages = [{ role: "user", content: [{ text: "Privater Verlauf" }] }];
    assert.equal(writeSession(messages), true);
    const originalRm = fs.rmSync;
    const mockRm = t.mock.method(fs, "rmSync", (target, options) => {
      if (target === getSessionPath()) throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
      return originalRm(target, options);
    });
    await withServer({ autoSave: true, messages }, async ({ url, getState }) => {
      const before = getState().messages;
      const failed = await postJson(`${url}/api/clear`);
      assert.equal(failed.response.status, 500);
      assert.match(failed.data.error, /nicht geloescht/);
      assert.deepEqual(getState().messages, before);
      assert.deepEqual(readSession().messages, messages);

      mockRm.mock.restore();
      const cleared = await postJson(`${url}/api/clear`);
      assert.equal(cleared.response.status, 200);
      assert.deepEqual(getState().messages, []);
      assert.equal(fs.existsSync(getSessionPath()), false);
    });
  });
});

test("Speicherfehler warnen ohne erfolgreiche Antwort zu verwerfen; erneutes Speichern funktioniert", async (t) => {
  await withTempSession(async () => {
    const messages = [
      { role: "user", content: [{ text: "Frage" }] },
      { role: "assistant", content: [{ text: "Antwort" }] }
    ];
    assert.equal(writeSession(messages), true);
    const originalRename = fs.renameSync;
    const mockRename = t.mock.method(fs, "renameSync", (source, target) => {
      if (target === getSessionPath()) throw Object.assign(new Error("No space left"), { code: "ENOSPC" });
      return originalRename(source, target);
    });
    async function* fakeStream() {
      yield { type: "text", text: "Neue Antwort" };
    }
    await withServer({ autoSave: true, messages, streamFn: fakeStream }, async ({ url, getState }) => {
      const response = await fetch(`${url}/api/chat`, {
        method: "POST", body: JSON.stringify({ message: "Weitere Frage" })
      });
      const done = parseSseEvents(await response.text()).at(-1);
      assert.equal(done.type, "done");
      assert.equal(done.failed, false);
      assert.match(done.warning, /nicht gespeichert/);
      assert.equal(getState().busy, false);
      assert.equal(getState().messages.length, 4);
      assert.deepEqual(readSession().messages, messages);

      mockRename.mock.restore();
      const next = await fetch(`${url}/api/chat`, {
        method: "POST", body: JSON.stringify({ message: "Noch eine Frage" })
      });
      assert.equal(parseSseEvents(await next.text()).at(-1).warning, undefined);
      assert.equal(readSession().messages.length, 6);
    });
  });
});

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

test("POST /api/chat ruft ARN-Regionen mit einem passenden Client auf", async () => {
  const usModel = {
    id: "us.anthropic.claude-sonnet-5",
    label: "Sonnet 5",
    profileArn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-5"
  };
  const baseClient = { tag: "base" };
  const createdRegions = [];
  function createClient({ region }) {
    createdRegions.push(region);
    return { tag: `regional:${region}` };
  }
  let usedClient;
  async function* fakeStream(client, params) {
    usedClient = client;
    void params;
    yield { type: "text", text: "ok" };
  }

  await withServer({
    models: [usModel],
    model: usModel,
    client: baseClient,
    region: "eu-central-1",
    createClient,
    streamFn: fakeStream
  }, async ({ url }) => {
    await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hallo" })
    }).then((res) => res.text());
  });

  // Der us-east-1-ARN darf nicht gegen den eu-central-1-Endpoint laufen.
  assert.deepEqual(createdRegions, ["us-east-1"]);
  assert.deepEqual(usedClient, { tag: "regional:us-east-1" });
});

test("POST /api/chat ruft ein us.-Inference-Profil aus einer EU-Umgebung in einer US-Region auf", async () => {
  const usModel = { id: "us.anthropic.claude-sonnet-5", label: "Sonnet 5" };
  const createdRegions = [];
  function createClient({ region }) {
    createdRegions.push(region);
    return { tag: `regional:${region}` };
  }
  let usedClient;
  async function* fakeStream(client, params) {
    usedClient = client;
    void params;
    yield { type: "text", text: "ok" };
  }

  await withServer({
    models: [usModel],
    model: usModel,
    client: { tag: "base" },
    region: "eu-central-1",
    createClient,
    streamFn: fakeStream
  }, async ({ url }) => {
    await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hallo" })
    }).then((res) => res.text());
  });

  // Ein us.-Profil darf nicht gegen den eu-central-1-Endpoint laufen.
  assert.deepEqual(createdRegions, ["us-east-1"]);
  assert.deepEqual(usedClient, { tag: "regional:us-east-1" });
});

test("POST /api/chat nutzt den Basis-Client ohne abweichende ARN-Region", async () => {
  const plainModel = { id: "global.anthropic.claude-sonnet-4-6", label: "Sonnet 4.6" };
  const baseClient = { tag: "base" };
  let createClientCalled = false;
  function createClient() {
    createClientCalled = true;
    return { tag: "regional" };
  }
  let usedClient;
  async function* fakeStream(client) {
    usedClient = client;
    yield { type: "text", text: "ok" };
  }

  await withServer({
    models: [plainModel],
    model: plainModel,
    client: baseClient,
    region: "eu-central-1",
    createClient,
    streamFn: fakeStream
  }, async ({ url }) => {
    await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hallo" })
    }).then((res) => res.text());
  });

  assert.equal(createClientCalled, false);
  assert.deepEqual(usedClient, { tag: "base" });
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

test("GET / setzt eine strikte Content-Security-Policy ohne unsafe-inline-Skripte", async () => {
  await withServer({}, async ({ url }) => {
    const response = await fetch(`${url}/`);
    const csp = response.headers.get("content-security-policy");
    // script-src 'self' ohne 'unsafe-inline' blockiert injizierte
    // Inline-Skripte selbst dann, wenn ein Sanitizer-Bypass Markup in eine
    // gerenderte Antwort schmuggelt.
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
    // Kein pauschales https: in img-src – Remote-Bilder waeren ein
    // Exfiltrationskanal fuer Prompt-Injection.
    assert.match(csp, /img-src 'self' data:/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    // Die Seite darf keine CDN-Skripte mehr referenzieren; alles kommt lokal.
    const html = await response.text();
    assert.ok(!html.includes("cdnjs.cloudflare.com"));
    assert.ok(!html.includes("http-equiv=\"Content-Security-Policy\""));
  });
});

test("GET /app.js und /vendor-Skripte werden lokal ausgeliefert", async () => {
  await withServer({}, async ({ url }) => {
    for (const route of ["/app.js", "/vendor/marked.min.js", "/vendor/purify.min.js"]) {
      const response = await fetch(`${url}${route}`);
      assert.equal(response.status, 200, `${route} sollte 200 liefern`);
      assert.match(response.headers.get("content-type"), /text\/javascript/);
    }
    const app = await fetch(`${url}/app.js`).then((res) => res.text());
    const allowedTagsSource = app.match(
      /const MARKDOWN_ALLOWED_TAGS = Object\.freeze\((\[[\s\S]*?\])\);/
    );
    const allowedAttrsSource = app.match(
      /const MARKDOWN_ALLOWED_ATTRS = Object\.freeze\((\[[\s\S]*?\])\);/
    );
    assert.ok(allowedTagsSource, "Markdown-Tag-Allowlist erwartet");
    assert.ok(allowedAttrsSource, "Markdown-Attribut-Allowlist erwartet");
    const allowedTags = JSON.parse(allowedTagsSource[1]);
    const allowedAttrs = JSON.parse(allowedAttrsSource[1]);
    assert.ok(!allowedTags.some((tag) => ["style", "form", "input", "button"].includes(tag)));
    assert.ok(!allowedAttrs.includes("style"));
    assert.match(app, /ALLOWED_TAGS: MARKDOWN_ALLOWED_TAGS/);
    assert.match(app, /ALLOWED_ATTR: MARKDOWN_ALLOWED_ATTRS/);
    assert.match(app, /location\.hash/);
    assert.match(app, /cleanUrl\.hash = ""/);

    const purify = await fetch(`${url}/vendor/purify.min.js`).then((res) => res.text());
    // DOMPurify muss eine Version mit dem Fix fuer CVE-2026-0540 sein
    // (>= 3.3.2); die 3.1.x vom frueheren CDN-Stand war verwundbar.
    const version = purify.match(/DOMPurify (\d+)\.(\d+)\.(\d+)/);
    assert.ok(version, "Versions-Banner in purify.min.js erwartet");
    const [major, minor, patch] = version.slice(1).map(Number);
    assert.ok(
      major > 3 || (major === 3 && (minor > 3 || (minor === 3 && patch >= 2))),
      `DOMPurify ${major}.${minor}.${patch} ist aelter als 3.3.2`
    );
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
    assert.match(data.billing.error, /AWS-Anmeldung oder Verbindung fehlgeschlagen/);
    assert.ok(!data.billing.error.includes("Cost Explorer nicht erreichbar"));
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

test("createBrowserBootstrap verbirgt das Token in einer privaten temporaeren Datei", {
  skip: process.platform === "win32"
}, (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-bootstrap-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const bootstrap = createBrowserBootstrap("http://127.0.0.1:3456", "geheim", { tempRoot });
  const bootstrapDir = path.dirname(bootstrap.path);
  const html = fs.readFileSync(bootstrap.path, "utf8");

  assert.equal(fs.statSync(bootstrapDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(bootstrap.path).mode & 0o777, 0o600);
  assert.match(html, /http:\/\/127\.0\.0\.1:3456\/#token=geheim/);
  assert.ok(!html.includes("<script"));

  bootstrap.cleanup();
  bootstrap.cleanup();
  assert.equal(fs.existsSync(bootstrapDir), false);
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
  assert.equal(isTokenValid(req, ""), true);
});

test("isTokenValid akzeptiert Token nur via Header, nicht via Query", () => {
  assert.equal(isTokenValid({ headers: { "x-bedrock-token": "geheim" } }, "geheim"), true);
  assert.equal(isTokenValid({ headers: {} }, "geheim"), false);
  assert.equal(isTokenValid({ headers: { "x-bedrock-token": "falsch" } }, "geheim"), false);
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

    // Der Query-Parameter wird serverseitig nicht mehr akzeptiert (Tokens in
    // URLs landen in Logs); nur der Header authentifiziert.
    const deniedQuery = await fetch(`${url}/api/state?token=${authToken}`);
    assert.equal(deniedQuery.status, 403);

    // Die statischen GUI-Dateien (HTML/JS ohne Geheimnisse) bleiben ohne Token
    // erreichbar: die Index-Seite fuer den Reload nach dem Entfernen des Tokens
    // aus der URL, die Skripte, weil <script src> keinen Token-Header mitsendet.
    // Alle API-Routen verlangen weiterhin das Token.
    for (const route of ["/", "/app.js", "/vendor/marked.min.js", "/vendor/purify.min.js"]) {
      const withoutToken = await fetch(`${url}${route}`);
      assert.notEqual(withoutToken.status, 403, `${route} sollte ohne Token erreichbar sein`);
    }

    const abortDenied = await fetch(`${url}/api/abort`, { method: "POST" });
    assert.equal(abortDenied.status, 403);
  } finally {
    server.close();
  }
});
