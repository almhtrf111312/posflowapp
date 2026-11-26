import {
  buildInvoiceProfitTimeline,
  computeProfitSummary,
  realizedProfitToDate,
  type ProfitInvoiceInput,
} from '../profit-engine';

// Plain dates are used on purpose so the results do not depend on the machine time zone.
const inv = (overrides: Partial<ProfitInvoiceInput> = {}): ProfitInvoiceInput => ({
  id: 'INV-1',
  type: 'sale',
  status: 'paid',
  paymentType: 'cash',
  total: 100,
  taxAmount: 0,
  profit: 30,
  debtPaid: 0,
  createdAt: '2026-01-10',
  ...overrides,
});

function assertEqual(actual: number, expected: number, message: string) {
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function test(name: string, run: () => void) {
  try {
    run();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    console.error(`[FAIL] ${name}`, error);
    (globalThis as { process?: { exitCode?: number } }).process!.exitCode = 1;
  }
}

test('cash sale: full profit on the sale day, nothing pending', () => {
  const s = computeProfitSummary({ invoices: [inv()] });
  assertEqual(s.sales, 100, 'sales');
  assertEqual(s.realizedProfit, 30, 'realized');
  assertEqual(s.pendingProfit, 0, 'pending');
  assertEqual(s.netProfit, 30, 'net');
});

test('sales exclude tax', () => {
  const s = computeProfitSummary({ invoices: [inv({ total: 110, taxAmount: 10, profit: 30 })] });
  assertEqual(s.sales, 100, 'sales without tax');
  assertEqual(s.salesWithTax, 110, 'sales with tax');
  // T-4: the daily row carries the tax-inclusive figure shown in reports
  assertEqual(s.days[0].salesWithTax, 110, 'daily sales with tax');
  assertEqual(s.days[0].sales, 100, 'daily sales without tax');
});

test('owner example: 100 / profit 30, down payment 40, payment 20, write-off 40', () => {
  // Step 1: sale with a 40 down payment.
  const sale = inv({ paymentType: 'debt', status: 'pending', debtPaid: 40 });
  let s = computeProfitSummary({ invoices: [sale] });
  assertEqual(s.realizedProfit, 12, 'realized after down payment');
  assertEqual(s.pendingProfit, 18, 'pending after down payment');

  // Step 2: a dated payment of 20 on a later day.
  const afterPayment = inv({ paymentType: 'debt', status: 'pending', debtPaid: 60 });
  const payments = [{ invoiceId: 'INV-1', amount: 20, date: '2026-01-20' }];
  s = computeProfitSummary({ invoices: [afterPayment], payments });
  assertEqual(s.realizedProfit, 18, 'realized after payment');
  assertEqual(s.realizedFromDownPayments, 12, 'down payment part');
  assertEqual(s.realizedFromCollections, 6, 'collection part');
  assertEqual(s.pendingProfit, 12, 'pending after payment');
  const payDay = s.days.find(d => d.date === '2026-01-20');
  assertEqual(payDay?.realizedProfit ?? -1, 6, 'profit booked on the payment day');

  // Step 3: the remaining 40 is written off.
  const writtenOff = inv({ paymentType: 'debt', status: 'written_off', debtPaid: 60 });
  const writeoffs = [{ invoiceId: 'INV-1', amount: 40, date: '2026-02-05' }];
  s = computeProfitSummary({ invoices: [writtenOff], payments, writeoffs });
  assertEqual(s.sales, 100, 'a written-off invoice is still a sale');
  assertEqual(s.realizedProfit, 18, 'realized unchanged by the write-off');
  assertEqual(s.pendingProfit, 0, 'pending cancelled');
  assertEqual(s.cancelledPendingProfit, 12, 'cancelled pending profit');
  assertEqual(s.badDebtLoss, 28, 'bad-debt loss');
  assertEqual(s.netProfit, -10, 'net = 18 - 28');
  // Cash check: 60 collected - 70 cost = -10.
});

test('credit sale with no down payment: nothing realized, all pending', () => {
  const s = computeProfitSummary({
    invoices: [inv({ paymentType: 'debt', status: 'pending', debtPaid: 0 })],
  });
  assertEqual(s.sales, 100, 'sales');
  assertEqual(s.realizedProfit, 0, 'realized');
  assertEqual(s.pendingProfit, 30, 'pending');
  assertEqual(s.netProfit, 0, 'net');
});

test('payment in a later month lands in that month, not in the sale month', () => {
  const invoices = [inv({ paymentType: 'debt', status: 'paid', debtPaid: 100 })];
  const payments = [{ invoiceId: 'INV-1', amount: 100, date: '2026-02-03' }];
  const january = computeProfitSummary({ invoices, payments, range: { from: '2026-01-01', to: '2026-01-31' } });
  const february = computeProfitSummary({ invoices, payments, range: { from: '2026-02-01', to: '2026-02-28' } });
  assertEqual(january.sales, 100, 'January sales');
  assertEqual(january.realizedProfit, 0, 'January realized');
  assertEqual(february.sales, 0, 'February sales');
  assertEqual(february.realizedProfit, 30, 'February realized');
  assertEqual(february.pendingProfit, 0, 'nothing pending once paid');
});

test('paid amounts with no dated record count as paid on the sale day', () => {
  const s = computeProfitSummary({
    invoices: [inv({ paymentType: 'debt', status: 'paid', debtPaid: 100 })],
    range: { from: '2026-01-10', to: '2026-01-10' },
  });
  assertEqual(s.realizedProfit, 30, 'realized on the sale day');
});

test('dated payments never realize more than the invoice profit', () => {
  const s = computeProfitSummary({
    invoices: [inv({ paymentType: 'debt', status: 'paid', debtPaid: 100 })],
    payments: [
      { invoiceId: 'INV-1', amount: 80, date: '2026-01-12' },
      { invoiceId: 'INV-1', amount: 80, date: '2026-01-15' },
    ],
  });
  assertEqual(s.realizedProfit, 30, 'capped at the invoice profit');
});

test('write-off of a partially paid invoice sold at a loss', () => {
  // Total 100, profit -5 (cost 105), 60 collected, 40 written off.
  const s = computeProfitSummary({
    invoices: [inv({ paymentType: 'debt', status: 'written_off', debtPaid: 60, profit: -5 })],
    writeoffs: [{ invoiceId: 'INV-1', amount: 40, date: '2026-01-25' }],
  });
  assertEqual(s.realizedProfit, -3, 'realized loss on the collected part');
  assertEqual(s.badDebtLoss, 42, 'loss = 40 - (-2)');
  assertEqual(s.netProfit, -45, 'net = 60 collected - 105 cost');
});

test('the loss stored by the server is used as-is', () => {
  const s = computeProfitSummary({
    invoices: [inv({ paymentType: 'debt', status: 'written_off', debtPaid: 60 })],
    writeoffs: [{ invoiceId: 'INV-1', amount: 40, date: '2026-01-25', lossAmount: 27.5 }],
  });
  assertEqual(s.badDebtLoss, 27.5, 'stored loss');
});

test('write-off of a cash loan with no invoice: the whole amount is lost', () => {
  const s = computeProfitSummary({
    invoices: [],
    writeoffs: [{ invoiceId: null, amount: 15, date: '2026-01-25' }],
  });
  assertEqual(s.badDebtLoss, 15, 'loss');
  assertEqual(s.netProfit, -15, 'net');
});

test('refunded and cancelled invoices are ignored, with their payments', () => {
  const s = computeProfitSummary({
    invoices: [
      inv({ id: 'A', status: 'refunded' }),
      inv({ id: 'B', status: 'cancelled', paymentType: 'debt', debtPaid: 50 }),
    ],
    payments: [{ invoiceId: 'B', amount: 50, date: '2026-01-11' }],
  });
  assertEqual(s.sales, 0, 'sales');
  assertEqual(s.realizedProfit, 0, 'realized');
  assertEqual(s.pendingProfit, 0, 'pending');
});

test('reversed expenses are ignored and net profit subtracts the rest', () => {
  const s = computeProfitSummary({
    invoices: [inv()],
    expenses: [
      { amount: 8, date: '2026-01-10' },
      { amount: 99, date: '2026-01-10', isReversed: true },
    ],
  });
  assertEqual(s.expenses, 8, 'expenses');
  assertEqual(s.netProfit, 22, 'net');
});

test('dashboard (one day), reports (range) and period totals agree', () => {
  const invoices = [
    inv({ id: 'C1', createdAt: '2026-03-01', total: 50, profit: 10 }),
    inv({ id: 'D1', createdAt: '2026-03-01', paymentType: 'debt', status: 'pending', debtPaid: 70, total: 200, profit: 40 }),
    inv({ id: 'D2', createdAt: '2026-03-02', paymentType: 'debt', status: 'written_off', debtPaid: 0, total: 80, profit: 20 }),
    inv({ id: 'C2', createdAt: '2026-03-03', total: 120, taxAmount: 20, profit: 25 }),
  ];
  const payments = [{ invoiceId: 'D1', amount: 50, date: '2026-03-03' }];
  const writeoffs = [{ invoiceId: 'D2', amount: 80, date: '2026-03-03' }];
  const expenses = [{ amount: 12, date: '2026-03-02' }, { amount: 3, date: '2026-03-03' }];
  const all = { invoices, payments, writeoffs, expenses };

  const period = computeProfitSummary({ ...all, range: { from: '2026-03-01', to: '2026-03-03' } });
  const perDay = ['2026-03-01', '2026-03-02', '2026-03-03'].map(day =>
    computeProfitSummary({ ...all, range: { from: day, to: day } }));

  const sum = (pick: (s: typeof period) => number) => perDay.reduce((t, s) => t + pick(s), 0);
  assertEqual(sum(s => s.sales), period.sales, 'sales');
  assertEqual(sum(s => s.realizedProfit), period.realizedProfit, 'realized');
  assertEqual(sum(s => s.expenses), period.expenses, 'expenses');
  assertEqual(sum(s => s.badDebtLoss), period.badDebtLoss, 'bad-debt loss');
  assertEqual(sum(s => s.netProfit), period.netProfit, 'net');
  assertEqual(period.days.reduce((t, d) => t + d.netProfit, 0), period.netProfit, 'daily rows');

  // Hand-checked figures for the same data (also used by the SQL period-close test).
  assertEqual(period.sales, 430, 'sales = 50 + 200 + 80 + 100');
  // D1: 20 paid at sale (70 - 50 dated) -> 4; 50 dated -> 10. C1 10, C2 25.
  assertEqual(period.realizedProfit, 49, 'realized');
  assertEqual(period.pendingProfit, 26, 'pending = 40 x 130/200');
  assertEqual(period.badDebtLoss, 60, 'loss = 80 - 20');
  assertEqual(period.expenses, 15, 'expenses');
  assertEqual(period.netProfit, -26, 'net = 49 - 15 - 60');
});

test('timeline keeps realized + pending + cancelled equal to the invoice profit', () => {
  const t = buildInvoiceProfitTimeline(
    inv({ paymentType: 'debt', status: 'written_off', debtPaid: 60 }),
    [{ invoiceId: 'INV-1', amount: 20, date: '2026-01-20' }],
    [{ invoiceId: 'INV-1', amount: 40, date: '2026-02-05' }],
  );
  const realized = t.saleDayProfit + t.collections.reduce((s, c) => s + c.profit, 0);
  assertEqual(realized + t.pendingProfit + (t.writeoff?.cancelledPending ?? 0), 30, 'identity');
});

test('report filters drop the invoice and its write-off together', () => {
  const s = computeProfitSummary({
    invoices: [
      inv({ id: 'A' }),
      inv({ id: 'B', paymentType: 'debt', status: 'written_off', debtPaid: 0 }),
    ],
    writeoffs: [{ invoiceId: 'B', amount: 100, date: '2026-01-12' }],
    invoiceFilter: i => i.paymentType === 'cash',
  });
  assertEqual(s.sales, 100, 'sales');
  assertEqual(s.badDebtLoss, 0, 'no loss from a filtered-out invoice');
});

test('realized profit to date for invoice lists', () => {
  assertEqual(realizedProfitToDate(inv()), 30, 'cash invoice');
  assertEqual(realizedProfitToDate(inv({ paymentType: 'debt', status: 'pending', debtPaid: 40 })), 12, 'partly paid credit');
  assertEqual(realizedProfitToDate(inv({ paymentType: 'debt', status: 'paid', debtPaid: 0 })), 30, 'credit marked paid');
  assertEqual(realizedProfitToDate(inv({ paymentType: 'debt', status: 'written_off', debtPaid: 60 })), 18, 'written off after 60 collected');
  assertEqual(realizedProfitToDate(inv({ status: 'refunded' })), 0, 'refunded');
});
