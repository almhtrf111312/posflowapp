import { useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { useUserRole } from '@/hooks/user-role-context';
import { useLanguage } from '@/hooks/language-context';
import { supabase } from '@/integrations/supabase/client';
import { getOwnerIdForInsert } from '@/lib/supabase-store';

import { SURPLUS_PROFIT_KEY as KEY, syncSurplusSetting } from '@/components/settings/surplus-profit-sync';

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
        await (supabase as unknown as { from: (t: string) => { update: (v: { surplus_as_profit: boolean }) => { eq: (col: string, val: string) => Promise<unknown> } } })
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
