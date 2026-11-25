// Production-code test: rules for adopting a shift open in the cloud but unknown on this device (cross-device sync).
import { buildAdoptedShift } from '../shift-adopt';

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

console.log(`${failed ? 'FAIL' : 'PASS'} cashbox-shift-adopt: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
