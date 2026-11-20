/**
 * Cashbox Cloud Store - PosFlow
 * ==================================
 * مزامنة الورديات وحركات الصندوق إلى Supabase.
 * يعمل بشكل تكاملي مع cashbox-store المحلي (cache).
 */
import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseSupabase = SupabaseClient<any, 'public', any>;
const sb = supabase as unknown as LooseSupabase;
import { getCurrentUserId, setCurrentUserId, getOwnerIdForInsert } from '../supabase-store';
import { addToQueue } from '../sync-queue';
import { roundCurrency } from '../utils';

export type ShiftTxType =
  | 'sale'
  | 'deposit_capital'
  | 'deposit_revenue'
  | 'deposit_purchase_cover'
  | 'debt_payment'
  | 'expense'
  | 'refund'
  | 'writeoff'
  | 'withdrawal';

const ensureUserId = async (): Promise<string | null> => {
  let userId = getCurrentUserId();
  if (!userId) {
    const { data: { user } } = await supabase.auth.getUser();
    userId = user?.id || null;
    if (userId) setCurrentUserId(userId);
  }
  return userId;
};

export interface CloudShift {
  id: string;
  user_id: string;
  cashier_id: string | null;
  cashier_name: string | null;
  opened_at: string;
  closed_at: string | null;
  opening_balance: number;
  expected_balance: number;
  actual_balance: number | null;
  variance: number | null;
  variance_reason: string | null;
  reconciliation_status: 'open' | 'matched' | 'unmatched' | 'pending';
  notes: string | null;
}

export const openShiftCloud = async (params: {
  shiftId?: string;
  cashierId?: string | null;
  cashierName?: string | null;
  openingBalance: number;
  /** مبالغ الافتتاح بكل عملة (بعملتها) — يعتمد عليها الخادم لحساب المتوقع لكل عملة */
  openingByCurrency?: Record<string, number>;
}): Promise<string | null> => {
  const userId = await ensureUserId();
  if (!userId) return null;

  const ownerId = (await getOwnerIdForInsert()) || userId;

  const openingBalance = Number.isFinite(params.openingBalance) && params.openingBalance > 0
    ? roundCurrency(params.openingBalance)
    : 0;

  const payload: Record<string, unknown> = {
    id: params.shiftId || crypto.randomUUID(),
    user_id: ownerId,
    cashier_id: params.cashierId || userId,
    cashier_name: params.cashierName || null,
    opened_at: new Date().toISOString(),
    opening_balance: openingBalance,
    expected_balance: openingBalance,
    reconciliation_status: 'open' as const,
  };
  if (params.openingByCurrency && Object.keys(params.openingByCurrency).length > 0) {
    payload.opening_by_currency = params.openingByCurrency;
  }

  try {
    const { data, error } = await sb
      .from('cash_shifts')
      .upsert(payload, { onConflict: 'id' })
      .select('id')
      .single();
    if (error) throw error;
    return data?.id || (payload.id as string);
  } catch (e) {
    console.warn('[cashbox-cloud] open shift failed, queued:', e);
    try { addToQueue('cash_shift_upsert', payload); } catch { /* noop */ }
    return (payload.id as string);
  }
};

export const closeShiftCloud = async (params: {
  shiftId: string;
  expectedBalance: number;
  actualBalance: number;
  varianceReason?: string;
  /** المعدود لكل عملة (بعملتها) مع سعر الصرف (وحدات العملة لكل 1$) */
  counts?: { code: string; counted: number; rate: number }[];
  /** عند تجاوز حد السماح: accept = يُسجَّل فائضاً/عجزاً ، defer = يؤجَّل لقرار المالك */
  decision?: 'accept' | 'defer';
}): Promise<boolean> => {
  const userId = await ensureUserId();
  if (!userId) return false;

  const actualBalance = roundCurrency(params.actualBalance);
  const varianceReason = params.varianceReason || null;

  // The server computes the expected balance and the variance from the shift transactions.
  // There is no direct table write: on failure the same atomic call is queued for retry.
  try {
    const { data, error } = await sb.rpc('close_cash_shift_atomic', {
      _shift_id: params.shiftId,
      _actual_balance: actualBalance,
      _variance_reason: varianceReason,
      _decision: params.decision || 'accept',
      _counts: params.counts && params.counts.length > 0 ? params.counts : null,
    });
    if (error) throw error;
    if ((data as { success?: boolean } | null)?.success) return true;
    throw new Error('close_cash_shift_atomic returned no success flag');
  } catch (e) {
    console.warn('[cashbox-cloud] atomic shift close failed, queued for retry:', e);
    try {
      addToQueue('shift_close', { shiftId: params.shiftId, actualBalance, varianceReason, decision: params.decision || 'accept', counts: params.counts || null }, 10);
    } catch { /* noop */ }
    return false;
  }
};

/**
 * Idempotent write of one shift transaction.
 * `row.id` is generated once by the caller and reused on every retry, so a lost response never duplicates cash.
 * The table also has a unique index on (shift_id, type, reference_id).
 */
