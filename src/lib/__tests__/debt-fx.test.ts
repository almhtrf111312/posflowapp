import { applyLocalDebtSettlement } from '../debt-settlement';
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

// Compare at the eight decimal places used by record_debt_payment_atomic.
eq('tiny foreign credit matches SQL', debtCreditUsd(p, 1, 0.00005).toFixed(8), '0.00006667');
eq('tiny FX loss matches SQL', debtFxDifferenceUsd(p, 0.00005, 0.00006667).toFixed(8), '-0.00001667');

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

const debt = { totalDebt: 10, totalPaid: 0, remainingDebt: 10 };
for (const credit of [9.95, 9.96, 10, 10.04, 10.05]) {
  const projected = applyLocalDebtSettlement(debt, credit);
  eq('snapped credit ' + credit, projected.totalPaid, 10);
  eq('snapped remaining ' + credit, projected.remainingDebt, 0);
}
eq('outside tolerance stays open', applyLocalDebtSettlement(debt, 9.94999999).remainingDebt.toFixed(8), '0.05000001');
let refused = false;
try { applyLocalDebtSettlement(debt, 10.05000001); } catch { refused = true; }
eq('overpayment beyond tolerance refused', refused, true);

console.log(`${failed ? 'FAIL' : 'PASS'} debt-fx: ${passed} passed, ${failed} failed`);
console.log(`Passed Cases: ${passed}`);
console.log(`Failed Cases: ${failed}`);
process.exit(failed ? 1 : 0);
