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

function parseScaledNumber(token) {
  if (!token) return null;
  const m=String(token).toLowerCase().replace(/,/g, '').match(/^([0-9]+(?:\.[0-9]+)?)(k|l)?$/);
  if (!m) return null;
  const base=Number(m[1]);
  return m[2] === 'k' ? base*1000 : m[2] === 'l' ? base*100000 : base;
}

function parseDeterministicTradeText(rawText) {
  const raw=String(rawText || '').trim();
  const t=raw.toLowerCase();
  const intent=/\b(buy|bought|kinlam|kinsi|kinbo|kin)\b/.test(t)?'BUY':/\b(sell|sold|bechi|bikri|bikroy)\b/.test(t)?'SELL':'UNKNOWN';
  const usdt=(t.match(/([0-9]+(?:\.[0-9]+)?)\s*usdt\b/)||[])[1];
  const rateMatch=t.match(/(?:at|@|rate\s*[:=]?)\s*([0-9]+(?:\.[0-9]+)?)/)||t.match(/([0-9]+(?:\.[0-9]+)?)\s*b(?:dt)?\s*\/\s*usdt/)||t.match(/b(?:dt)?\s*\/\s*usdt\s*(?:at|@)?\s*([0-9]+(?:\.[0-9]+)?)/);
  let rateVal=rateMatch?rateMatch[1]:null;
  if(!rateVal){ const nums=[...t.matchAll(/\b([0-9]{2,4}(?:\.[0-9]+)?)\b/g)].map(m=>Number(m[1])).filter(n=>n>=50&&n<=500); rateVal=nums.length?String(nums[nums.length-1]):null; }
  const money=(t.match(/(?:of|worth|amount|bdt)\s*(?:of|worth)?\s*([0-9]+(?:\.[0-9]+)?(?:k|l)?)/)||[])[1] || (t.match(/\b([0-9]+(?:\.[0-9]+)?(?:k|l))\b/)||[])[1];
  let payment=null;
  if(/bank\s*transfer|other\s*bank/.test(t)) payment='BankTransfer'; else if(/bkash\s*merchant/.test(t)) payment='BkashMerchant'; else if(/bkash\s*agent/.test(t)) payment='BkashAgent'; else if(/bkash\s*personal/.test(t)) payment='BkashPersonal'; else if(/\bbkash\b/.test(t)) payment='bkash'; else if(/nagad\s*agent/.test(t)) payment='NagadAgent'; else if(/nagad\s*personal/.test(t)) payment='NagadPersonal'; else if(/\bnagad\b/.test(t)) payment='nagad';
  return {intent,quantity_usdt:toPositiveNumber(usdt),rate_bdt:toPositiveNumber(rateVal),amount_bdt:parseScaledNumber(money),payment_method:payment,settlement_method:null,correction_target:null,confidence:intent==='UNKNOWN'?0:0.9,missing_fields:[],clarification:'',raw_text:raw};
}

function validateCore(parsed) {
  const intent = INTENTS.has(parsed.intent) ? parsed.intent : "UNKNOWN";
  let quantity = toPositiveNumber(parsed.quantity_usdt);
  const rate = toPositiveNumber(parsed.rate_bdt);
  const amount = toPositiveNumber(parsed.amount_bdt);
  if (!quantity && amount && rate && (parsed.intent === "BUY" || parsed.intent === "SELL")) quantity = amount / rate;

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
  const local = ai.unavailable ? parseDeterministicTradeText(rawText) : null;
  const validated = validateCore(local || ai.parsed);

  return {
    ...ai,
    ok: ai.unavailable ? validated.intent !== "UNKNOWN" : ai.ok,
    unavailable: ai.unavailable ? false : ai.unavailable,
    reason: ai.unavailable ? `local_fallback:${ai.reason}` : ai.reason,
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
