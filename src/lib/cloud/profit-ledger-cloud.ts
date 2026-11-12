/**
 * Profit ledger: the dated debt payments and debt write-offs the profit engine
 * needs to place credit-sale profit on the day it was actually collected.
 *
 * Read-only. Cached locally so the dashboard and reports keep working offline;
 * a failed fetch never replaces a good cache with an empty one.
 */
import { supabase } from '@/integrations/supabase/client';
import { isLocalDataMode } from '@/hooks/use-network-status';
import { getCurrentUserId } from '../supabase-store';
import type { ProfitPaymentInput, ProfitWriteoffInput } from '../profit-engine';

import type { SupabaseClient } from '@supabase/supabase-js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseSupabase = SupabaseClient<any, 'public', any>;
const sb = supabase as unknown as LooseSupabase;

export interface ProfitLedger {
  payments: ProfitPaymentInput[];
  writeoffs: ProfitWriteoffInput[];
  /** When the ledger was last fetched from the server; 0 if never. */
  fetchedAt: number;
}

const CACHE_KEY = 'hyperpos_profit_ledger_v1';
const CACHE_TTL_MS = 20000;
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

const EMPTY_LEDGER: ProfitLedger = { payments: [], writeoffs: [], fetchedAt: 0 };

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
    return { payments: parsed.payments, writeoffs: parsed.writeoffs, fetchedAt: Number(parsed.fetchedAt) || 0 };
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
    const { data, error } = await sb.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchLedger(userId: string): Promise<ProfitLedger> {
  const [debts, payments, writeoffs] = await Promise.all([
    fetchAllRows('debts', 'id, invoice_id, is_cash_debt'),
    fetchAllRows('debt_payments', 'debt_id, amount, created_at'),
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
        amount: Number(p.amount) || 0,
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
