/**
 * Profits Cloud Store - PosFlow
 * ==================================
 * مزامنة سجلات الأرباح إلى Supabase مع fallback لـ sync-queue عند انقطاع الاتصال.
 * يعمل بشكل تكاملي مع profits-store المحلي (cache).
 */
import { supabase } from '@/integrations/supabase/client';
const sb = supabase;
import { getOwnerIdForInsert } from '../supabase-store';
import { addToQueue } from '../sync-queue';
import { roundCurrency } from '../utils';

export interface CloudProfitInput {
  invoiceId: string;
  grossProfit: number;
  cogs: number;
  revenue: number;
  currency?: string;
}

/**
 * Sale-time profit snapshot (D-12) written ON THE SERVER from the invoice itself (F-25): full profit, 8 decimals, once per invoice.
 * The client values in `input` are no longer sent (they were rounded to 2 decimals and, for a credit sale, only the down-payment share).
 * Offline or on a transport failure the call is queued ('profit_snapshot') and replayed; a replay writes nothing twice.
 */
export const addGrossProfitCloud = async (input: CloudProfitInput): Promise<boolean> => {
  if (!input.invoiceId) return false;
  try {
    const { error } = await (sb.rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ error: { message?: string; code?: string } | null }>)(
      'record_sale_profit_snapshot', { _invoice_number: input.invoiceId });
    if (error) throw error;
    return true;
  } catch (e) {
    console.warn('[profits-cloud] snapshot failed, queued:', e);
    try { addToQueue('profit_snapshot', { invoiceId: input.invoiceId }); } catch { /* noop */ }
    return false;
  }
};

/** عكس ربح الفاتورة (للمرتجع/الحذف) - يضع is_reversed=true */
export const reverseProfitCloud = async (invoiceId: string): Promise<boolean> => {
  const ownerId = await getOwnerIdForInsert();
  if (!ownerId) return false;

  try {
    const { error } = await sb
      .from('profit_records')
      .update({ is_reversed: true, reversed_at: new Date().toISOString() })
      .eq('user_id', ownerId) // ✅ ضمان فك ربحية سجل المالك
      .eq('invoice_id', invoiceId)
      .eq('is_reversed', false);
    if (error) throw error;
    return true;
  } catch (e) {
    console.warn('[profits-cloud] reverse failed, queued:', e);
    try { addToQueue('profit_reverse', { invoiceId, userId: ownerId }); } catch { /* noop */ }
    return false;
  }
};
