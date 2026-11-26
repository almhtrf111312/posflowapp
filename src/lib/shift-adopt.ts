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

// Same direction table as close_cash_shift_atomic (F-18): the drawer is opening + inflows − outflows.
const INFLOW_TYPES = ['sale', 'deposit', 'deposit_capital', 'deposit_revenue', 'deposit_purchase_cover', 'debt_payment', 'surplus', 'expense_refund', 'supplier_refund', 'fx_in', 'transfer_in'];
const OUTFLOW_TYPES = ['expense', 'refund', 'withdrawal', 'supplier_payment', 'store_credit_refund', 'shortage', 'fx_out', 'transfer_out'];

export interface ShiftMovement { type: string; amount: number | string; }

/** Expected drawer balance from the shift's movements. Other types (e.g. digital_sale) never touch the drawer. */
export function expectedFromMovements(opening: number | string, movements: ShiftMovement[]): number {
  let total = Number(opening) || 0;
  for (const m of movements) {
    const amt = Number(m.amount) || 0;
    if (INFLOW_TYPES.includes(m.type)) total += amt;
    else if (OUTFLOW_TYPES.includes(m.type)) total -= amt;
  }
  return round2(total);
}

export interface ShiftTotalsLike {
  openingCash: number;
  salesTotal?: number;
  depositsTotal?: number;
  expensesTotal?: number;
  withdrawalsTotal?: number;
}

/** Expected drawer cash of a shift: opening + sales + deposits − expenses − withdrawals (same formula as closing, F-18). */
export function expectedCashOfShift(shift: ShiftTotalsLike): number {
  const v = (shift.openingCash || 0) + (shift.salesTotal || 0) + (shift.depositsTotal || 0)
    - (shift.expensesTotal || 0) - (shift.withdrawalsTotal || 0);
  return Math.round(v * 1e8) / 1e8;
}

/** The server refused to open a second shift for the same cashier (unique violation on the one-open-shift index). */
export function isShiftAlreadyOpenError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null | undefined;
  if (!e) return false;
  if (String(e.code ?? '') === '23505') return true;
  return /uq_cash_shifts_one_open_per_cashier/.test(String(e.message ?? ''));
}

export type LocalShiftSync = 'close' | 'refresh' | 'keep';

/**
 * What to do with this device's open shift after reading the cloud (local = cloud, found by plan K-06/L on 2026-11-26).
 * - 'close'   the cloud has closed it (closed on this or another device): close it locally too, or new operations go to a closed shift.
 * - 'refresh' still open, the cloud expected cash (from movements, F-18) differs and nothing is waiting in the sync queue:
 *             reseed the local totals from the cloud (another session sold on the same shift).
 * - 'keep'    no cloud copy yet, same balance, or local operations still waiting to sync (the cloud is behind this device).
 */
export function decideLocalShiftSync(
  localExpected: number,
  cloud: { closed_at?: string | null } | null | undefined,
  cloudExpected: number | null,
  hasPendingSync: boolean,
): LocalShiftSync {
  if (!cloud) return 'keep';
  if (cloud.closed_at) return 'close';
  if (hasPendingSync || cloudExpected === null) return 'keep';
  return Math.abs(cloudExpected - localExpected) > 0.005 ? 'refresh' : 'keep';
}
