/**
 * Cashbox Cloud Store - FlowPOS Pro
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
}): Promise<string | null> => {
  const userId = await ensureUserId();
  if (!userId) return null;

  const ownerId = (await getOwnerIdForInsert()) || userId;

  const payload: Record<string, unknown> = {
    id: params.shiftId || crypto.randomUUID(),
    user_id: ownerId,
    cashier_id: params.cashierId || userId,
    cashier_name: params.cashierName || null,
    opened_at: new Date().toISOString(),
    opening_balance: roundCurrency(params.openingBalance),
    expected_balance: roundCurrency(params.openingBalance),
    reconciliation_status: 'open' as const,
  };

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
}): Promise<boolean> => {
  const userId = await ensureUserId();
  if (!userId) return false;

  // المحاولة الأولى: الإقفال الذري والتسوية التلقائية عبر الخادم
  try {
    const { data, error } = await sb.rpc('close_cash_shift_atomic', {
      _shift_id: params.shiftId,
      _actual_balance: roundCurrency(params.actualBalance),
      _variance_reason: params.varianceReason || null,
    });
    if (!error && (data as { success?: boolean })?.success) {
      return true;
    }
    if (error) {
      console.warn('[cashbox-cloud] close_cash_shift_atomic RPC error, falling back:', error.message);
    }
  } catch (rpcErr) {
    console.warn('[cashbox-cloud] close_cash_shift_atomic failed, falling back:', rpcErr);
  }

  // الاحتياط المحلي وغير المتصل: التحديث المباشر للجدول والإضافة للطابور
  const variance = roundCurrency(params.actualBalance - params.expectedBalance);
  const status: CloudShift['reconciliation_status'] =
    Math.abs(variance) < 0.01 ? 'matched' : (params.varianceReason ? 'matched' : 'unmatched');

  const payload = {
    closed_at: new Date().toISOString(),
    expected_balance: roundCurrency(params.expectedBalance),
    actual_balance: roundCurrency(params.actualBalance),
    variance,
    variance_reason: params.varianceReason || null,
    reconciliation_status: status,
  };

  try {
    const { error } = await sb
      .from('cash_shifts')
      .update(payload)
      .eq('id', params.shiftId);
    if (error) throw error;
    return true;
  } catch (e) {
    console.warn('[cashbox-cloud] close shift failed, queued:', e);
    try { addToQueue('shift_close', { shiftId: params.shiftId, ...payload, userId }); } catch { /* noop */ }
    return false;
  }
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
    const { error } = await sb.from('shift_transactions').insert(payload);
    if (error) throw error;
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
