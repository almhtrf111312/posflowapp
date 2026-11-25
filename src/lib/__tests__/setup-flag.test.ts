// Production-code test: when a cloud store row counts as "already set up" (the setup wizard runs once per account).
import { isConfiguredStoreRow, isGoogleOnlyIdentities, isNewGoogleAccount } from '../setup-flag';

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

// The Google case that made the wizard appear at every login and overwrite store settings.
const google = [{ provider: 'google' }];
eq('GOOGLE a Google-only identity is detected', isGoogleOnlyIdentities(google), true);
eq('GOOGLE email + Google identities are not Google-only', isGoogleOnlyIdentities([{ provider: 'email' }, { provider: 'google' }]), false);
eq('GOOGLE a Google-only account with an unconfigured store is NEW (wizard)', isNewGoogleAccount(google, false), true);
eq('GOOGLE a Google-only account with a configured store is NOT new (no wizard)', isNewGoogleAccount(google, true), false);
eq('GOOGLE an email account is never new through Google', isNewGoogleAccount([{ provider: 'email' }], false), false);
eq('GOOGLE no identities is not new', isNewGoogleAccount(undefined, false), false);

console.log(`${failed ? 'FAIL' : 'PASS'} setup-flag: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
