import { capitalMaxInForeign, capitalOriginalRate, capitalUsdFromForeign, profitUsdFromForeign } from '../partner-fx';

let failed = 0;
let passed = 0;
function eq(name: string, actual: number, expected: number, tol = 1e-6) {
  if (Math.abs(actual - expected) <= tol) passed++;
  else { failed++; console.log(`FAIL ${name}: expected ${expected} got ${actual}`); }
}

// Two capital deposits: 1000 USD at 15000 (15,000,000 SYP) and 500 USD at 12000 (6,000,000 SYP).
const deposits = [
  { type: 'deposit', amount: 1000, originalAmount: 15000000 },
  { type: 'deposit', amount: 500, originalAmount: 6000000 },
];
eq('weighted original rate = 21,000,000 / 1500 = 14000', capitalOriginalRate(deposits), 14000);
eq('capital withdrawal 7,000,000 SYP = 500 USD', capitalUsdFromForeign(7000000, 14000), 500);
eq('whole capital in SYP = 21,000,000', capitalMaxInForeign(1500, 14000), 21000000);
eq('profit withdrawal 1,200,000 SYP at today 12000 = 100 USD', profitUsdFromForeign(1200000, 12000), 100);
eq('profit at a different today rate is different', profitUsdFromForeign(1200000, 15000), 80);
eq('withdrawals and history entries are ignored', capitalOriginalRate([...deposits, { type: 'withdrawal', amount: 200, originalAmount: 2800000 }]), 14000);
eq('USD deposit keeps rate 1', capitalOriginalRate([{ type: 'deposit', amount: 100, originalAmount: 100 }]), 1);
eq('no deposits = 0 (no conversion possible)', capitalOriginalRate([]), 0);
eq('zero rate = 0 USD', capitalUsdFromForeign(100, 0), 0);

console.log(`${failed ? 'FAIL' : 'PASS'} partner-fx: ${passed} passed, ${failed} failed`);
console.log(`Passed Cases: ${passed}`);
console.log(`Failed Cases: ${failed}`);
process.exit(failed ? 1 : 0);
