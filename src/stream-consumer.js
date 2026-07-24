import { isAbortError } from "./bedrock.js";
import { addUsageRecord } from "./usage.js";

// Konsumiert einen Converse-Event-Stream (streamConverseWithRetry) und sammelt
// Antworttext, Nutzungsdaten und Endstatus. Gemeinsam genutzt von CLI (app.js)
// und Web-Server (web-server.js), damit Event-Klassifizierung, Fehler-/Abbruch-
// Unterscheidung und Usage-Buchhaltung nicht auseinanderdriften. Die Ausgabe
// unterscheidet sich je Frontend und wird ueber die Callbacks onText,
// onReasoning und onRetry angeschlossen (Terminal vs. SSE).
//
// Rueckgabe:
//   fullResponse  roher Antworttext (unformatiert; Aufrufer sanitizen bei Bedarf)
//   usageRecord   letzter Usage-Datensatz oder null
//   aborted       true bei Nutzer-Abbruch (Teilantwort liegt in fullResponse)
//   error         Fehlerobjekt bei Nicht-Abbruch-Fehlern, sonst null
export async function consumeConverseStream(stream, {
  usageTotals = null,
  model = null,
  abortSignal = null,
  onText = null,
  onReasoning = null,
  onRetry = null
} = {}) {
  let fullResponse = "";
  let usageRecord = null;
  let aborted = false;
  let error = null;

  try {
    for await (const event of stream) {
      if (event.type === "retry") {
        onRetry?.(event);
        continue;
      }
      if (event.type === "usage") {
        if (usageTotals) {
          usageRecord = addUsageRecord(usageTotals, {
            model,
            usage: event.usage,
            metrics: event.metrics
          });
        }
        continue;
      }
      if (event.type === "reasoning") {
        onReasoning?.(event.text);
        continue;
      }
      fullResponse += event.text;
      onText?.(event.text);
    }
  } catch (err) {
    if (isAbortError(err) || abortSignal?.aborted) {
      aborted = true;
    } else {
      error = err;
    }
  }

  return { fullResponse, usageRecord, aborted, error };
}
