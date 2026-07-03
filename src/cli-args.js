import fs from "node:fs";
import { parseArgs } from "node:util";

export const DEFAULT_SYSTEM_PROMPT = "Du bist ein hilfreicher KI-Assistent.";
export const DEFAULT_MAX_TOKENS = 2000;
export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_MAX_HISTORY_TURNS = 20;

function normalizeArgs(args) {
  const normalized = [];

  for (let i = 0; i < args.length; i++) {
    const current = args[i];
    const next = args[i + 1];

    if ((current === "-p" || current === "--profile") && ["-list", "--list", "list"].includes(next)) {
      normalized.push("--profile=list");
      i += 1;
      continue;
    }

    normalized.push(current);
  }

  return normalized;
}

function parseNumberOption(name, value, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (value == null) return null;

  const numberValue = Number(value);
  const invalidNumber = !Number.isFinite(numberValue);
  const invalidInteger = integer && !Number.isInteger(numberValue);
  const outOfRange = numberValue < min || numberValue > max;

  if (invalidNumber || invalidInteger || outOfRange) {
    const rangeLabel = Number.isFinite(min) && Number.isFinite(max)
      ? ` zwischen ${min} und ${max}`
      : Number.isFinite(min)
        ? ` >= ${min}`
        : "";
    throw new Error(`Ungueltiger Wert fuer --${name}: ${value}${rangeLabel}`);
  }

  return numberValue;
}

function normalizeStopSequences(values) {
  if (values == null) return [];
  const list = Array.isArray(values) ? values : [values];
  return list
    .map((value) => String(value))
    .filter((value) => value.length > 0);
}

function readSystemFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch (err) {
    throw new Error(`System-Prompt Datei konnte nicht gelesen werden: ${filePath} (${err.message})`);
  }
}

function resolveSystemPrompt(values) {
  if (values["system-file"] != null) {
    return readSystemFile(values["system-file"]);
  }
  return values.system ?? DEFAULT_SYSTEM_PROMPT;
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  let parsed;

  try {
    parsed = parseArgs({
      args: normalizeArgs(argv),
      allowPositionals: false,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        model: { type: "string", short: "m" },
        profile: { type: "string", short: "p" },
        region: { type: "string", short: "r" },
        system: { type: "string", short: "s" },
        "system-file": { type: "string" },
        "max-tokens": { type: "string" },
        temperature: { type: "string" },
        "top-p": { type: "string" },
        stop: { type: "string", multiple: true },
        "max-turns": { type: "string" },
        resume: { type: "boolean" },
        "no-save": { type: "boolean" },
        debug: { type: "boolean" }
      }
    });
  } catch (err) {
    throw new Error(`Ungueltige Argumente: ${err.message}`);
  }

  const values = parsed.values;
  const maxTokens = parseNumberOption("max-tokens", values["max-tokens"], {
    min: 1,
    integer: true
  }) ?? DEFAULT_MAX_TOKENS;
  const temperature = parseNumberOption("temperature", values.temperature, {
    min: 0,
    max: 1
  }) ?? DEFAULT_TEMPERATURE;
  const topP = parseNumberOption("top-p", values["top-p"], {
    min: 0,
    max: 1
  });
  const maxTurns = parseNumberOption("max-turns", values["max-turns"], {
    min: 0,
    integer: true
  }) ?? DEFAULT_MAX_HISTORY_TURNS;
  const stopSequences = normalizeStopSequences(values.stop);
  const inferenceOverrides = {
    ...(values["max-tokens"] != null && { maxTokens }),
    ...(values.temperature != null && { temperature }),
    ...(values["top-p"] != null && { topP }),
    ...(stopSequences.length ? { stopSequences } : {})
  };

  return {
    help: Boolean(values.help),
    version: Boolean(values.version),
    model: values.model ?? null,
    profile: values.profile ?? null,
    region: values.region ?? null,
    system: resolveSystemPrompt(values),
    maxTokens,
    temperature,
    topP,
    stopSequences,
    maxTurns,
    resume: Boolean(values.resume),
    noSave: Boolean(values["no-save"]),
    debug: Boolean(values.debug),
    inferenceOverrides
  };
}
