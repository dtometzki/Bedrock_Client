import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { awsLoginCommand, getCommandErrorText, isExpiredAwsSession } from "./aws-context.js";

const execFileAsync = promisify(execFile);
import { ANSI, formatInteger, formatLatency, formatUsd, terminalLine } from "./ui.js";

// Eingebaute Fallback-Preise (USD pro 1 Mio. Tokens) fuer die Session-Kostenschaetzung.
// Diese Tabelle veraltet, sobald AWS/Anthropic ihre Preise aendern. Bevorzugt wird
// immer `pricingUsdPer1M` aus models.json; nur ohne diese Angabe greift die Tabelle.
// Modelle ohne Treffer zeigen "n/a" statt einer geschaetzten Kostenangabe.
//
// Stand: 2026-06 (Amazon Bedrock On-Demand, Text-Tokens).
// Quelle: https://aws.amazon.com/bedrock/pricing/
export const DEFAULT_MODEL_PRICING_UPDATED = "2026-06";
const DEFAULT_MODEL_PRICING_USD_PER_1M = [
  { pattern: /anthropic\.claude-sonnet-4/i, input: 3, output: 15 },
  { pattern: /anthropic\.claude-opus-4[-.](?:[5-9]|\d{2,})/i, input: 5, output: 25 },
  { pattern: /anthropic\.claude-opus-4/i, input: 15, output: 75 },
  { pattern: /minimax\.minimax-m2\.5/i, input: 0.36, output: 1.44 },
  { pattern: /minimax\.minimax-m2/i, input: 0.36, output: 1.44 }
];

export function getModelPricing(model) {
  const configuredPricing = model?.pricingUsdPer1M || model?.priceUsdPer1M;
  if (configuredPricing?.input != null && configuredPricing?.output != null) {
    return {
      input: Number(configuredPricing.input),
      output: Number(configuredPricing.output),
      source: configuredPricing.source || "models.json"
    };
  }

  const modelKey = `${model?.id || ""} ${model?.label || ""}`;
  const fallback = DEFAULT_MODEL_PRICING_USD_PER_1M.find(({ pattern }) => pattern.test(modelKey));
  if (!fallback) return null;

  return {
    input: fallback.input,
    output: fallback.output,
    source: `integrierte Preistabelle (Stand ${DEFAULT_MODEL_PRICING_UPDATED})`
  };
}

export function emptyUsageTotals() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    byModel: new Map(),
    last: null
  };
}

export function calculateUsageCost(usage, pricing) {
  if (!pricing) return null;
  const inputTokens = Number(usage?.inputTokens || 0);
  const outputTokens = Number(usage?.outputTokens || 0);
  return ((inputTokens / 1_000_000) * pricing.input) + ((outputTokens / 1_000_000) * pricing.output);
}

export function addUsageRecord(usageTotals, { model, usage, metrics }) {
  const pricing = getModelPricing(model);
  const inputTokens = Number(usage?.inputTokens || 0);
  const outputTokens = Number(usage?.outputTokens || 0);
  const totalTokens = Number(usage?.totalTokens || inputTokens + outputTokens);
  const costUsd = calculateUsageCost(usage, pricing);
  const modelLabel = model?.label || model?.id || "unbekannt";

  const record = {
    modelId: model?.id || "",
    modelLabel,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    pricing,
    latencyMs: metrics?.latencyMs
  };

  usageTotals.requests += 1;
  usageTotals.inputTokens += inputTokens;
  usageTotals.outputTokens += outputTokens;
  usageTotals.totalTokens += totalTokens;
  if (costUsd != null) {
    usageTotals.costUsd += costUsd;
  }
  usageTotals.last = record;

  const modelTotals = usageTotals.byModel.get(modelLabel) || {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    hasUnknownCost: false
  };
  modelTotals.requests += 1;
  modelTotals.inputTokens += inputTokens;
  modelTotals.outputTokens += outputTokens;
  modelTotals.totalTokens += totalTokens;
  if (costUsd == null) {
    modelTotals.hasUnknownCost = true;
  } else {
    modelTotals.costUsd += costUsd;
  }
  usageTotals.byModel.set(modelLabel, modelTotals);

  return record;
}

function formatDateYmd(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCurrentBillingPeriod() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now);
  end.setDate(end.getDate() + 1);

  return {
    start: formatDateYmd(start),
    end: formatDateYmd(end),
    label: `${formatDateYmd(start)} bis ${formatDateYmd(end)} (exklusiv)`
  };
}

