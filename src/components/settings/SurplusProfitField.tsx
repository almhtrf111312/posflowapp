import { useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { useUserRole } from '@/hooks/use-user-role';
import { useLanguage } from '@/hooks/use-language';
import { supabase } from '@/integrations/supabase/client';
import { getOwnerIdForInsert } from '@/lib/supabase-store';

const KEY = 'posflow_surplus_as_profit';

/** Reads setting from store_settings (source of truth) and updates local cache; works offline via cache */
export async function syncSurplusSetting(): Promise<boolean | null> {
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
    const { data: { user } } = await supabase.auth.getUser();
    const ownerId = (await getOwnerIdForInsert()) || user?.id;
    if (!ownerId) return null;
    const { data, error } = await (supabase as any)
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

/** Cash overpayment surplus: recorded as extra profit (default) or ignored */
export function SurplusProfitField() {
  const { isOwner } = useUserRole();
  const { t } = useLanguage();
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== 'false';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    if (!isOwner) return;
    let alive = true;
    void syncSurplusSetting().then((synced) => {
      if (alive && typeof synced === 'boolean') {
        setOn(synced);
      }
    });
    return () => {
      alive = false;
    };
  }, [isOwner]);

  if (!isOwner) return null;

  const change = async (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem(KEY, v ? 'true' : 'false');
    } catch {
      /* ignore */
    }
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const ownerId = (await getOwnerIdForInsert()) || user?.id;
      if (ownerId) {
        await (supabase as any)
          .from('store_settings')
          .update({ surplus_as_profit: v })
          .eq('user_id', ownerId);
      }
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="pt-3 border-t border-border flex items-start justify-between gap-3">
      <div>
        <div className="text-sm font-semibold">{t('storeSettings.surplusAsProfitTitle')}</div>
        <p className="text-xs text-muted-foreground">
          {t('storeSettings.surplusAsProfitDesc')}
        </p>
      </div>
      <Switch checked={on} onCheckedChange={change} />
    </div>
  );
}
