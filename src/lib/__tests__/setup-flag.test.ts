// Production-code test: when a cloud store row counts as "already set up" (the setup wizard runs once per account).
import { isConfiguredStoreRow } from '../setup-flag';

let failed = 0;
let passed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) passed++;
  else { failed++; console.log(`FAIL ${name}: expected ${String(expected)} got ${String(actual)}`); }
}

eq('SETUP no store row is not configured', isConfiguredStoreRow(null), false);
eq('SETUP a grocery store is configured', isConfiguredStoreRow({ name: 'متجري', store_type: 'grocery' }), true);
eq('SETUP a custom name with general type is configured', isConfiguredStoreRow({ name: 'My shop', store_type: 'general' }), true);
eq('SETUP the default name with general type is NOT configured', isConfiguredStoreRow({ name: 'PosFlow Store', store_type: 'general' }), false);
eq('SETUP the demo store name is NOT configured', isConfiguredStoreRow({ name: 'متجر فلو التجريبي', store_type: null }), false);
eq('SETUP an empty row is NOT configured', isConfiguredStoreRow({ name: '', store_type: '' }), false);

console.log(`${failed ? 'FAIL' : 'PASS'} setup-flag: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