export async function loadCurrentBedrockBillingCost() {
  const period = getCurrentBillingPeriod();

  try {
    const { stdout: dimensionJson } = await execFileAsync("aws", [
      "ce",
      "get-dimension-values",
      "--time-period",
      `Start=${period.start},End=${period.end}`,
      "--dimension",
      "SERVICE",
      "--search-string",
      "Bedrock",
      "--region",
      "us-east-1",
      "--output",
      "json"
    ], {
      encoding: "utf8",
      timeout: 15000
    });
    const dimensionValues = JSON.parse(dimensionJson).DimensionValues || [];
    const serviceNames = dimensionValues
      .map((dimension) => dimension.Value)
      .filter(Boolean);

    if (!serviceNames.length) {
      return {
        amount: 0,
        unit: "USD",
        estimated: false,
        period,
        serviceNames: []
      };
    }

    const filter = JSON.stringify({
      Dimensions: {
        Key: "SERVICE",
        Values: serviceNames
      }
    });
    const { stdout: billingJson } = await execFileAsync("aws", [
      "ce",
      "get-cost-and-usage",
      "--time-period",
      `Start=${period.start},End=${period.end}`,
      "--granularity",
      "MONTHLY",
      "--metrics",
      "UnblendedCost",
      "--filter",
      filter,
      "--region",
      "us-east-1",
      "--output",
      "json"
    ], {
      encoding: "utf8",
      timeout: 15000
    });

    const parsed = JSON.parse(billingJson);
    const result = parsed.ResultsByTime?.[0];
    const amount = Number(result?.Total?.UnblendedCost?.Amount || 0);
    const unit = result?.Total?.UnblendedCost?.Unit || "USD";

    return {
      amount,
      unit,
      estimated: Boolean(result?.Estimated),
      period,
      serviceNames
    };
  } catch (err) {
    const errorText = getCommandErrorText(err);
    if (isExpiredAwsSession(errorText)) {
      return {
        error: `AWS Session abgelaufen. Bitte neu anmelden: ${awsLoginCommand()}`,
        period
      };
    }

    return {
      error: errorText.trim() || "AWS Billing konnte nicht gelesen werden.",
      period
    };
  }
}

export async function printBillingCost() {
  const billing = await loadCurrentBedrockBillingCost();
  console.log(`${ANSI.green}AWS Billing:${ANSI.reset} Bedrock, aktueller Monat`);

  if (billing.error) {
    console.log("  Kosten: n/a");
    console.log(`  Zeitraum: ${billing.period.label}`);
    console.log(`  Hinweis: ${billing.error.split("\n")[0]}`);
    return;
  }

  const suffix = billing.estimated ? " (AWS Estimated)" : "";
  console.log(`  Kosten: ${formatUsd(billing.amount)} ${billing.unit}${suffix}`);
  console.log(`  Zeitraum: ${billing.period.label}`);
  if (billing.serviceNames?.length) {
    console.log(`  Services: ${billing.serviceNames.join(", ")}`);
  }
}

export function printUsageRecord(record) {
  if (!record) {
    console.log(`${ANSI.gray}Noch keine Bedrock-Nutzung in dieser Session.${ANSI.reset}`);
    return;
  }

  console.log(`${ANSI.green}Letzte Antwort:${ANSI.reset} ${record.modelLabel}`);
  console.log(`  Input:  ${formatInteger(record.inputTokens)} Tokens`);
  console.log(`  Output: ${formatInteger(record.outputTokens)} Tokens`);
  console.log(`  Gesamt: ${formatInteger(record.totalTokens)} Tokens`);
  console.log(`  Session-Schaetzung: ${formatUsd(record.costUsd)}`);
  console.log(`  Latenz: ${formatLatency(record.latencyMs)}`);
}

export async function printUsageSummary(usageTotals) {
  await printBillingCost();
  console.log("");

  if (!usageTotals.requests) {
    console.log(`${ANSI.gray}Noch keine Bedrock-Nutzung in dieser Session.${ANSI.reset}`);
    console.log(terminalLine());
    return;
  }

  printUsageRecord(usageTotals.last);
  console.log("");
  console.log(`${ANSI.green}Session:${ANSI.reset} ${formatInteger(usageTotals.requests)} Requests`);
  console.log(`  Input:  ${formatInteger(usageTotals.inputTokens)} Tokens`);
  console.log(`  Output: ${formatInteger(usageTotals.outputTokens)} Tokens`);
  console.log(`  Gesamt: ${formatInteger(usageTotals.totalTokens)} Tokens`);
  console.log(`  Session-Schaetzung: ${formatUsd(usageTotals.costUsd)}`);

  if (usageTotals.byModel.size > 1) {
    console.log("");
    console.log(`${ANSI.green}Nach Modell:${ANSI.reset}`);
    for (const [modelLabel, totals] of usageTotals.byModel.entries()) {
      const costLabel = totals.hasUnknownCost ? `${formatUsd(totals.costUsd)}+` : formatUsd(totals.costUsd);
      console.log(`  ${modelLabel}: ${formatInteger(totals.totalTokens)} Tokens, ${costLabel}`);
    }
  }

  console.log(`${ANSI.gray}Session-Kosten sind eine Token-Schaetzung; AWS Billing ist der Cost-Explorer-Wert fuer Amazon Bedrock.${ANSI.reset}`);
  console.log(terminalLine());
}
