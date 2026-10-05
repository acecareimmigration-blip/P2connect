import { getSpotBalances } from "./binance.js";
import { recordTrade, getSummary, recordCycle, nextCycleId, saveChatMessage, getRecentChat, getActiveCycleSnapshot } from "./ledger.js";
import { buildPendingPreview, parseTradeMessage, parseTradeMessageFromAI } from "./tradeParser.js";

const METHODS = ["BankTransfer", "BkashMerchant", "BkashAgent", "NagadAgent", "BkashPersonal", "NagadPersonal"];
// Settlement is a routing label, not automatically a fee. Fees/benefits must be explicit.\nconst SETTLEMENT = { Bank: 0, Bkash: 0, Nagad: 0 };

const sessions = new Map();
const pinModes = new Set();
const pendingFinancialByChat = new Map();
const correctionModeByChat = new Set();
const confirmedByCycle = new Map();

function api(token, method, body = {}) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (response) => {
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw Error(payload.description || "Telegram error");
    return payload.result;
  });
}

function allowed(id) {
  const value = process.env.TELEGRAM_ALLOWED_CHAT_IDS || "";
  return !value.trim() || value.split(",").map((part) => part.trim()).includes(String(id));
}

function amount(value) {
  const normalized = String(value).trim().toLowerCase().replace(/[৳,]/g, "");
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*(k|l|lac|lakh)?$/);
  if (!match) return NaN;
  return Number(match[1]) * (match[2] === "k" ? 1000 : ["l", "lac", "lakh"].includes(match[2]) ? 100000 : 1);
}

function capitalAndRate(value) {
  const normalized = String(value).trim().replace(/,/g, "");
  const match = normalized.match(/^(.+?)\s*(?:@|\bat\b|\brate\b)\s*৳?\s*([0-9]+(?:\.[0-9]+)?)\s*$/i);
  if (!match) return null;
  const capital = amount(match[1].replace(/^capital\s+/i, "").trim());
  const rate = Number(match[2]);
  return capital > 0 && rate > 0 ? { capital, rate } : null;
}

function directTrade(command, args) {
  const side = command === "/buy" ? "BUY" : "SELL";
  const raw = args.join(" ").trim();
  if (!raw) return null;

  const bdt = raw.match(/^(.+?)\s*(?:@|\bat\b)\s*৳?\s*([0-9]+(?:\.[0-9]+)?)\s*$/i);
  if (bdt) {
    const capital = amount(bdt[1].trim());
    const rate = Number(bdt[2]);
    if (capital > 0 && rate > 0) return { side, quantity: capital / rate, rate, note: raw };
  }

  const usdt = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:usdt)?\s*(?:@|\bat\b|\s)\s*৳?\s*([0-9]+(?:\.[0-9]+)?)\s*$/i);
  if (usdt) {
    const quantity = Number(usdt[1]);
    const rate = Number(usdt[2]);
    if (quantity > 0 && rate > 0) return { side, quantity, rate, note: raw };
  }
  return null;
}

function method(value) {
  const index = Number(value);
  if (index >= 1 && index <= 6) return METHODS[index - 1];
  const normalized = String(value).toLowerCase().replace(/[^a-z]/g, "");
  return {
    banktransfer: "BankTransfer",
    bkashmerchant: "BkashMerchant",
    bkashagent: "BkashAgent",
    nagadagent: "NagadAgent",
    bkashpersonal: "BkashPersonal",
    nagadpersonal: "NagadPersonal",
  }[normalized];
}

function benefit(paymentMethod, side, optional = false) {
  if (paymentMethod === "BankTransfer") return 0;
  if (paymentMethod === "BkashAgent" || paymentMethod === "NagadAgent") return 0.004;
  if (paymentMethod === "BkashPersonal" && side === "SELL") return 0.007;\n  if (paymentMethod === "NagadPersonal" && side === "SELL") return 0.015;
  if (paymentMethod === "BkashMerchant" && side === "SELL") return optional ? 0.018 : 0.004;
  return 0;
}

function fixed(paymentMethod, bankType) {
  return paymentMethod === "BankTransfer" && bankType === "OtherBank" ? 10 : 0;
}

