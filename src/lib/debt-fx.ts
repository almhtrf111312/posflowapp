/**
 * Debt FX policy (docs/FINANCE_LAW.md F-27 / D-04 / D-06, KD-01).
 *
 * A debt paid in the SAME foreign currency as its invoice is credited at the INVOICE's original rate
 * (foreign units per USD). The cash that enters the drawer is still valued at the payment-day rate; the difference
 * is the FX difference, reported on its own line and never as sales profit.
 * Every other combination (USD payment, cash debt, a different currency) keeps the legacy behaviour: credit = cash.
 * Mirrors the server (`record_debt_payment_atomic`, migration 20261123071000); the server is the authority.
 */
export interface DebtFxPolicy {
  invoiceCurrency: string;
  /** foreign units per 1 USD, from the invoice snapshot */
  invoiceRate: number;
}

export interface InvoiceRateSnapshot {
  currency?: string | null;
  exchangeRate?: number | null;
}

const r4 = (n: number) => Math.round((Number(n) || 0) * 1e4) / 1e4;
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export function resolveDebtFxPolicy(
  invoice: InvoiceRateSnapshot | null | undefined,
  paymentCurrency: string,
  isCashDebt = false
): DebtFxPolicy | null {
  if (!invoice || isCashDebt) return null;
  const pay = String(paymentCurrency || 'USD').trim().toUpperCase();
  const inv = String(invoice.currency || '').trim().toUpperCase();
  const rate = Number(invoice.exchangeRate) || 0;
  if (pay === 'USD' || inv !== pay || !(rate > 0)) return null;
  return { invoiceCurrency: inv, invoiceRate: rate };
}

/** USD that the payment removes from the debt. */
export function debtCreditUsd(policy: DebtFxPolicy | null, foreignAmount: number, cashUsd: number): number {
  if (!policy) return cashUsd;
  return r4((Number(foreignAmount) || 0) / policy.invoiceRate);
}

/** Largest payment, in the payment currency, that does not exceed the remaining debt. */
export function maxPayableInCurrency(remainingUsd: number, policy: DebtFxPolicy | null, todayRate: number): number {
  const rate = policy ? policy.invoiceRate : todayRate;
  return (Number(remainingUsd) || 0) * (rate > 0 ? rate : 1);
}

/** FX difference in USD: cash value at the payment-day rate minus the credit given (> 0 gain, < 0 loss). */
export function debtFxDifferenceUsd(policy: DebtFxPolicy | null, cashUsd: number, creditUsd: number): number {
  return policy ? r2(cashUsd - creditUsd) : 0;
}
