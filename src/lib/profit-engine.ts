/**
 * Profit engine: the single definition of sales, realized profit, pending
 * profit, bad-debt loss and net profit used by the dashboard, the reports and
 * (mirrored in SQL) the accounting period close.
 *
 * Owner-approved definition (Phase 2 of the accounting remediation):
 *   - Sales            = invoice totals excluding tax, cash and credit, on the sale day.
 *   - Realized profit  = cash invoice: full profit on the sale day.
 *                        credit invoice: profit x (amount paid / invoice total),
 *                        booked on the day each amount was paid. Amounts paid
 *                        without a dated payment record count as paid on the sale day.
 *   - Pending profit   = profit x (remaining / total) for every open debt.
 *                        Shown separately, never part of net profit.
 *   - Bad-debt loss    = written-off amount minus its pending profit, on the
 *                        write-off day (the pending profit is cancelled, not a loss).
 *   - Net profit       = realized profit - expenses - bad-debt loss.
 *
 * This file is pure: no storage, no network, no React. All amounts are in the
 * base currency (USD) exactly as stored on the invoice.
 */

export interface ProfitInvoiceInput {
  /** Original sale profit from the profit records. Kept because a refund zeroes the stored profit (audit F5). */
  originalProfit?: number | null;
  /** When the invoice was refunded (from the profit record). A refund after a period end does not change that period. */
  refundedAt?: string | null;
  /** Invoice number: the key debts and write-offs refer to. */
  id: string;
  type?: string;
  status?: string;
  paymentType?: string;
  total: number;
  taxAmount?: number;
  profit?: number;
  /** Total collected so far on a credit invoice (down payment + later payments). */
  debtPaid?: number;
  /** Amount collected at sale time, when the server recorded it. Diagnostic only. */
  paidAtSale?: number | null;
  createdAt: string;
  updatedAt?: string;
}

export interface ProfitPaymentInput {
  invoiceId: string;
  amount: number;
  /** When the payment was received. */
  date: string;
}

export interface ProfitWriteoffInput {
  /** Invoice number, or null/empty for a cash loan with no invoice. */
  invoiceId?: string | null;
  amount: number;
  date: string;
  /** Loss stored by the server at write-off time; preferred over recomputing. */
  lossAmount?: number | null;
}

export interface ProfitExpenseInput {
  amount: number;
  date: string;
  isReversed?: boolean;
  /** When the expense was reversed. Needed so earlier periods keep it (audit U6, 2026-11-24). */
  reversedAt?: string | null;
}

/**
 * An invoice refunded after the period end is still a sale of that period, valued with its original profit.
 * (audit F5, 2026-11-24). Only refunds with a known refund day and original profit are changed.
 */
function asOfRangeEnd(inv: ProfitInvoiceInput, range: ProfitRange | undefined, dayOf: (value: string) => string): ProfitInvoiceInput {
  if (!range?.to) return inv;
  if (inv.status !== 'refunded') return inv;
  if (inv.originalProfit === null || inv.originalProfit === undefined || !inv.refundedAt) return inv;
  if (dayOf(inv.refundedAt) <= range.to) return inv;
  return { ...inv, status: 'completed', profit: inv.originalProfit };
}

/**
 * An expense counts for a period ending on `rangeTo` unless it was reversed on or before that day.
 * A reversal after the period end does not remove the expense from that period.
 */
export function expenseIsCounted(
  e: { isReversed?: boolean; is_reversed?: boolean; reversedAt?: string | null },
  rangeTo: string | undefined,
  dayOf: (value: string) => string,
): boolean {
  // Cloud expenses carry the flag as `is_reversed` (expenses-cloud.ts). Reading only `isReversed` counted reversed expenses
  // in the Reports expense total and net profit (found by plan J-04, 2026-11-26).
  if (!(e.isReversed ?? e.is_reversed)) return true;
  if (!e.reversedAt || !rangeTo) return false;
  return dayOf(e.reversedAt) > rangeTo;
}

export interface ProfitRange {
  /** Inclusive local day, YYYY-MM-DD. Omit for "from the beginning". */
  from?: string;
  /** Inclusive local day, YYYY-MM-DD. Omit for "until now". */
  to?: string;
}

export interface ProfitEngineInput {
  invoices: ProfitInvoiceInput[];
  payments?: ProfitPaymentInput[];
  writeoffs?: ProfitWriteoffInput[];
  expenses?: ProfitExpenseInput[];
  range?: ProfitRange;
  /** Turns a stored timestamp into a local YYYY-MM-DD day. */
  dayOf?: (value: string) => string;
  /**
   * Report filters (cashier, payment type...). Invoices that fail it are left
   * out of every figure, and so are the write-offs that belong to them.
   */
  invoiceFilter?: (invoice: ProfitInvoiceInput) => boolean;
}