function calc(data) {
  const usdt = data.capital / data.buyRate;
  const gross = usdt * data.sellRate;
  const buyBenefit = data.capital * benefit(data.buyMethod, "BUY", data.buyOptional);
  const sellBenefit = gross * benefit(data.sellMethod, "SELL", data.sellOptional);
  const buyFixed = fixed(data.buyMethod, data.buyBankType);
  const sellFixed = fixed(data.sellMethod, data.sellBankType);
  const settlementCost = gross * (SETTLEMENT[data.settlement] || 0);
  const net = gross - data.capital + buyBenefit + sellBenefit - buyFixed - sellFixed - settlementCost;
  return { usdt, gross, buyBenefit, sellBenefit, buyFixed, sellFixed, settlementCost, net, margin: net / data.capital };
}

function ready(data) {
  const x = calc(data);
  return `CYCLE READY\n\nCAPITAL: ৳${data.capital.toFixed(2)}\n\nBUY\n${data.buyMethod}${data.buyBankType ? ` (${data.buyBankType})` : ""} @ ${data.buyRate.toFixed(2)}\nUSDT acquired: ${x.usdt.toFixed(4)}\nMethod benefit: +৳${x.buyBenefit.toFixed(2)}\nFixed cost: -৳${x.buyFixed.toFixed(2)}\n\nSELL\n${data.sellMethod}${data.sellBankType ? ` (${data.sellBankType})` : ""} @ ${data.sellRate.toFixed(2)}\nGross proceeds: ৳${x.gross.toFixed(2)}\nMethod benefit: +৳${x.sellBenefit.toFixed(2)}\nFixed cost: -৳${x.sellFixed.toFixed(2)}\n\nSETTLEMENT: ${data.settlement}\nSettlement routing cost: -৳${x.settlementCost.toFixed(2)}\n\nPREDICTED NET PROFIT: ৳${x.net.toFixed(2)}\nPREDICTED RETURN: ${(x.margin * 100).toFixed(3)}%\n\nExecute manually, then record ACTUAL fills:\n/buy <USDT> <actual rate>\n/sell <USDT> <actual rate>\n\nFinish with /stoptrade`;
}

function trackConfirmedTrade(cycleId, side, quantity) {
  const qty = Number(quantity);
  if (!cycleId || !(qty > 0)) return;
  const row = confirmedByCycle.get(cycleId) || { buy: 0, sell: 0 };
  if (side === "BUY") row.buy += qty;
  if (side === "SELL") row.sell += qty;
  confirmedByCycle.set(cycleId, row);
}

function getTrackedCycleRemaining(cycleId) {
  const row = confirmedByCycle.get(cycleId);
  if (!row) return null;
  return row.buy - row.sell;
}

async function getCycleRemainingUsdt(store, cycleId) {
  if (!cycleId) return null;

  if (store.persistent && store.pool) {
    const result = await store.pool.query(
      "SELECT side, COALESCE(SUM(quantity),0) AS quantity FROM p2p_trades WHERE cycle_id=$1 AND asset='USDT' GROUP BY side",
      [cycleId],
    );
    const buy = Number(result.rows.find((row) => row.side === "BUY")?.quantity || 0);
    const sell = Number(result.rows.find((row) => row.side === "SELL")?.quantity || 0);
    return buy - sell;
  }

  return getTrackedCycleRemaining(cycleId);
}

function sellRestRequested(text) {
  const normalized = String(text || "").toLowerCase();
  return /\bsell\s+rest\b/.test(normalized) || /\bsell\s+remaining\b/.test(normalized);
}

function mergePendingParsed(existingParsed, nextParsed) {
  const merged = { ...(existingParsed || {}) };
  const candidate = nextParsed || {};

  if (candidate.intent === "BUY" || candidate.intent === "SELL") {
    merged.intent = candidate.intent;
  }

  const overrideFields = [
    "quantity_usdt",
    "rate_bdt",
    "amount_bdt",
    "payment_method",
    "settlement_method",
    "correction_target",
  ];

  for (const field of overrideFields) {
    const value = candidate[field];
    if (value !== null && value !== undefined && value !== "") {
      merged[field] = value;
    }
  }

  return merged;
}

function oneClarificationQuestion(parsed) {
  if (parsed?.clarification) return parsed.clarification;
  const missing = Array.isArray(parsed?.missing_fields) ? parsed.missing_fields : [];
  if (missing.includes("payment_method")) {
    return "Which payment method? (BankTransfer / bKash Merchant-Agent-Personal / Nagad Agent-Personal)";
  }
  if (missing.includes("quantity_usdt")) return "How much USDT?";
  if (missing.includes("rate_bdt")) return "What rate (BDT/USDT)?";
  if (missing.includes("amount_bdt")) return "What amount in BDT?";
  if (missing.includes("correction_target")) return "Which previous trade should be corrected?";
  return "Please provide the missing transaction detail.";
}

