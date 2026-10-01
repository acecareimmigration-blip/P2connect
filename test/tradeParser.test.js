import test from "node:test";
import assert from "node:assert/strict";
import { buildPendingPreview, parseTradeMessageFromAI } from "../src/tradeParser.js";

test("BUY becomes confirmable only with positive quantity and rate", () => {
  const out = parseTradeMessageFromAI("bought 784 at 127.60 bank", {
    intent: "BUY",
    quantity_usdt: 784,
    rate_bdt: 127.6,
    payment_method: "bank",
    missing_fields: [],
  });

  assert.equal(out.parsed.intent, "BUY");
  assert.equal(out.parsed.confirmable, true);
  assert.equal(out.parsed.confirmation_state, "PENDING");
  assert.equal(out.parsed.bdt_value, 100038.4);
  assert.equal(out.confirmation.ledger_write_allowed, false);
});

test("BUY is not confirmable when rate is missing", () => {
  const out = parseTradeMessageFromAI("bought 398.98 usdt", {
    intent: "BUY",
    quantity_usdt: 398.98,
    rate_bdt: null,
    missing_fields: [],
  });

  assert.equal(out.parsed.confirmable, false);
  assert.ok(out.parsed.missing_fields.includes("rate_bdt"));
});

test("rejects invalid numeric values", () => {
  const out = parseTradeMessageFromAI("sell 150 usdt @129.70", {
    intent: "SELL",
    quantity_usdt: "Infinity",
    rate_bdt: -1,
    missing_fields: [],
  });

  assert.equal(out.parsed.quantity_usdt, null);
  assert.equal(out.parsed.rate_bdt, null);
  assert.equal(out.parsed.confirmable, false);
  assert.ok(out.parsed.missing_fields.includes("quantity_usdt"));
  assert.ok(out.parsed.missing_fields.includes("rate_bdt"));
});

test("COST requires amount_bdt", () => {
  const out = parseTradeMessageFromAI("cashout cost 450", {
    intent: "COST",
    amount_bdt: 450,
    missing_fields: [],
  });

  assert.equal(out.parsed.amount_bdt, 450);
  assert.equal(out.parsed.missing_fields.length, 0);
});

test("CORRECTION requires correction_target", () => {
  const out = parseTradeMessageFromAI("actually sell rate was 129.75", {
    intent: "CORRECTION",
    rate_bdt: 129.75,
    correction_target: null,
    missing_fields: [],
  });

  assert.ok(out.parsed.missing_fields.includes("correction_target"));
  assert.equal(out.parsed.confirmable, false);
});

test("pending preview has required wording", () => {
  const parsed = {
    intent: "BUY",
    quantity_usdt: 783.6991,
    rate_bdt: 127.6,
    bdt_value: 100000.01,
    payment_method: "BankTransfer",
  };
  const preview = buildPendingPreview("AC0007", parsed);
  assert.match(preview, /AC0007 — PENDING/);
  assert.match(preview, /Nothing has been recorded yet\./);
});
