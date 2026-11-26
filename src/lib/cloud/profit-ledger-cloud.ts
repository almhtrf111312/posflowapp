/**
 * Profit ledger: the dated debt payments and debt write-offs the profit engine
 * needs to place credit-sale profit on the day it was actually collected.
 *
 * Read-only. Cached locally so the dashboard and reports keep working offline;
 * a failed fetch never replaces a good cache with an empty one.
 */
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';
import { isLocalDataMode } from '@/hooks/use-network-status';
import { getCurrentUserId } from '../supabase-store';
import type { ProfitPaymentInput, ProfitWriteoffInput } from '../profit-engine';

const sb = supabase;

export interface ProfitLedger {
  payments: ProfitPaymentInput[];
  writeoffs: ProfitWriteoffInput[];
  /**
   * F-27 / D-06: FX differences of foreign-currency debt payments credited at the invoice rate (USD, > 0 gain, < 0 loss).
   * Reported on their own line at the bottom of the net result — never part of sales profit, never shared with partners.
   * Empty until migration 20261123071000 is applied.
   */
  fxDifferences: Array<{ date: string; amountUsd: number }>;
  /** Original sale profit and refund day per invoice (audit F5). Empty when the records cannot be read. */
  profitSnapshots?: Array<{ invoiceId: string; grossProfit: number; recordedAt: string; reversedAt: string | null }>;
  /** When the ledger was last fetched from the server; 0 if never. */
  fetchedAt: number;
}

const CACHE_KEY = 'posflow_profit_ledger_v1';
const CACHE_TTL_MS = 20000;
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

const EMPTY_LEDGER: ProfitLedger = { payments: [], writeoffs: [], fxDifferences: [], fetchedAt: 0 };

let memoryLedger: ProfitLedger | null = null;
let memoryUserId: string | null = null;
let inflight: Promise<ProfitLedger> | null = null;

interface CachedLedger extends ProfitLedger { userId: string }

export function loadProfitLedgerLocally(): ProfitLedger {
  const userId = getCurrentUserId();
  if (memoryLedger && memoryUserId === userId) return memoryLedger;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return EMPTY_LEDGER;
    const parsed = JSON.parse(raw) as CachedLedger;
    if (!parsed || parsed.userId !== userId) return EMPTY_LEDGER;
    if (!Array.isArray(parsed.payments) || !Array.isArray(parsed.writeoffs)) return EMPTY_LEDGER;
    return {
      payments: parsed.payments,
      writeoffs: parsed.writeoffs,
      fxDifferences: Array.isArray(parsed.fxDifferences) ? parsed.fxDifferences : [],
      profitSnapshots: Array.isArray(parsed.profitSnapshots) ? parsed.profitSnapshots : [],
      fetchedAt: Number(parsed.fetchedAt) || 0,
    };
  } catch {
    return EMPTY_LEDGER;
  }
}

function saveLedger(userId: string, ledger: ProfitLedger): void {
  memoryLedger = ledger;
  memoryUserId = userId;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...ledger, userId } satisfies CachedLedger));
  } catch (e) {
    console.warn('[ProfitLedger] cache save failed:', e);
  }
}

export function invalidateProfitLedgerCache(): void {
  if (memoryLedger) memoryLedger = { ...memoryLedger, fetchedAt: 0 };
}

