/**
 * Cashbox Cloud Store - PosFlow
 * ==================================
 * مزامنة الورديات وحركات الصندوق إلى Supabase.
 * يعمل بشكل تكاملي مع cashbox-store المحلي (cache).
 */
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';
const sb = supabase;
import { getCurrentUserId, setCurrentUserId, getOwnerIdForInsert } from '../supabase-store';
import { addToQueue } from '../sync-queue';
import { roundCurrency } from '../utils';
import { round8 } from '../money-engine';

export type ShiftTxType =
  | 'sale'
  | 'digital_sale'
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

/**
 * Opens a shift through the server (open_cash_shift_atomic, migration 20261126200000), online and from the offline queue.
 * The shift id is the client id: a replay returns the stored shift and changes nothing. A second open shift for the same
 * cashier is refused by the unique index with code 23505 (isShiftAlreadyOpenError), exactly as before.
 */
export const openShiftFromPayload = async (payload: Record<string, unknown>): Promise<void> => {
  const { error } = await sb.rpc('open_cash_shift_atomic' as never, {
    _id: payload.id,
    _cashier_id: payload.cashier_id ?? null,
    _cashier_name: payload.cashier_name ?? null,
    _opening_balance: payload.opening_balance ?? 0,
    _opening_by_currency: payload.opening_by_currency ?? null,
    _opened_at: payload.opened_at ?? null,
  } as never);
  if (error) throw error;
};

export const openShiftCloud = async (params: {
  shiftId?: string;
  cashierId?: string | null;
  cashierName?: string | null;
  openingBalance: number;
  /** مبالغ الافتتاح بكل عملة (بعملتها) — يعتمد عليها الخادم لحساب المتوقع لكل عملة */
  openingByCurrency?: Record<string, number>;
}): Promise<string | null | 'conflict'> => {
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
    await openShiftFromPayload(payload);
    return payload.id as string;
  } catch (e) {
    // الخادم يسمح بوردية مفتوحة واحدة لكل كاشير: وردية أخرى مفتوحة مسبقاً (من جهاز آخر) ← لا نُدرجها في الطابور
    if ((e as { code?: string } | null)?.code === '23505') {
      console.warn('[cashbox-cloud] a shift is already open for this cashier on the server');
      return 'conflict';
    }
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
 * Idempotent write of one shift transaction through the server (record_shift_movement_atomic, migration 20261126190000).
 * `row.id` is generated once by the caller and reused on every retry, so a lost response never duplicates cash.
 * The server keeps the old rules: same id = same movement; a repeated (shift, type, reference) is the same sale, or is kept
 * under reference#<id> for other types. A closed shift is refused with (F-20): the queue parks it for manual reconciliation.
 */
export const writeShiftTransactionRow = async (row: Record<string, unknown>): Promise<void> => {
  const id = typeof row.id === 'string' && row.id ? row.id : crypto.randomUUID();
  const { error } = await sb.rpc('record_shift_movement_atomic' as never, {
    _id: id,
    _shift_id: row.shift_id,
    _type: row.type,
    _amount: row.amount,
    _reference_id: row.reference_id ?? null,
    _notes: row.notes ?? null,
    _currency: row.currency ?? null,
    _currency_amount: row.currency_amount ?? null,
    _exchange_rate: row.exchange_rate ?? null,
  } as never);
  if (error) throw error;
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
    amount: round8(params.amount), // F-02: drawer movements keep 8 decimals
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
    // Shift lists never include the permanent general drawer (D-35); it has its own card.
    return ((data || []) as CloudShift[]).filter(s => !isGeneralDrawerRow(s));
  } catch {
    return [];
  }
};


/** الرصيد المتوقع لوردية من حركاتها في السحابة (F-18)؛ null عند الفشل فيُستعمل رصيد الخادم المخزّن. */
export const loadShiftExpectedFromMovements = async (shiftId: string, opening: number | string): Promise<number | null> => {
  try {
    const { data, error } = await sb
      .from('shift_transactions')
      .select('type, amount')
      .eq('shift_id', shiftId);
    if (error) throw error;
    const { expectedFromMovements } = await import('../shift-adopt');
    return expectedFromMovements(opening, (data || []) as { type: string; amount: number | string }[]);
  } catch {
    return null;
  }
};

export interface ShiftMovementRow {
  id: string; type: string; amount: number; notes: string | null; reference_id: string | null;
  currency: string | null; currency_amount: number | null; created_at: string;
}

