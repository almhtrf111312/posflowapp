// Production-code test: an expense reversed offline gives its cash back to the local drawer exactly once (K-05/K-06 finding).
import { markExpensePaidFromDrawer, takeExpensePaidFromDrawer } from '../drawer-expense-marks';

let failed = 0;
let passed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}: expected ${String(expected)} got ${String(actual)}`); }
}
const mem = new Map<string, string>();
const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };

markExpensePaidFromDrawer('shift-1', 'exp-7', store);
eq('K05 an expense paid from the local drawer can be given back once', takeExpensePaidFromDrawer('shift-1', 'exp-7', store), true);
eq('K05 a second queued reversal does not give the cash back twice', takeExpensePaidFromDrawer('shift-1', 'exp-7', store), false);
markExpensePaidFromDrawer('shift-1', 'exp-8', store);
eq('K05 another shift never gets the cash back', takeExpensePaidFromDrawer('shift-2', 'exp-8', store), false);
eq('K05 an expense not paid from this drawer gets nothing back', takeExpensePaidFromDrawer('shift-1', 'exp-unknown', store), false);
eq('K05 no active shift gets nothing back', takeExpensePaidFromDrawer(null, 'exp-8', store), false);
markExpensePaidFromDrawer('shift-1', 'exp-8', store);
eq('K05 marking twice still gives back once', [takeExpensePaidFromDrawer('shift-1', 'exp-8', store), takeExpensePaidFromDrawer('shift-1', 'exp-8', store)].join(','), 'true,false');

console.log(`Passed Cases: ${passed}`);
console.log(`Failed Cases: ${failed}`);
process.exit(failed ? 1 : 0);
