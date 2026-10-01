import { recordTrade, getSummary, recordCycle, nextCycleId, getCycleReport } from "./ledger.js";
import { parseTradeMessage, buildPendingPreview } from "./tradeParser.js";

const METHODS = ["BankTransfer", "BkashMerchant", "BkashAgent", "NagadAgent", "BkashPersonal", "NagadPersonal"];
const SETTLEMENT = { Bank: 0, Bkash: 0.0185, Nagad: 0.015 };
const sessions = new Map();
const pinModes = new Set();
const pendingFinancialByChat = new Map();
const correctionModeByChat = new Set();

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
  const ids = process.env.TELEGRAM_ALLOWED_CHAT_IDS || "";
  return !ids.trim() || ids.split(",").map((value) => value.trim()).includes(String(id));
}

function amount(value) {
  const normalized = String(value).trim().toLowerCase().replace(/,/g, "");
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*(k|l|lac|lakh)?$/);
  if (!match) return NaN;
  return Number(match[1]) * (match[2] === "k" ? 1000 : ["l", "lac", "lakh"].includes(match[2]) ? 100000 : 1);
}

function method(value) {
  const index = Number(value);
  if (index >= 1 && index <= 6) return METHODS[index - 1];
  const normalized = value.toLowerCase().replace(/[^a-z]/g, "");
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
  if ((paymentMethod === "BkashPersonal" || paymentMethod === "NagadPersonal") && side === "SELL") return 0.007;
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
  return `CYCLE READY\n\nCAPITAL: ৳${data.capital.toFixed(2)}\n\nBUY\n${data.buyMethod}${data.buyBankType ? ` (${data.buyBankType})` : ""} @ ${data.buyRate.toFixed(2)}\nUSDT acquired: ${x.usdt.toFixed(4)}\nMethod benefit: +৳${x.buyBenefit.toFixed(2)}\nFixed cost: -৳${x.buyFixed.toFixed(2)}\n\nSELL\n${data.sellMethod}${data.sellBankType ? ` (${data.sellBankType})` : ""} @ ${data.sellRate.toFixed(2)}\nGross proceeds: ৳${x.gross.toFixed(2)}\nMethod benefit: +৳${x.sellBenefit.toFixed(2)}\nFixed cost: -৳${x.sellFixed.toFixed(2)}\n\nSETTLEMENT: ${data.settlement}\nSettlement cost: -৳${x.settlementCost.toFixed(2)}\n\nPREDICTED NET PROFIT: ৳${x.net.toFixed(2)}\nPREDICTED RETURN: ${(x.margin * 100).toFixed(3)}%\n\nExecute manually, then record ACTUAL fills:\n/buy <USDT> <actual rate>\n/sell <USDT> <actual rate>\n\nFinish with /stoptrade`;
}