function composePendingRaw(existingRaw, nextText) {
  const previous = String(existingRaw || "").trim();
  const current = String(nextText || "").trim();
  if (!previous) return current;
  if (!current) return previous;
  return `${previous} | ${current}`;
}

function hasMissing(parsed) {
  return Array.isArray(parsed?.missing_fields) && parsed.missing_fields.length > 0;
}

async function sendPendingPreview(chatId, send, cycleId, parsed) {
  const preview = buildPendingPreview(cycleId || "NO ACTIVE CYCLE", parsed);
  await send(chatId, preview, {
    inline_keyboard: [[
      { text: "✅ CONFIRM", callback_data: "p2p_confirm" },
      { text: "✏️ CORRECT", callback_data: "p2p_correct" },
      { text: "❌ CANCEL", callback_data: "p2p_cancel" },
    ]],
  });
}

async function parseAndMaybeMergePending(chatId, text, send, store) {
  const key = String(chatId);
  const existingPending = pendingFinancialByChat.get(key);
  const correctionMode = correctionModeByChat.has(key);
  const activeSession = sessions.get(key);
  const activeCycleId = activeSession?.data?.cycleId || existingPending?.cycleId || null;

  const canContinue = Boolean(existingPending && (correctionMode || hasMissing(existingPending.parsed)));
  if (existingPending && !canContinue) {
    await send(chatId, "You already have a pending transaction. Use ✅ CONFIRM, ✏️ CORRECT, or ❌ CANCEL.");
    return true;
  }

  const brain = await parseTradeMessage(text);
  if (!brain.ok) {
    console.error(`[P2P_BRAIN] parse_unavailable chat=${chatId} reason=${brain.reason || "unknown"}`);
    await send(chatId, "AI parsing is temporarily unavailable. Use manual /buy and /sell commands.");
    return true;
  }

  let parsed = brain.parsed;
  let pendingCycleId = activeCycleId;
  let rawText = text;

  if (canContinue) {
    const merged = mergePendingParsed(existingPending.parsed, parsed);
    rawText = composePendingRaw(existingPending.raw_text, text);
    parsed = parseTradeMessageFromAI(rawText, merged).parsed;
    pendingCycleId = existingPending.cycleId || activeCycleId;
  }

  if (parsed.intent === "SELL" && (!parsed.quantity_usdt || parsed.missing_fields.includes("quantity_usdt")) && sellRestRequested(text)) {
    if (!pendingCycleId) {
      await send(chatId, "NO ACTIVE CYCLE. Start a cycle before using sell rest.");
      return true;
    }

    const remaining = await getCycleRemainingUsdt(store, pendingCycleId);
    if (!(Number.isFinite(remaining) && remaining > 0)) {
      await send(chatId, "No confirmed remaining USDT is available in the active cycle.");
      return true;
    }

    parsed = parseTradeMessageFromAI(rawText, { ...parsed, quantity_usdt: remaining }).parsed;
  }

  if (parsed.intent === "COST" || parsed.intent === "CORRECTION") {
    await send(chatId, "Captured, but this requires the dedicated audit-ledger extension. Nothing has been recorded.");
    correctionModeByChat.delete(key);
    return true;
  }

  const tradeIntent = parsed.intent === "BUY" || parsed.intent === "SELL";
  if (!tradeIntent) {
    if (existingPending && canContinue) {
      await send(chatId, oneClarificationQuestion(existingPending.parsed));
      return true;
    }
    await send(chatId, parsed.clarification || "Please send a BUY/SELL message or use /help.");
    return true;
  }

  const pending = {
    parsed,
    raw_text: rawText,
    cycleId: pendingCycleId,
  };
  pendingFinancialByChat.set(key, pending);

  if (hasMissing(parsed)) {
    correctionModeByChat.delete(key);
    await send(chatId, oneClarificationQuestion(parsed));
    return true;
  }

  correctionModeByChat.delete(key);
  await sendPendingPreview(chatId, send, pendingCycleId, parsed);
  return true;
}