/** Every drawer movement of one shift (newest first), for the shift details view. Empty on error/offline. */
export const loadShiftMovements = async (shiftId: string): Promise<ShiftMovementRow[]> => {
  try {
    const { data, error } = await sb
      .from('shift_transactions')
      .select('id, type, amount, notes, reference_id, currency, currency_amount, created_at')
      .eq('shift_id', shiftId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    return ((data || []) as Array<Record<string, unknown>>).map(r => ({
      id: String(r.id), type: String(r.type), amount: Number(r.amount) || 0,
      notes: (r.notes as string | null) ?? null, reference_id: (r.reference_id as string | null) ?? null,
      currency: (r.currency as string | null) ?? null,
      currency_amount: r.currency_amount == null ? null : Number(r.currency_amount),
      created_at: String(r.created_at),
    }));
  } catch {
    return [];
  }
};

/** Invoices a cashier issued during a shift window, grouped by payment type (cash / credit / digital…), for the shift details. */
export const loadShiftInvoiceSummary = async (cashierId: string, fromIso: string, toIso: string | null): Promise<Array<{ paymentType: string; count: number; total: number }>> => {
  try {
    let q = sb.from('invoices').select('payment_type, total, status').eq('cashier_id', cashierId).gte('created_at', fromIso);
    if (toIso) q = q.lte('created_at', toIso);
    const { data, error } = await q.limit(2000);
    if (error) throw error;
    const map = new Map<string, { count: number; total: number }>();
    ((data || []) as Array<{ payment_type: string | null; total: number | string | null; status: string | null }>)
      .filter(r => r.status !== 'cancelled')
      .forEach(r => {
        const k = r.payment_type || 'cash';
        const g = map.get(k) || { count: 0, total: 0 };
        g.count += 1; g.total = round8(g.total + (Number(r.total) || 0));
        map.set(k, g);
      });
    return Array.from(map.entries()).map(([paymentType, g]) => ({ paymentType, ...g }));
  } catch {
    return [];
  }
};

/** حد سماح فروقات الصندوق بالدولار (من إعدادات المتجر) */
export const loadShiftVarianceTolerance = async (): Promise<number> => {
  try {
    const userId = await ensureUserId();
    const ownerId = userId ? ((await getOwnerIdForInsert()) || userId) : null;
    if (!ownerId) return 1;
    const { data } = await sb.from('store_settings').select('shift_variance_tolerance_usd').eq('user_id', ownerId).limit(1).maybeSingle();
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

/** True for the store's permanent general drawer (cash_shifts.is_general, D-35). */
export const isGeneralDrawerRow = (row: unknown): boolean => Boolean((row as { is_general?: boolean } | null)?.is_general);

/**
 * Returns the id of the store's general drawer, creating it on first use (D-35), and caches it for offline use.
 * The starting balance applies only when it is created (owner only). Null when offline or on error.
 */
export const ensureGeneralDrawerCloud = async (openingBalance = 0): Promise<string | null> => {
  try {
    const { data, error } = await sb.rpc('ensure_general_drawer_atomic' as never, { _opening_balance: round8(openingBalance) } as never);
    if (error) throw error;
    const id = (data as { id?: string } | null)?.id;
    if (!id) return null;
    const { setCachedGeneralDrawerId } = await import('../cashbox-store');
    setCachedGeneralDrawerId((await getOwnerIdForInsert()) || null, id);
    return id;
  } catch (e) {
    console.warn('[cashbox-cloud] general drawer unavailable:', e);
    return null;
  }
};

/** Owner-only count of the general drawer per currency (units of that currency, rate = units per 1 USD); differences are posted
 * as surplus/shortage in that currency and the drawer stays open. */
export const countGeneralDrawerCloud = async (
  counts: Array<{ code: string; counted: number; rate: number }>, note: string | null, operationId: string,
): Promise<Array<{ code: string; expected: number; counted: number; difference: number; difference_usd: number }>> => {
  const { data, error } = await sb.rpc('count_general_drawer_atomic' as never, {
    _counts: counts.map(c => ({ code: c.code, counted: c.counted, rate: c.rate })), _note: note, _operation_id: operationId,
  } as never);
  if (error) throw error;
  const rows = ((data || {}) as { currencies?: Array<Record<string, unknown>> }).currencies || [];
  return rows.map(r => ({
    code: String(r.code), expected: Number(r.expected) || 0, counted: Number(r.counted) || 0,
    difference: Number(r.difference) || 0, difference_usd: Number(r.difference_usd) || 0,
  }));
};

/** Every open shift of the store (owner view: manage cashiers' drawers remotely). */
export const loadStoreOpenShifts = async (): Promise<CloudShift[]> => {
  try {
    const { data, error } = await sb.from('cash_shifts').select('*').is('closed_at', null).order('opened_at', { ascending: false }).limit(50);
    if (error) throw error;
    // The general store drawer (D-35) is always open and is not a cashier's shift.
    return ((data || []) as CloudShift[]).filter(s => !isGeneralDrawerRow(s));
  } catch {
    return [];
  }
};

/** The store's cashiers (owner view), with their display names. */
export const loadStoreCashiers = async (ownerId: string): Promise<Array<{ id: string; name: string }>> => {
  try {
    const { data: roles, error } = await sb.from('user_roles').select('user_id, is_active').eq('owner_id', ownerId).eq('role', 'cashier');
    if (error) throw error;
    const ids = (roles || []).filter(r => r.is_active !== false).map(r => r.user_id as string);
    if (!ids.length) return [];
    const { data: profiles } = await sb.from('profiles').select('user_id, full_name').in('user_id', ids);
    const names = new Map((profiles || []).map(p => [p.user_id as string, (p.full_name as string | null) || '']));
    return ids.map(id => ({ id, name: names.get(id) || id.slice(0, 8) }));
  } catch {
    return [];
  }
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

/** تحويل عملة داخل الوردية المفتوحة: خارج بعملة وداخل بأخرى (يحسبه الإغلاق لكل عملة) */
export async function recordShiftFxCloud(p: {
  shiftId: string; fromCode: string; fromAmount: number; fromUsd: number; toCode: string; toAmount: number; toUsd: number;
  /** One id per user action, reused on retry (F-20). */
  operationId?: string;
}): Promise<void> {
  const { error } = await sb.rpc('record_shift_fx_atomic', {
    _shift_id: p.shiftId, _from_ccy: p.fromCode, _from_amount: p.fromAmount, _from_usd: p.fromUsd,
    _to_ccy: p.toCode, _to_amount: p.toAmount, _to_usd: p.toUsd, _operation_id: p.operationId || crypto.randomUUID(),
  });
  if (error) throw error;
}


/**
 * Startup reconciliation of the drawer (local = cloud), run once per online session for every page, not only the shifts page.
 * Without it a device that never opened the shifts page sold cash with no local active shift while the cloud had one open, so the
 * sales never reached the drawer (found by the accounting audit of 2026-11-26: 5 cash invoices, $25, missing from an open shift).
 * Adopts the cashier's cloud-open shift when the device has none, and closes the local shift when the cloud has closed it.
 */
export const reconcileDrawerWithCloud = async (userId: string | null | undefined): Promise<'adopted' | 'closed' | 'none'> => {
  if (!userId) return 'none';
  // Local shifts are stored per user; at session start the store may not know the user yet, and a shift saved under the
  // legacy key is dropped when the user is set. Bind the user first so the adopted shift is kept.
  if (getCurrentUserId() !== userId) setCurrentUserId(userId);
  const { getActiveShift, adoptCloudOpenShift, closeLocalShiftFromCloud } = await import('../cashbox-store');
  const local = getActiveShift();
  if (local) {
    // Look the local shift up by id: a recent-shifts list can miss it when more than N shifts were opened since.
    const { data: copy } = await sb.from('cash_shifts').select('*').eq('id', local.id).maybeSingle();
    if ((copy as CloudShift | null)?.closed_at) { closeLocalShiftFromCloud(copy as CloudShift); return 'closed'; }
    return 'none';
  }
  // Query open shifts directly instead of filtering the last 20 shifts.
  // The cashier filter runs in the query, so other cashiers' open shifts can never push this one out of the result.
  const { data: openRows } = await sb.from('cash_shifts').select('*').is('closed_at', null)
    .or(`cashier_id.is.null,cashier_id.eq.${userId}`).order('opened_at', { ascending: false }).limit(5);
  // Never adopt the general store drawer (D-35) as this device's shift.
  const open = ((openRows || []) as CloudShift[]).filter(s => !isGeneralDrawerRow(s))[0];
  if (!open) return 'none';
  const fromMovements = await loadShiftExpectedFromMovements(open.id, open.opening_balance);
  const adopted = adoptCloudOpenShift(fromMovements === null ? open : { ...open, expected_balance: fromMovements }, userId);
  return adopted ? 'adopted' : 'none';
};
