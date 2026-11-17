/**
 * Owner-only accounting actions and their records:
 *   - closing an accounting period (close_accounting_period_atomic), and
 *   - the debt write-off log (debt_writeoffs).
 *
 * Closing a period is a server decision: it is never queued offline, because
 * the figures it freezes must be computed by the database at that moment.
 */
import { supabase } from '@/integrations/supabase/client';
import { isLocalDataMode } from '@/hooks/use-network-status';
import { getCurrentUserId } from '../supabase-store';
import { isCloudWriteBlocked } from '../subscription-lock';

import type { SupabaseClient } from '@supabase/supabase-js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseSupabase = SupabaseClient<any, 'public', any>;
const sb = supabase as unknown as LooseSupabase;

export interface PeriodClosure {
  id: string;
  periodStart: string;
  periodEnd: string;
  revenue: number;
  cogs: number;
  grossProfit: number;
  /** null on closures recorded before the unified profit definition. */
  realizedProfit: number | null;
  pendingProfit: number | null;
  badDebtLoss: number | null;
  expenses: number;
  netProfit: number;
  timezone: string | null;
  closedAt: string;
}

export interface DebtWriteoffRecord {
  id: string;
  debtId: string;
  customerName: string;
  /** Invoice number, or null for a cash loan with no invoice. */
  invoiceId: string | null;
  amount: number;
  /** null when the row predates the loss columns. */
  lossAmount: number | null;
  pendingProfitCancelled: number | null;
  /** The owner's share of the loss. */
  ownerLoss: number | null;
  partners: { partnerName: string; amount: number; category: string }[];
  reason: string;
  writtenOffAt: string;
}

// One flat shape on purpose: the project compiles without strictNullChecks,
// where a boolean-discriminated union does not narrow.
export interface ClosePeriodResult {
  ok: boolean;
  /** Set when ok is false. */
  message: string;
  closure?: Record<string, unknown>;
  needsMigration?: boolean;
}

const CLOSURES_CACHE_KEY = 'posflow_period_closures_v1';
const WRITEOFFS_CACHE_KEY = 'posflow_debt_writeoffs_v1';

const numOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function readCache<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { userId: string; rows: T[] };
    return parsed && parsed.userId === getCurrentUserId() && Array.isArray(parsed.rows) ? parsed.rows : [];
  } catch {
    return [];
  }
}

function writeCache<T>(key: string, rows: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify({ userId: getCurrentUserId(), rows }));
  } catch { /* cache is best-effort */ }
}

/** The device time zone, so a closed day is the same day the owner sees in the app. */
export function getDeviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function loadPeriodClosuresLocally(): PeriodClosure[] {
  return readCache<PeriodClosure>(CLOSURES_CACHE_KEY);
}

export async function loadPeriodClosuresCloud(): Promise<PeriodClosure[]> {
  if (!getCurrentUserId() || isLocalDataMode()) return loadPeriodClosuresLocally();
  try {
    const { data, error } = await sb
      .from('accounting_period_closures')
      .select('*')
      .order('period_start', { ascending: false })
      .limit(500);
    if (error) throw error;
    const rows = ((data ?? []) as Record<string, unknown>[]).map(r => ({
      id: String(r.id),
      periodStart: String(r.period_start ?? ''),
      periodEnd: String(r.period_end ?? ''),
      revenue: Number(r.total_revenue) || 0,
      cogs: Number(r.total_cogs) || 0,
      grossProfit: Number(r.gross_profit) || 0,
      realizedProfit: numOrNull(r.realized_profit),
      pendingProfit: numOrNull(r.pending_profit),
      badDebtLoss: numOrNull(r.bad_debt_loss),
      expenses: Number(r.total_expenses) || 0,
      netProfit: Number(r.net_profit) || 0,
      timezone: r.closing_timezone ? String(r.closing_timezone) : null,
      closedAt: String(r.created_at ?? ''),
    }));
    writeCache(CLOSURES_CACHE_KEY, rows);
    return rows;
  } catch (err) {
    console.warn('[AccountingAdmin] closures fetch failed, serving cache:', err);
    return loadPeriodClosuresLocally();
  }
}

/**
 * Closes the period on the server. `from` and `to` are local days (YYYY-MM-DD).
 * Never queued: with no connection it fails with a clear message.
 */
