/** Format OpenRouter USD credits so sub-cent charges stay visible. */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount === 0) return "$0.00";
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  let text = abs.toFixed(decimals);
  if (decimals > 2) {
    text = text.replace(/0+$/, "");
    const [whole, frac = ""] = text.split(".");
    text = `${whole}.${frac.padEnd(2, "0")}`;
  }
  return `${sign}$${text}`;
}

export function sumCosts(amounts: Iterable<number>): number {
  let total = 0;
  for (const amount of amounts) {
    if (Number.isFinite(amount)) total += amount;
  }
  return total;
}
