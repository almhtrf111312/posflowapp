// Production-code test (D-35): which drawer a cash operation goes to, from the real decideCashDrawer used by getCashDrawerId.
import { decideCashDrawer } from '../shift-adopt';

let failed = 0;
let passed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) passed++;
  else { failed++; console.log(`FAIL ${name}: expected ${String(expected)} got ${String(actual)}`); }
}

const G = 'general-1';
const S = 'shift-1';
// Defaults: cashier must open a shift; the owner may work without one.
eq('GD cashier with an open shift uses the shift', decideCashDrawer({ activeShiftId: S, generalDrawerId: G, role: 'cashier', sync: {} }).drawerId, S);
eq('GD cashier without a shift (default required) gets no drawer', decideCashDrawer({ activeShiftId: null, generalDrawerId: G, role: 'cashier', sync: {} }).drawerId, null);
eq('GD cashier default: shift required', decideCashDrawer({ activeShiftId: null, generalDrawerId: G, role: 'cashier', sync: {} }).shiftRequired, true);
eq('GD cashier with the requirement turned off uses the general drawer', decideCashDrawer({ activeShiftId: null, generalDrawerId: G, role: 'cashier', sync: { requireShiftCashier: false } }).drawerId, G);
eq('GD owner without a shift (default) uses the general drawer', decideCashDrawer({ activeShiftId: null, generalDrawerId: G, role: 'admin', sync: {} }).drawerId, G);
eq('GD boss without a shift (default) uses the general drawer', decideCashDrawer({ activeShiftId: null, generalDrawerId: G, role: 'boss', sync: {} }).drawerId, G);
eq('GD owner with the requirement turned on gets no drawer', decideCashDrawer({ activeShiftId: null, generalDrawerId: G, role: 'admin', sync: { requireShiftOwner: true } }).drawerId, null);
eq('GD owner with an open shift still uses the shift', decideCashDrawer({ activeShiftId: S, generalDrawerId: G, role: 'admin', sync: {} }).drawerId, S);
eq('GD unknown role is treated as a cashier', decideCashDrawer({ activeShiftId: null, generalDrawerId: G, role: undefined, sync: {} }).drawerId, null);
eq('GD no cached general drawer (never online) gives no drawer, as before', decideCashDrawer({ activeShiftId: null, generalDrawerId: null, role: 'admin', sync: {} }).drawerId, null);
eq('GD a non-boolean setting does not turn the cashier requirement off', decideCashDrawer({ activeShiftId: null, generalDrawerId: G, role: 'cashier', sync: { requireShiftCashier: 'false' } }).drawerId, null);

// Per-user setting (Settings → Users) overrides the role default.
eq('GD per-user: a cashier allowed without a shift uses the general drawer', decideCashDrawer({ activeShiftId: null, generalDrawerId: G, role: 'cashier', sync: { requireShiftByUser: { c1: false } }, userId: 'c1' }).drawerId, G);
eq('GD per-user: another cashier keeps the default (required)', decideCashDrawer({ activeShiftId: null, generalDrawerId: G, role: 'cashier', sync: { requireShiftByUser: { c1: false } }, userId: 'c2' }).drawerId, null);
eq('GD per-user: an owner can be required', decideCashDrawer({ activeShiftId: null, generalDrawerId: G, role: 'admin', sync: { requireShiftByUser: { o1: true } }, userId: 'o1' }).drawerId, null);

console.log(`Passed Cases: ${passed}`);
console.log(`Failed Cases: ${failed}`);
console.log(`${failed ? 'FAIL' : 'PASS'} general-drawer: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
