import { supabase } from '@/integrations/supabase/client';
const sb = supabase;
import { logActivity } from '@/lib/activity-log';

export interface StockDamage {
  id: string;
  user_id: string;
  product_id: string;
  product_name?: string | null;
  warehouse_id?: string | null;
  quantity: number;
  unit_cost: number;
  cost_value: number;
  reason?: string | null;
  notes?: string | null;
  damaged_at: string;
  recorded_by?: string | null;
  recorded_by_name?: string | null;
  source?: string | null;
  source_ref?: string | null;
  created_at: string;
}

export async function listStockDamages(opts?: { from?: string; to?: string; productId?: string }): Promise<StockDamage[]> {
  let q = sb.from('stock_damages').select('*').order('damaged_at', { ascending: false }).limit(500);
  if (opts?.from) q = q.gte('damaged_at', opts.from);
  if (opts?.to) q = q.lte('damaged_at', opts.to);
  if (opts?.productId) q = q.eq('product_id', opts.productId);
  const { data, error } = await q;
  if (error) { console.error(error); return []; }
  return (data || []) as StockDamage[];
}

export async function recordDamage(params: {
  product_id: string;
  product_name?: string;
  warehouse_id?: string | null;
  quantity: number;
  unit_cost: number;
  reason?: string;
  notes?: string;
  applyToStock?: boolean;
}): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const cost_value = params.quantity * params.unit_cost;

  // تسجيل التالف وخصم المخزون في معاملة ذرية واحدة (حركة مخزون من نوع damage)
  const { error } = await sb.rpc('record_stock_damage_atomic', {
    _product_id: params.product_id,
    _warehouse_id: params.warehouse_id || null,
    _quantity: params.quantity,
    _unit_cost: params.unit_cost,
    _reason: params.reason || null,
    _notes: params.notes || null,
    _apply_to_stock: !!params.applyToStock,
    _source: 'manual',
    _source_ref: null,
  });
  if (error) { console.error(error); return false; }

  logActivity('product_updated' as never, `إتلاف ${params.quantity} من ${params.product_name || ''}`, {
    entityType: 'stock_damage', entityId: params.product_id, quantity: params.quantity, cost_value
  });

  return true;
}
