import assert from "node:assert/strict";
import test from "node:test";
import { ATTACHMENT_HISTORY_TURNS, limitAttachmentHistory } from "../src/web-server.js";

function userWithAttachment(text, name) {
  return {
    role: "user",
    content: [{ text }, { document: { format: "txt", name, source: { bytes: Buffer.from("x") } } }],
    attachmentNames: [name]
  };
}

function assistant(text) {
  return { role: "assistant", content: [{ text }] };
}

test("limitAttachmentHistory behaelt den juengsten Anhang als Binaerdaten", () => {
  const messages = [
    userWithAttachment("Frage 1", "alt.txt"),
    assistant("Antwort 1"),
    userWithAttachment("Frage 2", "neu.txt"),
    assistant("Antwort 2")
  ];

  const limited = limitAttachmentHistory(messages);

  assert.equal(limited[0].content.some((block) => block.document), false);
  assert.deepEqual(limited[0].content, [{ text: "Frage 1" }, { text: "[Anhang: alt.txt]" }]);
  // attachmentNames bleibt fuer die Anzeige in der GUI erhalten.
  assert.deepEqual(limited[0].attachmentNames, ["alt.txt"]);
  assert.equal(limited[2].content.some((block) => block.document), true);
});

test("limitAttachmentHistory laesst Nachrichten ohne Anhang unveraendert", () => {
  const messages = [
    { role: "user", content: [{ text: "Hallo" }] },
    assistant("Hi")
  ];

  const limited = limitAttachmentHistory(messages);

  assert.deepEqual(limited, messages);
  assert.equal(limited[0], messages[0]);
});

test("limitAttachmentHistory mit keepTurns 0 entfernt alle Binaerdaten", () => {
  const messages = [userWithAttachment("Frage", "datei.txt"), assistant("Antwort")];

  const limited = limitAttachmentHistory(messages, 0);

  assert.equal(limited[0].content.some((block) => block.document), false);
  assert.equal(ATTACHMENT_HISTORY_TURNS, 1);
});
