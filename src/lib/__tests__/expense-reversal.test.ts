import { computeProfitSummary, expenseIsCounted } from '../profit-engine';

let failed = 0;
let passed = 0;
function eq(name: string, actual: number, expected: number) {
  if (Math.abs(actual - expected) < 1e-9) passed++;
  else { failed++; console.log(`FAIL ${name}: expected ${expected} got ${actual}`); }
}
const day = (v: string) => v.slice(0, 10);
const sale = { id: 'INV-1', type: 'sale', status: 'completed', paymentType: 'cash', total: 100, taxAmount: 0, profit: 40, createdAt: '2026-11-01T10:00:00Z' };
const expenseTotal = (exp: object, from: string, to: string) =>
  computeProfitSummary({ invoices: [sale], expenses: [exp as never], range: { from, to }, dayOf: day } as never).expenses as number;

// Audit U6: an expense of 50 on 2026-11-01, reversed on 2026-11-05.
const active = { amount: 50, date: '2026-11-01T09:00:00Z' };
const reversedLater = { amount: 50, date: '2026-11-01T09:00:00Z', isReversed: true, reversedAt: '2026-11-05T10:00:00Z' };
const reversedSameDay = { amount: 50, date: '2026-11-01T09:00:00Z', isReversed: true, reversedAt: '2026-11-01T18:00:00Z' };
eq('U6 active expense counts for 1 Nov', expenseTotal(active, '2026-11-01', '2026-11-01'), 50);
eq('U6 expense reversed on 5 Nov still counts for the 1 Nov period', expenseTotal(reversedLater, '2026-11-01', '2026-11-01'), 50);
eq('U6 expense reversed on 1 Nov does not count for the 1 Nov period', expenseTotal(reversedSameDay, '2026-11-01', '2026-11-01'), 0);
eq('U6 expense reversed on 5 Nov does not count for 1-5 Nov', expenseTotal(reversedLater, '2026-11-01', '2026-11-05'), 0);
eq('reversed without a reversal date does not count (legacy rows)', expenseTotal({ amount: 50, date: '2026-11-01', isReversed: true }, '2026-11-01', '2026-11-01'), 0);

eq('expenseIsCounted: active', expenseIsCounted({ isReversed: false }, '2026-11-01', day) ? 1 : 0, 1);
eq('expenseIsCounted: reversed after the end', expenseIsCounted({ isReversed: true, reversedAt: '2026-11-05T00:00:00Z' }, '2026-11-01', day) ? 1 : 0, 1);

// Audit F6: pending profit of a past period must not use a later collection (sale 100, profit 40, paid 100 on 4 Nov).
{
  const debtSale = { id: 'INV-D', type: 'sale', status: 'completed', paymentType: 'debt', total: 100, taxAmount: 0, profit: 40, debtPaid: 0, paidAtSale: 0, createdAt: '2026-11-01T10:00:00Z' };
  const payment = { invoiceId: 'INV-D', amount: 100, date: '2026-11-04T10:00:00Z' };
  const at = (to: string) => computeProfitSummary({ invoices: [debtSale], payments: [payment], range: { from: '2026-11-01', to }, dayOf: day } as never);
  eq('F6 pending as of 1 Nov (paid on 4 Nov) = 40', at('2026-11-01').pendingProfit, 40);
  eq('F6 realized as of 1 Nov = 0', at('2026-11-01').realizedProfit, 0);
  eq('F6 pending as of 4 Nov = 0', at('2026-11-04').pendingProfit, 0);
  eq('F6 realized as of 4 Nov = 40', at('2026-11-04').realizedProfit, 40);
}

// Audit F5: a sale refunded AFTER the period end is still a sale of that period, with its original profit.
{
  const original = { id: 'INV-R', type: 'sale', status: 'refunded', paymentType: 'cash', total: 100, taxAmount: 0, profit: 0, originalProfit: 40, refundedAt: '2026-11-05T10:00:00Z', createdAt: '2026-11-01T10:00:00Z' };
  const sales = (from: string, to: string) => computeProfitSummary({ invoices: [original], range: { from, to }, dayOf: day } as never).sales as number;
  const profit = (from: string, to: string) => computeProfitSummary({ invoices: [original], range: { from, to }, dayOf: day } as never).realizedProfit as number;
  eq('F5 sale refunded on 5 Nov still counts in the 1 Nov period (sales 100)', sales('2026-11-01', '2026-11-01'), 100);
  eq('F5 ... and keeps its original profit 40 in that period', profit('2026-11-01', '2026-11-01'), 40);
  eq('F5 refunded on 5 Nov does not count in the 1-5 Nov period', sales('2026-11-01', '2026-11-05'), 0);
  const sameDay = { ...original, refundedAt: '2026-11-01T18:00:00Z' };
  eq('F5 refund on the period day removes the sale from that period', computeProfitSummary({ invoices: [sameDay], range: { from: '2026-11-01', to: '2026-11-01' }, dayOf: day } as never).sales as number, 0);
  eq('F5 refund without a known day keeps the old behaviour (no sale)', computeProfitSummary({ invoices: [{ ...original, originalProfit: null, refundedAt: null }], range: { from: '2026-11-01', to: '2026-11-01' }, dayOf: day } as never).sales as number, 0);
}

console.log(`${failed ? 'FAIL' : 'PASS'} expense-reversal: ${passed} passed, ${failed} failed`);
console.log(`Passed Cases: ${passed}`);
console.log(`Failed Cases: ${failed}`);
process.exit(failed ? 1 : 0);
