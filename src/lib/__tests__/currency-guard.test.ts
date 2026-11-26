// F-05: a new money operation in a currency that is not set up is refused; it is never converted at a silent rate of 1.
import { assertCurrencyUsable, CurrencyNotEnabledError, toUsd, refreshMoneyState } from '../money-engine';

let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}`);
  if (!ok) failures++;
};
const refuses = (code: string | null | undefined): boolean => {
  try { assertCurrencyUsable(code); return false; } catch (e) { return e instanceof CurrencyNotEnabledError && /غير مفعّلة/.test(e.message); }
};

check(!refuses('USD') && !refuses('usd') && !refuses(undefined) && !refuses(null), 'USD (and no currency = USD) always passes');
check(refuses('ZZZ'), 'an unknown currency (ZZZ) is refused');
check(refuses('SYP'), 'a known but not enabled currency (SYP, no store settings) is refused');
// Display and historical invoices keep working: conversion with the invoice's own rate snapshot is unaffected.
check(toUsd(15000, 'SYP', 15000) === 1, 'conversion with an explicit rate snapshot still works (15000 SYP @15000 = 1 USD)');

// A configured store (as the settings page saves it): SYP enabled in slot 1 with a rate; TRY enabled in slot 2 without one.
const store: Record<string, string> = {};
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
  },
  addEventListener: () => {},
};
store.posflow_settings_v1 = JSON.stringify({
  primaryCurrency: 'USD', slot1Code: 'SYP', slot2Code: 'TRY',
  exchangeRates: { SYP: 15000 }, enabledCurrencies: { SYP: true, TRY: true },
});
refreshMoneyState();
check(!refuses('SYP'), 'an enabled currency with a rate the store entered passes (SYP @15000)');
check(refuses('TRY'), 'an enabled currency whose rate was never entered is refused (no silent rate of 1)');
check(refuses('EUR'), 'a currency outside the store slots is refused');

if (failures) { console.log(`FAIL ${failures}`); process.exit(1); }
console.log('[PASS] currency guard');
