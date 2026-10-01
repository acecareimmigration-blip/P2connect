import { interpretTradeText } from "./brain.js";

const INTENTS = new Set(["BUY", "SELL", "COST", "CORRECTION", "START", "STOP", "QUERY", "UNKNOWN"]);
const PAYMENT_ALIASES = {
  bank: "BankTransfer",
  banktransfer: "BankTransfer",
  bkashmerchant: "BkashMerchant",
  bkashagent: "BkashAgent",
  nagadagent: "NagadAgent",
  bkashpersonal: "BkashPersonal",
  nagadpersonal: "NagadPersonal",
};
const SETTLEMENT_ALIASES = {
  bank: "Bank",
  bkash: "Bkash",
  nagad: "Nagad",
};

function toPositiveNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return n;
}

function normalizePayment(value) {
  if (!value) return null;
  const key = String(value).toLowerCase().replace(/[^a-z]/g, "");
  return PAYMENT_ALIASES[key] ?? value;
}

function getAmbiguousPaymentPrompt(value) {
  if (!value) return null;
  const key = String(value).toLowerCase().replace(/[^a-z]/g, "");
  if (key === "nagad") return "Nagad Agent or Personal?";
  if (key === "bkash") return "bKash Merchant, Agent or Personal?";
  return null;
}

function normalizeSettlement(value) {
  if (!value) return null;
  const key = String(value).toLowerCase().replace(/[^a-z]/g, "");
  return SETTLEMENT_ALIASES[key] ?? value;
}

function validateCore(parsed) {
  const intent = INTENTS.has(parsed.intent) ? parsed.intent : "UNKNOWN";
  const quantity = toPositiveNumber(parsed.quantity_usdt);
  const rate = toPositiveNumber(parsed.rate_bdt);
  const amount = toPositiveNumber(parsed.amount_bdt);

  const missing = new Set(Array.isArray(parsed.missing_fields) ? parsed.missing_fields : []);
  const result = {
    ...parsed,
    intent,
    quantity_usdt: quantity,
    rate_bdt: rate,
    amount_bdt: amount,
    payment_method: normalizePayment(parsed.payment_method),
    settlement_method: normalizeSettlement(parsed.settlement_method),
    confirmation_state: "PENDING",
    confirmable: false,
    bdt_value: null,
    missing_fields: [],
  };

  if (intent === "BUY" || intent === "SELL") {
    if (!quantity) missing.add("quantity_usdt");
    if (!rate) missing.add("rate_bdt");
    if (quantity && rate) {
      result.bdt_value = quantity * rate;
      result.confirmable = Number.isFinite(result.bdt_value) && result.bdt_value > 0;
    }
  }

  const ambiguousPrompt = getAmbiguousPaymentPrompt(parsed.payment_method);
  if (ambiguousPrompt) {
    result.payment_method = null;
    missing.add("payment_method");
    result.clarification = ambiguousPrompt;
  }

  if (intent === "COST" && !amount) {
    missing.add("amount_bdt");
  }

  if (intent === "CORRECTION" && !parsed.correction_target) {
    missing.add("correction_target");
  }

  result.missing_fields = [...missing];
  if (result.missing_fields.length > 0 && !result.clarification) {
    result.clarification = "Please provide missing fields to continue.";
  }

  return result;
}

export function buildPendingPreview(cycleId, parsed) {
  const valueLine = parsed.bdt_value
    ? parsed.bdt_value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "N/A";

  return [
    `${cycleId || "ACxxxx"} — PENDING`,
    `${parsed.intent} ${parsed.quantity_usdt ?? "?"} USDT`,
    `RATE ৳${parsed.rate_bdt ?? "?"}`,
    `VALUE ৳${valueLine}`,
    `METHOD ${parsed.payment_method || "Unknown"}`,
    "Nothing has been recorded yet.",
  ].join("\n");
}

export async function parseTradeMessage(rawText, options = {}) {
  const ai = await interpretTradeText(rawText, options);
  const validated = validateCore(ai.parsed);

  return {
    ...ai,
    parsed: validated,
    confirmation: {
      state: "PENDING",
      ledger_write_allowed: false,
      allowed_actions: ["✅ CONFIRM", "✏️ CORRECT", "❌ CANCEL"],
    },
  };
}

export function parseTradeMessageFromAI(rawText, aiParsed) {
  const validated = validateCore({ ...(aiParsed || {}), raw_text: rawText });
  return {
    parsed: validated,
    confirmation: {
      state: "PENDING",
      ledger_write_allowed: false,
      allowed_actions: ["✅ CONFIRM", "✏️ CORRECT", "❌ CANCEL"],
    },
  };
}
