import { supabase } from '@/integrations/supabase/client';
import { getOwnerIdForInsert } from '@/lib/supabase-store';

export const SURPLUS_PROFIT_KEY = 'posflow_surplus_as_profit';
const KEY = SURPLUS_PROFIT_KEY;

/** Reads setting from store_settings (source of truth) and updates local cache; works offline via cache */
export async function syncSurplusSetting(): Promise<boolean | null> {
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
    const { data: { user } } = await supabase.auth.getUser();
    const ownerId = (await getOwnerIdForInsert()) || user?.id;
    if (!ownerId) return null;
    const { data, error } = await (supabase as unknown as { from: (t: string) => { select: (c: string) => { eq: (col: string, val: string) => { limit: (n: number) => { maybeSingle: () => Promise<{ data: { surplus_as_profit?: boolean } | null; error: unknown }> } } } } })
      .from('store_settings')
      .select('surplus_as_profit')
      .eq('user_id', ownerId)
      .limit(1)
      .maybeSingle();
    if (error || !data || typeof data.surplus_as_profit !== 'boolean') return null;
    localStorage.setItem(KEY, data.surplus_as_profit ? 'true' : 'false');
    return data.surplus_as_profit;
  } catch {
    return null;
  }
}
