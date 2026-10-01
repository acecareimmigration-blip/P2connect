export function calculateSignal({ buyPrice, sellPrice, feeRate = 0, slippageRate = 0 }) {
  const buy=Number(buyPrice), sell=Number(sellPrice), fee=Number(feeRate), slip=Number(slippageRate);
  if (!(buy>0&&sell>0)) throw new Error("Invalid prices");
  const effectiveBuy=buy*(1+fee+slip);
  const effectiveSell=sell*(1-fee-slip);
  const spreadBdt=effectiveSell-effectiveBuy;
  const spreadPct=(spreadBdt/effectiveBuy)*100;
  return { buy_price_bdt:buy, sell_price_bdt:sell, effective_buy_bdt:effectiveBuy,
    effective_sell_bdt:effectiveSell, spread_bdt:spreadBdt, spread_pct:spreadPct,
    signal:spreadBdt>0?"REVIEW":"NO_TRADE" };
}
