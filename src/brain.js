const SUPPORTED_INTENTS = [
  "BUY",
  "SELL",
  "COST",
  "CORRECTION",
  "START",
  "STOP",
  "QUERY",
  "UNKNOWN",
];

const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";

function normalizeIntent(value) {
  return SUPPORTED_INTENTS.includes(value) ? value : "UNKNOWN";
}

function fallbackUnavailable(rawText, reason) {
  return {
    ok: false,
    unavailable: true,
    reason,
    parsed: {
      intent: "UNKNOWN",
      quantity_usdt: null,
      rate_bdt: null,
      amount_bdt: null,
      payment_method: null,
      settlement_method: null,
      correction_target: null,
      confidence: 0,
      missing_fields: [],
      clarification: "AI parsing is temporarily unavailable. Use manual commands.",
      raw_text: rawText,
    },
  };
}

function sanitizeParsedShape(input, rawText) {
  const parsed = input && typeof input === "object" ? input : {};
  const confidence = Number(parsed.confidence);
  return {
    intent: normalizeIntent(parsed.intent),
    quantity_usdt: parsed.quantity_usdt ?? null,
    rate_bdt: parsed.rate_bdt ?? null,
    amount_bdt: parsed.amount_bdt ?? null,
    payment_method: parsed.payment_method ?? null,
    settlement_method: parsed.settlement_method ?? null,
    correction_target: parsed.correction_target ?? null,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    missing_fields: Array.isArray(parsed.missing_fields) ? parsed.missing_fields : [],
    clarification: typeof parsed.clarification === "string" ? parsed.clarification.trim() : "",
    raw_text: typeof parsed.raw_text === "string" ? parsed.raw_text : rawText,
  };
}

function parseModelTextAsJson(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function extractOutputText(responseJson) {
  if (!responseJson || typeof responseJson !== "object") return "";
  if (typeof responseJson.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text;
  }
  const output = Array.isArray(responseJson.output) ? responseJson.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "output_text" && typeof part?.text === "string") {
        return part.text;
      }
    }
  }
  return "";
}

export async function interpretTradeText(rawText, { signal } = {}) {
  const text = String(rawText ?? "").trim();
  if (!text) {
    return fallbackUnavailable(text, "empty_input");
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return fallbackUnavailable(text, "missing_openai_api_key");
  }

  const model = process.env.OPENAI_MODEL;
  if (!model) {
    return fallbackUnavailable(text, "missing_openai_model");
  }

  const instructions = [
    "You are a multilingual trade-message interpreter for Bengali accountants.",
    "Interpret only; never invent financial values.",
    "Support English, Banglish, Bangla, broken grammar.",
    "Return strict JSON object only with keys:",
    "intent, quantity_usdt, rate_bdt, amount_bdt, payment_method, settlement_method, correction_target, confidence, missing_fields, clarification, raw_text",
    "intent must be one of BUY, SELL, COST, CORRECTION, START, STOP, QUERY, UNKNOWN.",
    "If any financially critical field is missing, fill missing_fields and provide one short clarification question.",
    "Do not execute actions, do not mutate accounting state.",
  ].join(" ");

  let response;
  try {
    response = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text,
        instructions,
        max_output_tokens: 400,
      }),
    });
  } catch {
    return fallbackUnavailable(text, "openai_network_error");
  }

  if (!response.ok) {
    return fallbackUnavailable(text, `openai_http_${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return fallbackUnavailable(text, "openai_invalid_json");
  }

  const outputText = extractOutputText(payload);
  const parsed = parseModelTextAsJson(outputText);
  if (!parsed) {
    return fallbackUnavailable(text, "openai_unparseable_output");
  }

  return {
    ok: true,
    unavailable: false,
    reason: null,
    parsed: sanitizeParsedShape(parsed, text),
  };
}