export const writeShiftTransactionRow = async (row: Record<string, unknown>): Promise<void> => {
  const attempt = (payload: Record<string, unknown>) =>
    sb.from('shift_transactions').upsert(payload, { onConflict: 'id', ignoreDuplicates: true });

  const { error } = await attempt(row);
  if (!error) return;
  if (error.code !== '23505') throw error;

  // Another row already holds this (shift, type, reference).
  const type = String(row.type || '');
  // A sale is referenced by its unique operation id and a debt payment by its unique payment id
  // (the server may already have written it): this is the same movement, nothing to add.
  if (type === 'sale' || type === 'debt_payment') return;

  // Other types may legitimately repeat a reference in one shift (two withdrawals by one partner,
  // two partial refunds of one invoice): keep the movement under a distinct reference.
  const suffix = String(row.id || '').slice(0, 8) || Date.now().toString(36);
  const { error: retryError } = await attempt({ ...row, reference_id: `${String(row.reference_id ?? '')}#${suffix}` });
  if (retryError && retryError.code !== '23505') throw retryError;
};

export const addShiftTransactionCloud = async (params: {
  shiftId: string;
  type: ShiftTxType;
  amount: number;
  referenceId?: string;
  notes?: string;
  currency?: string;
  currencyAmount?: number;
  exchangeRate?: number;
}): Promise<boolean> => {
  const userId = await ensureUserId();
  if (!userId) return false;

  const ownerId = (await getOwnerIdForInsert()) || userId;

  const payload: Record<string, unknown> = {
    id: crypto.randomUUID(),
    shift_id: params.shiftId,
    user_id: ownerId,
    type: params.type,
    amount: roundCurrency(params.amount),
    reference_id: params.referenceId || null,
    notes: params.notes || null,
  };
  if (params.currency) payload.currency = params.currency;
  if (params.currencyAmount !== undefined) payload.currency_amount = params.currencyAmount;
  if (params.exchangeRate !== undefined) payload.exchange_rate = params.exchangeRate;

  try {
    await writeShiftTransactionRow(payload);
    return true;
  } catch (e) {
    console.warn('[cashbox-cloud] tx insert failed, queued:', e);
    try { addToQueue('shift_transaction', payload); } catch { /* noop */ }
    return false;
  }
};

/**
 * مزامنة حركة نقدية للوردية النشطة مباشرة إلى السحابة
 */
export const syncActiveShiftTransactionCloud = async (
  type: ShiftTxType,
  amountUSD: number,
  currency: string = 'USD',
  currencyAmount?: number,
  referenceId?: string,
  notes?: string,
  exchangeRate?: number
): Promise<boolean> => {
  try {
    const { getActiveShift } = await import('../cashbox-store');
    const activeShift = getActiveShift();
    if (!activeShift?.id) return false;
    return await addShiftTransactionCloud({
      shiftId: activeShift.id,
      type,
      amount: amountUSD,
      currency,
      currencyAmount,
      exchangeRate,
      referenceId,
      notes,
    });
  } catch (err) {
    console.warn('[syncActiveShiftTransactionCloud] Error:', err);
    return false;
  }
};

export const loadCloudShifts = async (limit = 50): Promise<CloudShift[]> => {
  try {
    const { data, error } = await sb
      .from('cash_shifts')
      .select('*')
      .order('opened_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || []) as CloudShift[];
  } catch {
    return [];
  }
};


/** حد سماح فروقات الصندوق بالدولار (من إعدادات المتجر) */
export const loadShiftVarianceTolerance = async (): Promise<number> => {
  try {
    const { data } = await sb.from('store_settings').select('shift_variance_tolerance_usd').limit(1).maybeSingle();
    const v = Number((data as { shift_variance_tolerance_usd?: number } | null)?.shift_variance_tolerance_usd);
    return Number.isFinite(v) && v >= 0 ? v : 1;
  } catch {
    return 1;
  }
};

export const saveShiftVarianceTolerance = async (valueUsd: number): Promise<boolean> => {
  const userId = await ensureUserId();
  if (!userId) return false;
  const ownerId = (await getOwnerIdForInsert()) || userId;
  const v = Math.max(0, roundCurrency(valueUsd));
  const { error } = await sb.from('store_settings').update({ shift_variance_tolerance_usd: v }).eq('user_id', ownerId);
  return !error;
};

export interface DeferredShiftVariance {
  id: string;
  closed_at: string | null;
  cashier_name: string | null;
  variance: number | null;
  currency_counts: { code: string; expected: number; counted: number; variance: number; variance_usd: number }[] | null;
}

export const loadDeferredShiftVariances = async (): Promise<DeferredShiftVariance[]> => {
  try {
    const { data, error } = await sb.from('cash_shifts')
      .select('id, closed_at, cashier_name, variance, currency_counts')
      .eq('variance_decision', 'deferred').order('closed_at', { ascending: false }).limit(50);
    if (error) throw error;
    return (data || []) as DeferredShiftVariance[];
  } catch {
    return [];
  }
};

export const resolveShiftVarianceCloud = async (shiftId: string, decision: 'accept' | 'dismiss', note?: string): Promise<{ ok: boolean; error?: string }> => {
  const { error } = await sb.rpc('resolve_shift_variance_atomic', { _shift_id: shiftId, _decision: decision, _note: note || null });
  return error ? { ok: false, error: error.message } : { ok: true };
};
