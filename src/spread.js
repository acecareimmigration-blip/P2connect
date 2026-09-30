export function calculateSpread({ buyPrice, sellPrice, quantity, fees = 0 }) {
  for (const n of [buyPrice, sellPrice, quantity, fees]) if (!Number.isFinite(n) || n < 0) throw new TypeError("Invalid numeric input");
  const capitalRequired = buyPrice * quantity;
  const grossProfit = (sellPrice - buyPrice) * quantity;
  const netProfit = grossProfit - fees;
  const grossSpreadPct = capitalRequired ? (grossProfit / capitalRequired) * 100 : 0;
  const netSpreadPct = capitalRequired ? (netProfit / capitalRequired) * 100 : 0;
  return { capitalRequired, grossProfit, fees, netProfit, grossSpreadPct, netSpreadPct };
}