export interface ProfitDay {
  date: string;
  sales: number;
  /** The same day's invoice totals including tax (the sales figure shown in reports, owner decision 2026-11-26). */
  salesWithTax: number;
  orders: number;
  realizedProfit: number;
  expenses: number;
  badDebtLoss: number;
  netProfit: number;
}

export interface ProfitSummary {
  /** Invoice totals excluding tax, for invoices sold in the range. */
  sales: number;
  /** The same invoices including tax. */
  salesWithTax: number;
  orders: number;
  realizedProfit: number;
  /** Part of realizedProfit that came from cash invoices. */
  realizedFromCash: number;
  /** Part that came from amounts paid on credit invoices on the sale day. */
  realizedFromDownPayments: number;
  /** Part that came from later, dated debt payments. */
  realizedFromCollections: number;
  /** Profit still waiting on open debts sold up to the end of the range. */
  pendingProfit: number;
  expenses: number;
  badDebtLoss: number;
  /** Pending profit cancelled by write-offs in the range (not a loss). */
  cancelledPendingProfit: number;
  netProfit: number;
  /** Paid amounts with no dated record that exceed the recorded down payment. */
  undatedCollections: number;
  days: ProfitDay[];
}

export interface InvoiceProfitTimeline {
  saleDay: string;
  revenue: number;
  revenueWithTax: number;
  isCredit: boolean;
  /** Profit realized on the sale day. */
  saleDayProfit: number;
  /** Profit realized by each dated payment. */
  collections: { day: string; amount: number; profit: number }[];
  writeoff: { day: string; amount: number; cancelledPending: number; loss: number } | null;
  pendingProfit: number;
  undatedCollections: number;
  /** Inputs needed to value the pending profit as of a given day (audit F6, 2026-11-24). */
  pendingBase: { total: number; profit: number; paidTotal: number; isWrittenOff: boolean };
}

/** Pending profit of an invoice as of `to`: payments dated after `to` have not happened yet for that period. */
function pendingProfitAsOf(t: InvoiceProfitTimeline, to?: string): number {
  if (!t.isCredit) return 0;
  if (!to) return t.pendingProfit;
  if (t.writeoff && t.writeoff.day <= to) return 0;
  const { total, profit, paidTotal } = t.pendingBase;
  if (total <= 0) return 0;
  const laterCollections = t.collections.filter(c => c.day > to).reduce((sum, c) => sum + c.amount, 0);
  const collectedByEnd = Math.max(0, paidTotal - laterCollections);
  const unpaidAtEnd = Math.max(0, total - collectedByEnd);
  return profit * (unpaidAtEnd / total);
}