async function handleBrainCallback(chatId, action, send, store) {
  const key = String(chatId);
  const pending = pendingFinancialByChat.get(key);

  if (action === "p2p_cancel") {
    pendingFinancialByChat.delete(key);
    correctionModeByChat.delete(key);
    await send(chatId, "Pending transaction canceled. Nothing was recorded.");
    return true;
  }

  if (!pending) {
    await send(chatId, "No pending transaction found.");
    return true;
  }

  if (action === "p2p_correct") {
    correctionModeByChat.add(key);
    await send(chatId, "Send corrected details (partial is fine, e.g. bKash Personal or rate 126.70). ");
    return true;
  }

  if (action === "p2p_confirm") {
    const parsed = pending.parsed;
    if (!(parsed.intent === "BUY" || parsed.intent === "SELL") || !parsed.confirmable || hasMissing(parsed)) {
      await send(chatId, "Pending transaction is not confirmable yet. Use ✏️ CORRECT.");
      return true;
    }

    const record = await recordTrade(store, {
      cycleId: pending.cycleId || null,
      side: parsed.intent,
      quantity: parsed.quantity_usdt,
      price_bdt: parsed.rate_bdt,
      note: pending.raw_text || parsed.raw_text || "brain-confirmed",
    });

    trackConfirmedTrade(pending.cycleId, record.side, record.quantity);
    pendingFinancialByChat.delete(key);
    correctionModeByChat.delete(key);

    await send(chatId, `ACTUAL TRADE STORED\n${record.side}: ${record.quantity.toFixed(4)} USDT @ ${record.price_bdt.toFixed(2)}\nBDT value: ৳${record.total_bdt.toFixed(2)}`);
    return true;
  }

  return false;
}

async function input(chatId, text, send, store) {
  const session = sessions.get(String(chatId));
  const data = session.data;

  if (session.step === "capital") {
    const combined = capitalAndRate(text);
    data.capital = combined?.capital ?? amount(text);
    if (!(data.capital > 0)) throw Error("Use 50k, 1L, 1.25L, 50000, or e.g. 50k at 126.50.");
    if (combined) data.buyRate = combined.rate;
    session.step = "cycles";
    return send(chatId, combined
      ? `Capital ৳${data.capital.toFixed(2)} and BUY rate ৳${data.buyRate.toFixed(2)} accepted. Estimated USDT: ${(data.capital / data.buyRate).toFixed(4)}\nTarget cycles today?`
      : "Target cycles today?");
  }

  if (session.step === "cycles") {
    data.cycles = Math.floor(Number(text));
    if (!(data.cycles > 0)) throw Error("Enter a valid cycle count.");
    session.step = "buyMethod";
    return send(chatId, "BUY METHOD\n1. Bank\n2. bKash Merchant\n3. bKash Agent\n4. Nagad Agent\n5. bKash Personal\n6. Nagad Personal");
  }

  if (session.step === "buyMethod") {
    data.buyMethod = method(text);
    if (!data.buyMethod) throw Error("Choose 1-6.");
    if (data.buyMethod === "BankTransfer") {
      session.step = "buyBank";
      return send(chatId, "BUY bank type?\n1. Same bank — ৳0\n2. Other bank — ৳10");
    }
    session.step = "buyRate";
    return send(chatId, "BUY rate (BDT/USDT)?");
  }

  if (session.step === "buyBank") {
    data.buyBankType = /^(1|same)/i.test(text) ? "SameBank" : /^(2|other)/i.test(text) ? "OtherBank" : null;
    if (!data.buyBankType) throw Error("Choose 1 or 2.");
    session.step = "buyRate";
    return send(chatId, "BUY rate (BDT/USDT)?");
  }

  if (session.step === "buyRate") {
    data.buyRate = Number(text);
    if (!(data.buyRate > 0)) throw Error("Enter a valid rate.");
    session.step = "sellMethod";
    return send(chatId, "SELL METHOD\n1. Bank 0%\n2. bKash Merchant +0.40% / +1.80% optional\n3. bKash Agent +0.40%\n4. Nagad Agent +0.40%\n5. bKash Personal +0.70%\n6. Nagad Personal +0.70%");
  }

  if (session.step === "sellMethod") {
    data.sellMethod = method(text);
    if (!data.sellMethod) throw Error("Choose 1-6.");
    if (data.sellMethod === "BankTransfer") {
      session.step = "sellBank";
      return send(chatId, "SELL bank type?\n1. Same bank — ৳0\n2. Other bank — ৳10");
    }
    if (data.sellMethod === "BkashMerchant") {
      session.step = "sellMerchant";
      return send(chatId, "bKash Merchant SELL?\n1. Standard +0.40%\n2. Optional promo +1.80%");
    }
    session.step = "sellRate";
    return send(chatId, "SELL rate (BDT/USDT)?");
  }

  if (session.step === "sellBank") {
    data.sellBankType = /^(1|same)/i.test(text) ? "SameBank" : /^(2|other)/i.test(text) ? "OtherBank" : null;
    if (!data.sellBankType) throw Error("Choose 1 or 2.");
    session.step = "sellRate";
    return send(chatId, "SELL rate (BDT/USDT)?");
  }

  if (session.step === "sellMerchant") {
    data.sellOptional = /^(2|optional)/i.test(text);
    session.step = "sellRate";
    return send(chatId, "SELL rate (BDT/USDT)?");
  }

  if (session.step === "sellRate") {
    data.sellRate = Number(text);
    if (!(data.sellRate > 0)) throw Error("Enter a valid rate.");
    session.step = "settlement";
    return send(chatId, "CUSTOMER SETTLEMENT\n1. Bank — 0%\n2. bKash — 1.85%\n3. Nagad — 1.50%");
  }

  if (session.step === "settlement") {
    data.settlement = /^1/.test(text) ? "Bank" : /^2/.test(text) ? "Bkash" : /^3/.test(text) ? "Nagad" : null;
    if (!data.settlement) throw Error("Choose 1, 2 or 3.");
    session.step = "ready";
    return send(chatId, ready(data));
  }

  if (session.step === "close_bdt") {
    data.endBdt = amount(text);
    if (!(data.endBdt >= 0)) throw Error("Enter current BDT.");
    session.step = "close_usdt";
    return send(chatId, "Enter CURRENT USDT amount after this cycle.");
  }

  if (session.step === "close_usdt") {
    data.endUsdt = amount(text);
    if (!(data.endUsdt >= 0)) throw Error("Enter current USDT.");

    const x = calc(data);
    const cycleId = data.cycleId;
    if (!cycleId) throw Error("No active AC cycle ID found.");

    await recordCycle(store, {
      cycleId,
      startedAt: session.startedAt,
      endedAt: new Date().toISOString(),
      side: "ROUNDTRIP",
      paymentMethod: `${data.buyMethod}->${data.sellMethod}`,
      bankType: data.buyBankType || data.sellBankType,
      capitalBdt: data.capital,
      endBdt: data.endBdt,
      endUsdt: data.endUsdt,
      expectedProfitBdt: x.net,
      status: "RECONCILED",
      notes: `BUY ${data.buyRate}; SELL ${data.sellRate}; settlement ${data.settlement}`,
    });

    await send(chatId, `CYCLE CLOSED & STORED\nCycle: ${cycleId}\nEnding BDT: ৳${data.endBdt.toFixed(2)}\nEnding USDT: ${data.endUsdt.toFixed(4)}\nExpected profit: ৳${x.net.toFixed(2)}\nUse /report24 for summary.`);
    sessions.delete(String(chatId));
    return true;
  }

  return false;
}