export async function closeAccountingPeriodCloud(from: string, to: string): Promise<ClosePeriodResult> {
  if (!getCurrentUserId() || isLocalDataMode()) {
    return { ok: false, message: 'إقفال الفترة غير متاح في الوضع التجريبي أو المحلي' };
  }
  if (isCloudWriteBlocked()) {
    return { ok: false, message: 'إقفال الفترة يحتاج اشتراكاً فعّالاً' };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, message: 'إقفال الفترة يحتاج اتصالاً بالإنترنت' };
  }
  try {
    const { data, error } = await sb.rpc('close_accounting_period_atomic', {
      _period_start: from,
      _period_end: to,
      _timezone: getDeviceTimeZone(),
    });
    if (error) {
      const code = (error as { code?: string }).code;
      const message = error.message || '';
      if (code === 'PGRST202' || /could not find the function/i.test(message)) {
        return {
          ok: false,
          needsMigration: true,
          message: 'إقفال الفترة يحتاج تحديث قاعدة البيانات (ملف المرحلة 2) قبل استخدامه',
        };
      }
      return { ok: false, message: message || 'تعذّر إقفال الفترة' };
    }
    return { ok: true, message: '', closure: (data ?? {}) as Record<string, unknown> };
  } catch (err) {
    return { ok: false, message: err instanceof Error && err.message ? err.message : 'تعذّر الاتصال بالخادم' };
  }
}

export interface WriteOffDebtResult {
  ok: boolean;
  /** Set when ok is false. */
  message: string;
  result?: Record<string, unknown>;
}

/**
 * Writes a debt off as a bad debt on the server. Online only and never queued:
 * the loss and each partner's share are computed by the database at that moment,
 * and the action cannot be undone.
 */
export async function writeOffDebtNowCloud(debtId: string, reason: string): Promise<WriteOffDebtResult> {
  if (!getCurrentUserId() || isLocalDataMode()) {
    return { ok: false, message: 'شطب الدين يحتاج اتصالاً بالإنترنت وحساباً مفعّلاً' };
  }
  if (isCloudWriteBlocked()) {
    return { ok: false, message: 'شطب الدين يحتاج اشتراكاً فعّالاً' };
  }
  try {
    // Before the phase 2 database update the server would write the debt off
    // without computing the loss or the partners' shares: refuse instead.
    const probe = await sb.from('debt_writeoffs').select('loss_amount').limit(1);
    if (probe.error) {
      const missingColumn = (probe.error as { code?: string }).code === '42703'
        || /loss_amount/i.test(probe.error.message || '');
      return {
        ok: false,
        message: missingColumn
          ? 'شطب الدين يحتاج تحديث قاعدة البيانات (ملف المرحلة 2) قبل استخدامه'
          : (probe.error.message || 'تعذّر الاتصال بالخادم'),
      };
    }
    const { data, error } = await sb.rpc('writeoff_debt_atomic', {
      _debt_id: debtId,
      _reason: reason,
      _operation_id: `writeoff_${debtId}_${Date.now()}`,
    });
    if (error) return { ok: false, message: error.message || 'تعذّر شطب الدين' };
    return { ok: true, message: '', result: (data ?? {}) as Record<string, unknown> };
  } catch (err) {
    return { ok: false, message: err instanceof Error && err.message ? err.message : 'تعذّر الاتصال بالخادم' };
  }
}

export function loadDebtWriteoffsLocally(): DebtWriteoffRecord[] {
  return readCache<DebtWriteoffRecord>(WRITEOFFS_CACHE_KEY);
}

export async function loadDebtWriteoffsCloud(): Promise<DebtWriteoffRecord[]> {
  if (!getCurrentUserId() || isLocalDataMode()) return loadDebtWriteoffsLocally();
  try {
    const { data, error } = await sb
      .from('debt_writeoffs')
      .select('*')
      .order('written_off_at', { ascending: false })
      .limit(1000);
    if (error) throw error;
    const rows = ((data ?? []) as Record<string, unknown>[]).map(r => {
      const impact = Array.isArray(r.partner_impact) ? (r.partner_impact as Record<string, unknown>[]) : [];
      return {
        id: String(r.id),
        debtId: String(r.debt_id ?? ''),
        customerName: String(r.customer_name ?? ''),
        invoiceId: r.notes ? String(r.notes) : null,
        amount: Number(r.amount) || 0,
        lossAmount: numOrNull(r.loss_amount),
        pendingProfitCancelled: numOrNull(r.pending_profit_cancelled),
        // capital_impact is only meaningful on rows written with the loss columns
        ownerLoss: numOrNull(r.loss_amount) === null ? null : numOrNull(r.capital_impact),
        partners: impact.map(p => ({
          partnerName: String(p.partnerName ?? ''),
          amount: Number(p.amount) || 0,
          category: String(p.category ?? ''),
        })),
        reason: String(r.reason ?? ''),
        writtenOffAt: String(r.written_off_at ?? r.created_at ?? ''),
      };
    });
    writeCache(WRITEOFFS_CACHE_KEY, rows);
    return rows;
  } catch (err) {
    console.warn('[AccountingAdmin] write-offs fetch failed, serving cache:', err);
    return loadDebtWriteoffsLocally();
  }
}
