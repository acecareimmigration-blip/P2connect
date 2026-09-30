import test from "node:test";
import assert from "node:assert/strict";
import { calculateSpread } from "../src/spread.js";
test("calculates net P2P spread", () => {
  const r = calculateSpread({ buyPrice: 126, sellPrice: 128, quantity: 100, fees: 20 });
  assert.equal(r.capitalRequired, 12600);
  assert.equal(r.grossProfit, 200);
  assert.equal(r.netProfit, 180);
});