/** Reads every row of a table; throws on any error so callers keep their cache. */
async function fetchAllRows(table: string, columns: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await sb.from(table as keyof Database['public']['Tables']).select(columns).range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchLedger(userId: string): Promise<ProfitLedger> {
  // Original profit records: read separately so a failure never blocks the payments and write-offs.
  const snapshotRows = await fetchAllRows('profit_records', 'invoice_id, gross_profit, revenue, recorded_at, is_reversed, reversed_at').catch(() => []);
  const [debts, payments, writeoffs] = await Promise.all([
    fetchAllRows('debts', 'id, invoice_id, is_cash_debt'),
    // '*' on purpose: settled_amount / fx_difference_usd exist only after the FX migration is applied.
    fetchAllRows('debt_payments', '*'),
    // '*' on purpose: loss_amount exists only after the Phase 2 migration is applied.
    fetchAllRows('debt_writeoffs', '*'),
  ]);

  const invoiceOfDebt = new Map<string, string | null>();
  for (const d of debts) {
    const isCashDebt = d.is_cash_debt === true;
    invoiceOfDebt.set(String(d.id), isCashDebt ? null : (d.invoice_id ? String(d.invoice_id) : null));
  }

  const ledger: ProfitLedger = {
    payments: payments
      .map(p => ({
        invoiceId: invoiceOfDebt.get(String(p.debt_id)) ?? '',
        // What the payment removed from the debt (invoice-rate credit); the cash amount for legacy rows.
        amount: Number(p.settled_amount) > 0 ? Number(p.settled_amount) : (Number(p.amount) || 0),
        date: String(p.created_at ?? ''),
      }))
      .filter(p => p.invoiceId && p.amount > 0 && p.date),
    writeoffs: writeoffs
      .map(w => {
        const debtId = w.debt_id ? String(w.debt_id) : '';
        // The write-off row keeps the invoice number in `notes`; the debt row is the fallback.
        const fromDebt = debtId && invoiceOfDebt.has(debtId) ? invoiceOfDebt.get(debtId) : undefined;
        const invoiceId = fromDebt !== undefined ? fromDebt : (w.notes ? String(w.notes) : null);
        const loss = w.loss_amount;
        return {
          invoiceId,
          amount: Number(w.amount) || 0,
          date: String(w.written_off_at ?? w.created_at ?? ''),
          lossAmount: loss === null || loss === undefined ? null : Number(loss),
        };
      })
      .filter(w => w.amount > 0 && w.date),
    fxDifferences: payments
      .map(p => ({ date: String(p.created_at ?? ''), amountUsd: Number(p.fx_difference_usd) || 0 }))
      .filter(f => f.date && f.amountUsd !== 0),
    profitSnapshots: snapshotRows
      .map(r => ({
        invoiceId: String(r.invoice_id ?? ''),
        grossProfit: Number(r.gross_profit) || 0,
        recordedAt: String(r.recorded_at ?? ''),
        reversedAt: r.reversed_at ? String(r.reversed_at) : null,
        revenue: r.revenue == null ? undefined : Number(r.revenue),
      }))
      // D-12: only the original sale row is a snapshot; partial-refund rows have negative revenue.
      .filter(r => r.invoiceId && !(typeof r.revenue === 'number' && r.revenue < 0))
      .map(({ revenue: _rev, ...r }) => r),
    fetchedAt: Date.now(),
  };

  saveLedger(userId, ledger);
  return ledger;
}

/**
 * Cached ledger when fresh, otherwise a server fetch that falls back to the
 * cache. In local-only and guest modes there is no server ledger: collected
 * amounts then count as paid on the sale day, which is the documented fallback.
 */
export async function loadProfitLedgerCloud(): Promise<ProfitLedger> {
  const userId = getCurrentUserId();
  const local = loadProfitLedgerLocally();
  if (!userId || isLocalDataMode()) return local;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return local;
  if (local.fetchedAt > 0 && Date.now() - local.fetchedAt < CACHE_TTL_MS) return local;

  if (!inflight) {
    inflight = fetchLedger(userId)
      .catch(err => {
        console.warn('[ProfitLedger] fetch failed, serving cache:', err);
        return local;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * Adds the original sale profit and the refund day to each invoice (audit F5, 2026-11-24).
 * The engine uses them to keep a sale in an earlier period when it was refunded later.
 */
export function withProfitSnapshots<T extends { id: string; invoiceNumber?: string }>(
  invoices: T[],
  ledger: ProfitLedger | undefined,
): Array<T & { originalProfit: number | null; refundedAt: string | null }> {
  const latest = new Map<string, { grossProfit: number; recordedAt: string; reversedAt: string | null }>();
  for (const snap of ledger?.profitSnapshots ?? []) {
    const current = latest.get(snap.invoiceId);
    // Earliest row = the original sale snapshot (older caches may still hold refund rows, which came later).
    if (!current || snap.recordedAt < current.recordedAt) latest.set(snap.invoiceId, snap);
  }
  return invoices.map(inv => {
    const snap = latest.get(inv.id) ?? (inv.invoiceNumber ? latest.get(inv.invoiceNumber) : undefined);
    return { ...inv, originalProfit: snap ? snap.grossProfit : null, refundedAt: snap?.reversedAt ?? null };
  });
}
