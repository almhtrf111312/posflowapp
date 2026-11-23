import { debtCreditUsd, debtFxDifferenceUsd, maxPayableInCurrency, resolveDebtFxPolicy } from '../debt-fx';

let failed = 0;
let passed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = typeof expected === 'number' ? Math.abs(Number(actual) - expected) < 1e-6 : actual === expected;
  if (ok) { passed++; } else { failed++; console.log(`FAIL ${name}: expected ${String(expected)} got ${String(actual)}`); }
}

const syp = { currency: 'SYP', exchangeRate: 15000 };
// Debt 100 USD on an SYP invoice at 15000. Customer pays 750,000 SYP when today's rate is 20000 (cash 37.5 USD).
const p = resolveDebtFxPolicy(syp, 'SYP');
eq('policy applies: same non-USD currency', p?.invoiceRate, 15000);
eq('credit = 750000 / 15000', debtCreditUsd(p, 750000, 37.5), 50);
eq('fx difference loss = 37.5 - 50', debtFxDifferenceUsd(p, 37.5, 50), -12.5);
// Rate fell to 12000: cash 62.5, credit still 50 -> gain 12.5
eq('fx difference gain', debtFxDifferenceUsd(p, 62.5, debtCreditUsd(p, 750000, 62.5)), 12.5);
eq('max payable uses invoice rate', maxPayableInCurrency(100, p, 20000), 1500000);

// Legacy behaviour everywhere else
eq('USD payment: no policy', resolveDebtFxPolicy(syp, 'USD'), null);
eq('other currency: no policy', resolveDebtFxPolicy(syp, 'TRY'), null);
eq('cash debt: no policy', resolveDebtFxPolicy(syp, 'SYP', true), null);
eq('USD invoice: no policy', resolveDebtFxPolicy({ currency: 'USD', exchangeRate: 1 }, 'SYP'), null);
eq('missing rate: no policy', resolveDebtFxPolicy({ currency: 'SYP', exchangeRate: 0 }, 'SYP'), null);
eq('no invoice: no policy', resolveDebtFxPolicy(null, 'SYP'), null);
eq('legacy credit = cash', debtCreditUsd(null, 450000, 30), 30);
eq('legacy max uses today rate', maxPayableInCurrency(100, null, 20000), 2000000);
eq('legacy fx difference = 0', debtFxDifferenceUsd(null, 30, 30), 0);
eq('case-insensitive currency', resolveDebtFxPolicy({ currency: 'syp', exchangeRate: 15000 }, ' syp ')?.invoiceCurrency, 'SYP');

console.log(`${failed ? 'FAIL' : 'PASS'} debt-fx: ${passed} passed, ${failed} failed`);
console.log(`Passed Cases: ${passed}`);
console.log(`Failed Cases: ${failed}`);
process.exit(failed ? 1 : 0);