const round8 = (value: number): number => Math.round((value + Number.EPSILON) * 1e8) / 1e8;

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Local YYYY-MM-DD of a timestamp; plain dates pass through untouched. */
export function defaultDayOf(value: string): string {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Refunded and cancelled invoices never count; written-off ones still count as sales. */
export function isCountedInvoice(invoice: { status?: string; type?: string }): boolean {
  if (invoice.status === 'refunded' || invoice.status === 'cancelled') return false;
  if (invoice.type && invoice.type !== 'sale' && invoice.type !== 'maintenance') return false;
  return true;
}

const inRange = (day: string, range?: ProfitRange): boolean => {
  if (!day) return false;
  if (range?.from && day < range.from) return false;
  if (range?.to && day > range.to) return false;
  return true;
};

/**
 * Where and when one invoice's profit lands.
 * `payments` and `writeoffs` must already be the ones of this invoice.
 */
export function buildInvoiceProfitTimeline(
  invoice: ProfitInvoiceInput,
  payments: ProfitPaymentInput[] = [],
  writeoffs: ProfitWriteoffInput[] = [],
  dayOf: (value: string) => string = defaultDayOf,
): InvoiceProfitTimeline {
  const total = num(invoice.total);
  const profit = num(invoice.profit);
  const saleDay = dayOf(invoice.createdAt);
  const revenueWithTax = total;
  const revenue = total - num(invoice.taxAmount);
  const isCredit = invoice.paymentType === 'debt';

  if (!isCredit || total <= 0) {
    return {
      saleDay, revenue, revenueWithTax, isCredit,
      saleDayProfit: profit,
      collections: [], writeoff: null, pendingProfit: 0, undatedCollections: 0,
      pendingBase: { total, profit, paidTotal: 0, isWrittenOff: false },
    };
  }

  const share = (amount: number): number => profit * (amount / total);

  const dated = payments
    .map(p => ({ day: dayOf(p.date), amount: Math.max(0, num(p.amount)), at: p.date }))
    .filter(p => p.amount > 0 && p.day)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const datedSum = dated.reduce((s, p) => s + p.amount, 0);

  // What the invoice itself says was collected is the authority; dated
  // records can only raise it (a payment synced before the invoice refreshed).
  const paidByInvoice = invoice.status === 'paid' ? total : clamp(num(invoice.debtPaid), 0, total);
  const paidTotal = Math.max(paidByInvoice, Math.min(total, datedSum));

  // Dated payments are honoured in order, never beyond what was collected.
  let datedBudget = paidTotal;
  const collections: InvoiceProfitTimeline['collections'] = [];
  for (const p of dated) {
    const amount = Math.min(p.amount, datedBudget);
    if (amount <= 0) break;
    datedBudget -= amount;
    collections.push({ day: p.day, amount, profit: share(amount) });
  }
  // Whatever was collected without a dated record counts as paid on the sale day.
  const saleDayPaid = Math.max(0, datedBudget);
  const knownDownPayment = invoice.paidAtSale === null || invoice.paidAtSale === undefined
    ? null
    : clamp(num(invoice.paidAtSale), 0, total);
  const undatedCollections = knownDownPayment === null ? 0 : Math.max(0, saleDayPaid - knownDownPayment);

  const unpaid = Math.max(0, total - paidTotal);
  const isWrittenOff = invoice.status === 'written_off' || writeoffs.length > 0;

  let writeoff: InvoiceProfitTimeline['writeoff'] = null;
  if (isWrittenOff && unpaid > 0) {
    const recorded = writeoffs.reduce((s, w) => s + Math.max(0, num(w.amount)), 0);
    const amount = recorded > 0 ? Math.min(recorded, unpaid) : unpaid;
    const cancelledPending = share(amount);
    const storedLoss = writeoffs.length === 1 && writeoffs[0].lossAmount !== null && writeoffs[0].lossAmount !== undefined
      ? num(writeoffs[0].lossAmount)
      : null;
    const lastWriteoff = writeoffs.length > 0
      ? writeoffs.reduce((latest, w) => (w.date > latest.date ? w : latest))
      : null;
    writeoff = {
      day: dayOf(lastWriteoff?.date || invoice.updatedAt || invoice.createdAt),
      amount,
      cancelledPending,
      loss: storedLoss !== null ? storedLoss : amount - cancelledPending,
    };
  }

  return {
    saleDay, revenue, revenueWithTax, isCredit,
    saleDayProfit: share(saleDayPaid),
    collections,
    writeoff,
    pendingProfit: isWrittenOff ? 0 : share(unpaid),
    undatedCollections,
    pendingBase: { total, profit, paidTotal, isWrittenOff },
  };
}

/**
 * Profit realized on one invoice up to now, for invoice lists (detailed sales,
 * cashier performance, maintenance, exports): the full profit of a cash invoice,
 * and only the collected share of a credit invoice. The uncollected share is
 * pending (or cancelled once the debt is written off) and is never counted.
 */
export function realizedProfitToDate(invoice: {
  status?: string;
  type?: string;
  paymentType?: string;
  total?: number;
  profit?: number;
  debtPaid?: number;
}): number {
  if (invoice.status === 'refunded' || invoice.status === 'cancelled') return 0;
  const timeline = buildInvoiceProfitTimeline({
    id: '',
    status: invoice.status,
    paymentType: invoice.paymentType,
    total: num(invoice.total),
    profit: num(invoice.profit),
    debtPaid: num(invoice.debtPaid),
    createdAt: '',
  });
  return round8(timeline.saleDayProfit);
}

export function computeProfitSummary(input: ProfitEngineInput): ProfitSummary {
  const dayOf = input.dayOf ?? defaultDayOf;
  const range = input.range;
  const filter = input.invoiceFilter;

  const paymentsByInvoice = new Map<string, ProfitPaymentInput[]>();
  for (const p of input.payments ?? []) {
    if (!p.invoiceId) continue;
    const list = paymentsByInvoice.get(p.invoiceId);
    if (list) list.push(p); else paymentsByInvoice.set(p.invoiceId, [p]);
  }
  const writeoffsByInvoice = new Map<string, ProfitWriteoffInput[]>();
  const looseWriteoffs: ProfitWriteoffInput[] = [];
  for (const w of input.writeoffs ?? []) {
    if (!w.invoiceId) { looseWriteoffs.push(w); continue; }
    const list = writeoffsByInvoice.get(w.invoiceId);
    if (list) list.push(w); else writeoffsByInvoice.set(w.invoiceId, [w]);
  }

  const days = new Map<string, ProfitDay>();
  const dayRow = (date: string): ProfitDay => {
    let row = days.get(date);
    if (!row) {
      row = { date, sales: 0, salesWithTax: 0, orders: 0, realizedProfit: 0, expenses: 0, badDebtLoss: 0, netProfit: 0 };
      days.set(date, row);
    }
    return row;
  };

  let sales = 0;
  let salesWithTax = 0;
  let orders = 0;
  let realizedFromCash = 0;
  let realizedFromDownPayments = 0;
  let realizedFromCollections = 0;
  let pendingProfit = 0;
  let badDebtLoss = 0;
  let cancelledPendingProfit = 0;
  let undatedCollections = 0;

  const knownInvoiceIds = new Set<string>();
  for (const rawInvoice of input.invoices) {
    const invoice = asOfRangeEnd(rawInvoice, range, dayOf);
    knownInvoiceIds.add(invoice.id);
    if (!isCountedInvoice(invoice)) continue;
    if (filter && !filter(invoice)) continue;

    const timeline = buildInvoiceProfitTimeline(
      invoice,
      paymentsByInvoice.get(invoice.id),
      writeoffsByInvoice.get(invoice.id),
      dayOf,
    );

    if (inRange(timeline.saleDay, range)) {
      sales += timeline.revenue;
      salesWithTax += timeline.revenueWithTax;
      orders += 1;
      if (timeline.isCredit) realizedFromDownPayments += timeline.saleDayProfit;
      else realizedFromCash += timeline.saleDayProfit;
      undatedCollections += timeline.undatedCollections;
      const row = dayRow(timeline.saleDay);
      row.sales += timeline.revenue;
      row.salesWithTax += timeline.revenueWithTax;
      row.orders += 1;
      row.realizedProfit += timeline.saleDayProfit;
    }

    for (const c of timeline.collections) {
      if (!inRange(c.day, range)) continue;
      realizedFromCollections += c.profit;
      dayRow(c.day).realizedProfit += c.profit;
    }

    if (timeline.writeoff && inRange(timeline.writeoff.day, range)) {
      badDebtLoss += timeline.writeoff.loss;
      cancelledPendingProfit += timeline.writeoff.cancelledPending;
      dayRow(timeline.writeoff.day).badDebtLoss += timeline.writeoff.loss;
    }

    // Pending profit is a balance: every open debt sold up to the end of the range.
    if (!range?.to || timeline.saleDay <= range.to) {
      pendingProfit += pendingProfitAsOf(timeline, range?.to);
    }
  }

  // Write-offs with no invoice behind them (cash loans): the whole amount is lost.
  // With report filters on they are left out, like everything outside the filter.
  if (!filter) {
    const orphaned = [...writeoffsByInvoice.entries()]
      .filter(([invoiceId]) => !knownInvoiceIds.has(invoiceId))
      .flatMap(([, list]) => list);
    for (const w of [...looseWriteoffs, ...orphaned]) {
      const day = dayOf(w.date);
      if (!inRange(day, range)) continue;
      const loss = w.lossAmount !== null && w.lossAmount !== undefined ? num(w.lossAmount) : Math.max(0, num(w.amount));
      badDebtLoss += loss;
      dayRow(day).badDebtLoss += loss;
    }
  }

  let expenses = 0;
  for (const e of input.expenses ?? []) {
    const day = dayOf(e.date);
    if (!inRange(day, range)) continue;
    if (!expenseIsCounted(e, range?.to, dayOf)) continue;
    const amount = num(e.amount);
    expenses += amount;
    dayRow(day).expenses += amount;
  }

  const realizedProfit = realizedFromCash + realizedFromDownPayments + realizedFromCollections;
  const sortedDays = [...days.values()]
    .map(d => ({
      date: d.date,
      sales: round8(d.sales),
      salesWithTax: round8(d.salesWithTax),
      orders: d.orders,
      realizedProfit: round8(d.realizedProfit),
      expenses: round8(d.expenses),
      badDebtLoss: round8(d.badDebtLoss),
      netProfit: round8(d.realizedProfit - d.expenses - d.badDebtLoss),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    sales: round8(sales),
    salesWithTax: round8(salesWithTax),
    orders,
    realizedProfit: round8(realizedProfit),
    realizedFromCash: round8(realizedFromCash),
    realizedFromDownPayments: round8(realizedFromDownPayments),
    realizedFromCollections: round8(realizedFromCollections),
    pendingProfit: round8(pendingProfit),
    expenses: round8(expenses),
    badDebtLoss: round8(badDebtLoss),
    cancelledPendingProfit: round8(cancelledPendingProfit),
    netProfit: round8(realizedProfit - expenses - badDebtLoss),
    undatedCollections: round8(undatedCollections),
    days: sortedDays,
  };
}
