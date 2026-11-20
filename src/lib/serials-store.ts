import { supabase } from '@/integrations/supabase/client';

// اختيارات الأرقام التسلسلية للسلة الحالية (في الذاكرة فقط؛ الخادم هو المرجع عند الحفظ)
const selected = new Map<string, string[]>();

export const getSelectedSerials = (productId: string): string[] | undefined => selected.get(productId);
export const setSelectedSerials = (productId: string, serials: string[]) => { selected.set(productId, serials); };
export const clearSelectedSerials = (productIds: string[]) => { productIds.forEach(id => selected.delete(id)); };

const db = supabase as any;

export async function loadTrackedProducts(ids: string[]): Promise<Record<string, boolean>> {
  if (ids.length === 0) return {};
  const { data, error } = await db.from('products').select('id, track_serials').in('id', ids);
  if (error) return {};
  const out: Record<string, boolean> = {};
  for (const r of data || []) out[r.id] = !!r.track_serials;
  return out;
}

export async function loadInStockSerials(productId: string): Promise<string[]> {
  const { data, error } = await db
    .from('product_serials').select('serial').eq('product_id', productId).eq('status', 'in_stock').order('serial').limit(500);
  if (error) return [];
  return (data || []).map((r: { serial: string }) => r.serial);
}

export async function lookupSerialCloud(serial: string): Promise<any[]> {
  const { data, error } = await db.rpc('lookup_serial', { _serial: serial });
  if (error) throw error;
  return data || [];
}
