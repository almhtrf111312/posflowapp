/**
 * Partner currency rules (docs/FINANCE_LAW.md D-10). The accounting base is USD.
 *
 *  - Capital is held in USD at the deposit. A capital withdrawal in a foreign currency is valued at the ORIGINAL
 *    deposit rate: the weighted rate over the partner's capital deposits (sum of original amounts / sum of USD).
 *  - Profit is held in USD. A profit withdrawal in a foreign currency is valued at TODAY's rate for that currency.
 *
 * The server (partner_withdrawal_atomic, migration 20261123075000) is the authority; these helpers only keep the
 * screen and the request consistent with it.
 */

export interface CapitalHistoryLike {
  type?: string;
  amount?: number;
  originalAmount?: number;
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Weighted original rate of the capital deposits (foreign units per USD). 0 when there is no usable deposit. */
export function capitalOriginalRate(history: CapitalHistoryLike[] | null | undefined): number {
  let usd = 0;
  let original = 0;
  for (const h of history ?? []) {
    if (h.type !== 'deposit') continue;
    const a = Number(h.amount) || 0;
    const o = Number(h.originalAmount) || 0;
    if (a > 0 && o > 0) {
      usd += a;
      original += o;
    }
  }
  return usd > 0 ? original / usd : 0;
}

/** USD taken from capital for a foreign-currency amount, at the original deposit rate. */
export function capitalUsdFromForeign(originalAmount: number, capitalRate: number): number {
  return capitalRate > 0 ? round4(originalAmount / capitalRate) : 0;
}

/** Foreign amount that the whole capital is worth at its original deposit rate. */
export function capitalMaxInForeign(capitalUsd: number, capitalRate: number): number {
  return capitalRate > 0 ? Math.round(capitalUsd * capitalRate * 100) / 100 : 0;
}

/** USD taken from profit for a foreign-currency amount, at today's rate. */
export function profitUsdFromForeign(originalAmount: number, todayRate: number): number {
  return todayRate > 0 ? round4(originalAmount / todayRate) : 0;
}
