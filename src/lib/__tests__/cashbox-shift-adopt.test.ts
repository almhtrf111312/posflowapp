// Production-code test: rules for adopting a shift open in the cloud but unknown on this device (cross-device sync).
import { buildAdoptedShift, expectedFromMovements, expectedCashOfShift, isShiftAlreadyOpenError, decideLocalShiftSync } from '../shift-adopt';

let failed = 0;
let passed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) passed++;
  else { failed++; console.log(`FAIL ${name}: expected ${String(expected)} got ${String(actual)}`); }
}

const USER = 'u-1';
const base = { USD: { opening: 0, sales: 0, expenses: 0, deposits: 0, withdrawals: 0 } };
const cloud = { id: 'shift-cloud-1', opened_at: '2026-11-25T20:34:57Z', opening_balance: 500, expected_balance: 500, cashier_id: USER, cashier_name: 'Owner', closed_at: null };
const expectedCash = (s: NonNullable<ReturnType<typeof buildAdoptedShift>>) =>
  Math.round((s.openingCash + s.salesTotal + s.depositsTotal - s.expensesTotal - s.withdrawalsTotal) * 100) / 100;

const a = buildAdoptedShift(cloud, USER, false, base);
eq('SYNC a cloud-open shift is adopted on a device that has none', a?.id, 'shift-cloud-1');
eq('SYNC the adopted shift is open', a?.status, 'open');
eq('SYNC the adopted shift keeps the opening balance', a?.openingCash, 500);

// Expected cash follows the server (F-18): opening 100, server expected 400.5.
const b = buildAdoptedShift({ ...cloud, id: 's2', opening_balance: 100, expected_balance: 400.5 }, USER, false, base);
eq('SYNC expected cash is seeded from the server balance (400.5)', b ? expectedCash(b) : null, 400.5);
eq('SYNC the per-currency USD sales match the net inflow (300.5)', b?.currencies?.USD.sales, 300.5);

// Server balance below the opening is held as an outflow, never as negative sales.
const c = buildAdoptedShift({ ...cloud, id: 's3', opening_balance: 100, expected_balance: 60 }, USER, false, base);
eq('SYNC a lower server balance never becomes negative sales', c?.salesTotal, 0);
eq('SYNC a lower server balance is held as outflow (40)', c?.expensesTotal, 40);
eq('SYNC expected cash is 60 after a net outflow', c ? expectedCash(c) : null, 60);

// Never adopt: a closed shift, another cashier's shift, or when the device already has an open shift.
eq('SYNC a closed cloud shift is not adopted', buildAdoptedShift({ ...cloud, closed_at: '2026-11-25T21:00:00Z' }, USER, false, base), null);
eq("SYNC another cashier's shift is not adopted", buildAdoptedShift({ ...cloud, cashier_id: 'someone-else' }, USER, false, base), null);
eq('SYNC a device that already has an open shift keeps it', buildAdoptedShift(cloud, USER, true, base), null);
// A missing server balance falls back to the opening balance.
const d = buildAdoptedShift({ ...cloud, expected_balance: null }, USER, false, base);
eq('SYNC a missing server balance falls back to the opening balance', d ? expectedCash(d) : null, 500);

// Expected from movements (F-18). Live case: opening 500, cash sale 2, debt payment 6 -> 508 (the stored cache says 506 because KD-06).
eq('SYNC expected from movements counts cash sales and debt payments (508)', expectedFromMovements(500, [{ type: 'sale', amount: 2 }, { type: 'debt_payment', amount: '6.00000000' }]), 508);
eq('SYNC outflows reduce the drawer (expense 50, refund 10)', expectedFromMovements(100, [{ type: 'debt_payment', amount: 315 }, { type: 'expense', amount: 50 }, { type: 'expense_refund', amount: 50 }, { type: 'refund', amount: 14.5 }]), 400.5);
eq('SYNC a digital sale never touches the drawer', expectedFromMovements(100, [{ type: 'digital_sale', amount: 40 }]), 100);

// G-12: the shift card showed 502 while the drawer detail showed 508 (the debt payment of 6 is a deposit and was ignored).
eq('G12 card expected cash includes deposits (500 + 2 sales + 6 deposit = 508)', expectedCashOfShift({ openingCash: 500, salesTotal: 2, depositsTotal: 6, expensesTotal: 0, withdrawalsTotal: 0 }), 508);
eq('G12 card expected cash subtracts expenses and withdrawals', expectedCashOfShift({ openingCash: 100, salesTotal: 315, depositsTotal: 0, expensesTotal: 50, withdrawalsTotal: 14.5 }), 350.5);
eq('G12 missing totals count as zero', expectedCashOfShift({ openingCash: 100 }), 100);

// Offline queue: a refused shift open (unique violation) is recognised so it is dropped instead of retried forever.
eq('QUEUE a unique violation code is a refused shift open', isShiftAlreadyOpenError({ code: '23505' }), true);
eq('QUEUE the index name in the message is a refused shift open', isShiftAlreadyOpenError({ message: 'duplicate key value violates unique constraint "uq_cash_shifts_one_open_per_cashier"' }), true);
eq('QUEUE a network error is not a refused shift open (it keeps retrying)', isShiftAlreadyOpenError(new Error('Failed to fetch')), false);
eq('QUEUE another constraint is not a refused shift open', isShiftAlreadyOpenError({ code: '23503' }), false);
eq('QUEUE null is not a refused shift open', isShiftAlreadyOpenError(null), false);

// K-06 / L (2026-11-26): this device's open shift follows the cloud. Live case: device 511, cloud 526 after a shift closed by sync.
eq('LOCAL=CLOUD a shift closed in the cloud is closed on the device', decideLocalShiftSync(511, { closed_at: '2026-11-26T00:54:31Z' }, null, false), 'close');
eq('LOCAL=CLOUD closed in the cloud wins even with pending operations', decideLocalShiftSync(511, { closed_at: '2026-11-26T00:54:31Z' }, null, true), 'close');
eq('LOCAL=CLOUD another session sold on the same shift: reseed from cloud (511 → 526)', decideLocalShiftSync(511, { closed_at: null }, 526, false), 'refresh');
eq('LOCAL=CLOUD with local operations still queued the device is kept (cloud is behind)', decideLocalShiftSync(511, { closed_at: null }, 526, true), 'keep');
eq('LOCAL=CLOUD same balance: nothing to do', decideLocalShiftSync(526, { closed_at: null }, 526, false), 'keep');
eq('LOCAL=CLOUD no cloud copy yet (opened offline): kept', decideLocalShiftSync(526, null, null, false), 'keep');
eq('LOCAL=CLOUD cloud balance unknown: kept', decideLocalShiftSync(526, { closed_at: null }, null, false), 'keep');

console.log(`${failed ? 'FAIL' : 'PASS'} cashbox-shift-adopt: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