async function chatWithAI(text, chatId, session, store) {
  const apiKey=process.env.OPENAI_API_KEY, model=process.env.OPENAI_MODEL;
  if(!apiKey||!model) return "AI chat is not configured yet. Add OPENAI_API_KEY and OPENAI_MODEL in Render.";
  await saveChatMessage(store,chatId,"user",text);
  const history=await getRecentChat(store,chatId,12);
  const cycleId=session?.data?.cycleId||null;
  const cycle=await getActiveCycleSnapshot(store,cycleId);
  const summary=await getSummary(store);
  const brain=[
    "You are AceTradersCO, the professional P2P trading operations copilot.",
    "Be concise, numerical and context-aware. English or Banglish is acceptable.",
    "Ledger data is the source of truth. Never invent balances, rates, fills, fees or profit.",
    "Never record, alter, confirm or imply execution of a trade through conversation.",
    "Protected transaction workflow and explicit CONFIRM are required for ledger writes.",
    "Distinguish realized cash flow, remaining inventory and estimated profit.",
    "If data is insufficient, state exactly what is missing."
  ].join(" ");
  const state=JSON.stringify({active_cycle:cycle,portfolio:summary});
  const messages=history.map(x=>({role:x.role,content:x.content}));
  messages.push({role:"user",content:`CURRENT VERIFIED STATE: ${state}\nAnswer my latest request using this state.`});
  const response=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${apiKey}`},body:JSON.stringify({model,instructions:brain,input:messages,max_output_tokens:600})});
  if(!response.ok) return `AI chat unavailable (HTTP ${response.status}). Commands still work.`;
  const payload=await response.json(); let reply=payload.output_text||"";
  if(!reply) for(const item of payload.output||[]) for(const part of item.content||[]) if(part.type==="output_text"&&part.text) reply+=part.text;
  reply=reply.trim()||"I could not generate a reply. Commands still work.";
  await saveChatMessage(store,chatId,"assistant",reply);
  return reply;
}