async function input(chatId, text, send, store) {
  const session = sessions.get(String(chatId));
  const data = session.data;

  if (session.step === "capital") {
    data.capital = amount(text);
    if (!(data.capital > 0)) throw Error("Use 50k, 1L, 1.25L or a number.");
    session.step = "cycles";
    return send(chatId, "Target cycles today?");
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
    const cycleId = `P2P-${Date.now()}`;
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

function sellRestRequested(text) {
  const normalized = String(text || "").toLowerCase();
  return /\bsell\s+rest\b/.test(normalized) || /\bsell\s+remaining\b/.test(normalized);
}

function updateParsedSellQuantity(parsed, quantity) {
  const rate = Number(parsed.rate_bdt);
  parsed.quantity_usdt = quantity;
  parsed.missing_fields = Array.isArray(parsed.missing_fields)
    ? parsed.missing_fields.filter((field) => field !== "quantity_usdt")
    : [];

  if (Number.isFinite(quantity) && quantity > 0 && Number.isFinite(rate) && rate > 0) {
    parsed.bdt_value = quantity * rate;
    parsed.confirmable = true;
  } else {
    parsed.confirmable = false;
  }
}

async function routeMessageToBrain(chatId, text, send, store) {
  const key = String(chatId);
  const hasPending = pendingFinancialByChat.has(key);
  const correctionMode = correctionModeByChat.has(key);

  if (hasPending && !correctionMode) {
    await send(chatId, "You already have a pending transaction. Use ✅ CONFIRM, ✏️ CORRECT, or ❌ CANCEL.");
    return true;
  }

  const brain = await parseTradeMessage(text);
  if (!brain.ok) {
    await send(chatId, "AI parsing is temporarily unavailable. Use /buy or /sell manual commands.");
    return true;
  }

  const parsed = brain.parsed;

  if (parsed.intent === "SELL" && sellRestRequested(text) && (!parsed.quantity_usdt || parsed.missing_fields.includes("quantity_usdt"))) {
    const summary = await getSummary(store);
    const remaining = Number(summary.net_qty);
    if (!(remaining > 0)) {
      await send(chatId, "No remaining confirmed USDT is available to sell.");
      return true;
    }
    updateParsedSellQuantity(parsed, remaining);
  }

  if (parsed.intent === "COST" || parsed.intent === "CORRECTION") {
    await send(chatId, "Captured, but this requires the dedicated audit-ledger extension. Nothing has been recorded.");
    correctionModeByChat.delete(key);
    return true;
  }

  if (parsed.intent !== "BUY" && parsed.intent !== "SELL") {
    if (parsed.clarification) {
      await send(chatId, parsed.clarification);
    } else {
      await send(chatId, "Please use /help, /buy, /sell, or /starttrade.");
    }
    correctionModeByChat.delete(key);
    return true;
  }

  if ((parsed.missing_fields || []).length > 0) {
    await send(chatId, parsed.clarification || "Please provide missing transaction details.");
    return true;
  }

  const active = sessions.get(key);
  const pending = {
    parsed,
    raw_text: text,
    cycleId: active?.data?.cycleId || null,
  };
  pendingFinancialByChat.set(key, pending);
  correctionModeByChat.delete(key);

  const preview = buildPendingPreview(pending.cycleId || "ACxxxx", parsed);
  await send(chatId, preview, {
    inline_keyboard: [[
      { text: "✅ CONFIRM", callback_data: "p2p_confirm" },
      { text: "✏️ CORRECT", callback_data: "p2p_correct" },
      { text: "❌ CANCEL", callback_data: "p2p_cancel" },
    ]],
  });
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
    await send(chatId, "Send corrected transaction text.");
    return true;
  }

  if (action === "p2p_confirm") {
    const parsed = pending.parsed;
    if (!(parsed.intent === "BUY" || parsed.intent === "SELL") || !parsed.confirmable) {
      await send(chatId, "Pending transaction is not confirmable yet. Use ✏️ CORRECT.");
      return true;
    }

    const record = await recordTrade(store, {
      cycleId: pending.cycleId || null,
      side: parsed.intent,
      quantity: parsed.quantity_usdt,
      price_bdt: parsed.rate_bdt,
      note: parsed.raw_text || pending.raw_text || "brain-confirmed",
    });

    pendingFinancialByChat.delete(key);
    correctionModeByChat.delete(key);
    await send(chatId, `ACTUAL TRADE STORED\n${record.side}: ${record.quantity.toFixed(4)} USDT @ ${record.price_bdt.toFixed(2)}\nBDT value: ৳${record.total_bdt.toFixed(2)}`);
    return true;
  }

  return false;
}

export function startTelegramBot({ getStatus, store }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  let offset = 0;
  const send = (chatId, text, reply_markup) => api(token, "sendMessage", { chat_id: chatId, text, ...(reply_markup ? { reply_markup } : {}) });

  (async () => {
    while (true) {
      try {
        const updates = await api(token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });

        for (const update of updates) {
          offset = update.update_id + 1;
          const message = update.message;
          const callback = update.callback_query;

          if (callback) {
            const chatId = callback.message?.chat?.id;
            if (chatId && allowed(chatId)) {
              await api(token, "answerCallbackQuery", { callback_query_id: callback.id });
              const action = callback.data;

              if (await handleBrainCallback(chatId, action, send, store)) {
                continue;
              }

              if (action === "starttrade") {
                sessions.set(String(chatId), { step: "capital", startedAt: new Date().toISOString(), data: { cycleId: await nextCycleId(store) } });
                await send(chatId, "P2P CYCLE SETUP\nCapital amount?\nExamples: 50k = ৳50,000 | 1L = ৳100,000 | 1.25L = ৳125,000");
              } else if (action === "continue") {
                const session = sessions.get(String(chatId));
                await send(chatId, session ? `ACTIVE CYCLE ${session.data.cycleId}\nCurrent step: ${session.step}\nReply with the requested value to continue.` : "No active cycle. Tap Start Trade to begin.");
              } else if (action === "report") {
                const summary = await getSummary(store);
                await send(chatId, `TRANSACTION SUMMARY\nBought: ${summary.bought_qty.toFixed(4)} USDT @ ${summary.average_buy_bdt.toFixed(2)}\nSold: ${summary.sold_qty.toFixed(4)} USDT @ ${summary.average_sell_bdt.toFixed(2)}\nNet USDT: ${summary.net_qty.toFixed(4)}\nGross cash difference: ৳${summary.gross_bdt.toFixed(2)}`);
              } else if (action === "help") {
                await send(chatId, "/starttrade — new cycle\n/continue — continue active cycle\n/stoptrade — close cycle\n/report24 — summary\n/buy and /sell — record actual fills");
              }
            }
            continue;
          }

          if (!message?.chat?.id || !allowed(message.chat.id)) continue;

          const chatId = message.chat.id;
          const text = (message.text || "").trim();
          if (!text) continue;
          const [command, ...args] = text.split(/\s+/);

          try {
            if (pinModes.has(String(chatId)) && !text.startsWith("/")) {
              pinModes.delete(String(chatId));
              const posted = await send(chatId, `PINNED INSTRUCTIONS\n\n${text}`);
              try {
                await api(token, "pinChatMessage", { chat_id: chatId, message_id: posted.message_id, disable_notification: true });
              } catch {
                await send(chatId, "Instruction saved, but I could not pin it. Make the bot an admin with permission to pin messages.");
              }
              continue;
            }

            if (sessions.has(String(chatId)) && !text.startsWith("/")) {
              await input(chatId, text, send, store);
              continue;
            }

            if (!text.startsWith("/")) {
              if (await routeMessageToBrain(chatId, text, send, store)) {
                continue;
              }
            }

            if (command === "/pininstructions") {
              pinModes.add(String(chatId));
              await send(chatId, "Send the manual instructions now. I will post them and pin the message.\n\nRecommended: include BUY/SELL recording format, payment methods, fee rules, and the /starttrade → /stoptrade workflow.");
              continue;
            }

            if (command === "/continue") {
              const session = sessions.get(String(chatId));
              await send(chatId, session ? `ACTIVE CYCLE ${session.data.cycleId}\nCurrent step: ${session.step}\nReply with the requested value to continue.` : "No active cycle. Use /starttrade.");
              continue;
            }

            if (command === "/cycle") {
              const session = sessions.get(String(chatId));
              await send(chatId, session ? `ACTIVE CYCLE: ${session.data.cycleId}\nStep: ${session.step}` : "No active cycle.");
              continue;
            }

            if (command === "/starttrade") {
              sessions.set(String(chatId), { step: "capital", startedAt: new Date().toISOString(), data: { cycleId: await nextCycleId(store) } });
              await send(chatId, `P2P CYCLE SETUP\nCycle ID: ${sessions.get(String(chatId)).data.cycleId}\nCapital amount?\nExamples: 50k = ৳50,000 | 1L = ৳100,000 | 1.25L = ৳125,000`);
              continue;
            }

            if (command === "/buy" || command === "/sell") {
              if (args.length < 2) throw Error(`Usage: ${command} <USDT> <actual rate>`);
              const active = sessions.get(String(chatId));
              const record = await recordTrade(store, {
                cycleId: active?.data?.cycleId || null,
                side: command === "/buy" ? "BUY" : "SELL",
                quantity: amount(args[0]),
                price_bdt: Number(args[1]),
                note: args.slice(2).join(" "),
              });
              await send(chatId, `ACTUAL TRADE STORED\n${record.side}: ${record.quantity.toFixed(4)} USDT @ ${record.price_bdt.toFixed(2)}\nBDT value: ৳${record.total_bdt.toFixed(2)}`);
              continue;
            }

            if (command === "/p2p") {
              if (args.length < 2) throw Error("Usage: /p2p <buy> <sell>");
              const buy = Number(args[0]);
              const sell = Number(args[1]);
              await send(chatId, `MARKET CHECK\nBUY: ${buy.toFixed(2)}\nSELL: ${sell.toFixed(2)}\nRaw spread: ${(((sell - buy) / buy) * 100).toFixed(3)}%`);
              continue;
            }

            if (command === "/stoptrade") {
              const session = sessions.get(String(chatId));
              if (!session) {
                await send(chatId, "No active cycle.");
                continue;
              }
              session.step = "close_bdt";
              await send(chatId, "CYCLE CLOSING\nEnter CURRENT BDT amount after this cycle.");
              continue;
            }

            if (command === "/report24" || command === "/balance") {
              const summary = await getSummary(store);
              await send(chatId, `TRANSACTION SUMMARY\nBought: ${summary.bought_qty.toFixed(4)} USDT @ ${summary.average_buy_bdt.toFixed(2)}\nSold: ${summary.sold_qty.toFixed(4)} USDT @ ${summary.average_sell_bdt.toFixed(2)}\nNet USDT: ${summary.net_qty.toFixed(4)}\nGross cash difference: ৳${summary.gross_bdt.toFixed(2)}\nStorage: ${store.persistent ? "PostgreSQL" : "temporary"}`);
              continue;
            }

            if (command === "/status") {
              const status = getStatus();
              await send(chatId, `P2connect: ${status.status}\nBinance read-only: ${status.binanceConfigured ? "configured" : "not configured"}`);
              continue;
            }

            if (command === "/help" || command === "/start") {
              const posted = await send(
                chatId,
                "P2P TRADE CONTROL\n\nUse the buttons below to start/continue a cycle or view the ledger.\n\nManual instructions: /pininstructions",
                {
                  inline_keyboard: [
                    [
                      { text: "▶ Start Trade", callback_data: "starttrade" },
                      { text: "↪ Continue", callback_data: "continue" },
                    ],
                    [
                      { text: "📊 Report", callback_data: "report" },
                      { text: "❓ Help", callback_data: "help" },
                    ],
                  ],
                },
              );
              try {
                await api(token, "pinChatMessage", { chat_id: chatId, message_id: posted.message_id, disable_notification: true });
              } catch {
                // ignore pin failure
              }
              continue;
            }

            await send(chatId, "Unknown command. Use /help.");
          } catch (error) {
            await send(chatId, `Error: ${error.message}`);
          }
        }
      } catch (error) {
        console.error("Telegram:", error.message);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  })();
}
