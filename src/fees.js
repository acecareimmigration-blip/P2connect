const RULES = {
  BankTransfer: {
    BUY: { rate: 0, fixed: { SameBank: 0, OtherBank: 10 }, basis: "BDT" },
    SELL: { rate: 0, fixed: { SameBank: 0, OtherBank: 10 }, basis: "BDT" }
  },
  BkashAgent: { BUY: { rate: 0.004, basis: "BDT" }, SELL: { rate: 0.004, basis: "BDT" } },
  NagadAgent: { BUY: { rate: 0.004, basis: "BDT" }, SELL: { rate: 0.004, basis: "BDT" } },
  BkashPersonal: { BUY: { rate: 0, basis: "BDT" }, SELL: { rate: 0.007, basis: "BDT" } },
  NagadPersonal: { BUY: { rate: 0, basis: "BDT" }, SELL: { rate: 0.007, basis: "BDT" } },
  BkashMerchant: { BUY: { rate: 0, basis: "BDT" }, SELL: { rate: 0.004, basis: "BDT", optional: 0.018 } }
};

export function getFeeRule(method, side, options = {}) {
  const rule = RULES[method]?.[side];
  if (!rule) throw new Error(`Unsupported payment method/side: ${method}/${side}`);
  const fixed = method === "BankTransfer" ? (rule.fixed?.[options.bankType] ?? 0) : 0;
  const rate = method === "BkashMerchant" && side === "SELL" && options.merchantOptional ? rule.optional : rule.rate;
  return { method, side, rate, fixed, basis: rule.basis };
}

export function calculateMethodEconomics({ method, side, bdtAmount, bankType, merchantOptional = false }) {
  const amount = Number(bdtAmount);
  if (!(amount >= 0)) throw new Error("Invalid BDT amount");
  const rule = getFeeRule(method, side, { bankType, merchantOptional });
  const percentage = amount * rule.rate;
  return {
    method, side, bdtAmount: amount, rate: rule.rate,
    percentageAmount: percentage, fixedAmount: rule.fixed,
    total: percentage + rule.fixed,
    netEffect: side === "BUY" ? -percentage - rule.fixed : percentage - rule.fixed
  };
}

export function calculateCycleFees({ method, buyBdt, sellBdt, bankType, merchantOptional = false }) {
  const buy = calculateMethodEconomics({ method, side: "BUY", bdtAmount: buyBdt, bankType, merchantOptional });
  const sell = calculateMethodEconomics({ method, side: "SELL", bdtAmount: sellBdt, bankType, merchantOptional });
  return { buy, sell, totalExpense: buy.total, totalMethodBenefit: sell.percentageAmount, netMethodEffect: sell.netEffect - buy.percentageAmount };
}
