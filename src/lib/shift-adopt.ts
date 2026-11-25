// Pure rules for adopting a shift that is open in the cloud but unknown on this device (cross-device sync).
// The cloud balance is the source of truth (docs/FINANCE_LAW.md F-18), so local totals are seeded from it.
import type { Shift, ShiftCurrenciesMap } from './cashbox-store';

export interface CloudShiftLike {
  id: string;
  opened_at: string;
  closed_at?: string | null;
  opening_balance: number | string;
  expected_balance: number | string | null;
  cashier_id?: string | null;
  cashier_name?: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Returns the Shift to store locally, or null when the cloud shift must not be adopted. */
export function buildAdoptedShift(
  cloud: CloudShiftLike,
  currentUserId: string | null | undefined,
  deviceHasOpenShift: boolean,
  baseCurrencies: ShiftCurrenciesMap
): Shift | null {
  if (cloud.closed_at) return null;
  if (deviceHasOpenShift) return null;
  // A shift of another cashier is never adopted by this user
  if (cloud.cashier_id && currentUserId && cloud.cashier_id !== currentUserId) return null;

  const opening = round2(Number(cloud.opening_balance) || 0);
  const hasExpected = cloud.expected_balance !== null && cloud.expected_balance !== undefined && cloud.expected_balance !== '';
  const expected = Number(cloud.expected_balance);
  const net = hasExpected && Number.isFinite(expected) ? round2(expected - opening) : 0;

  const currencies: ShiftCurrenciesMap = { ...baseCurrencies };
  const usd = { ...(currencies['USD'] || { opening, sales: 0, expenses: 0, deposits: 0, withdrawals: 0 }) };
  usd.opening = opening;
  if (net > 0) usd.sales = net;
  if (net < 0) usd.expenses = -net;
  currencies['USD'] = usd;

  return {
    id: cloud.id,
    openedAt: cloud.opened_at,
    openingCash: opening,
    userId: cloud.cashier_id || currentUserId || '',
    userName: cloud.cashier_name || '',
    status: 'open',
    salesTotal: net > 0 ? net : 0,
    expensesTotal: net < 0 ? -net : 0,
    depositsTotal: 0,
    withdrawalsTotal: 0,
    cogsTotal: 0,
    grossProfitTotal: 0,
    currencies,
    currency: 'USD',
    exchange_rate: 1,
  };
}
