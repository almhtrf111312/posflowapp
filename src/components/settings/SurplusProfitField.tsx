import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { useUserRole } from '@/hooks/use-user-role';
import { supabase } from '@/integrations/supabase/client';

const KEY = 'posflow_surplus_as_profit';

/** يقرأ الإعداد من store_settings (مصدر الحقيقة) ويحدّث الكاش المحلي؛ يعمل دون إنترنت بالكاش */
export async function syncSurplusSetting(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const { data, error } = await (supabase as any).from('store_settings').select('surplus_as_profit').limit(1).maybeSingle();
    if (error || !data || typeof data.surplus_as_profit !== 'boolean') return;
    localStorage.setItem(KEY, data.surplus_as_profit ? 'true' : 'false');
  } catch { /* ignore */ }
}

/** الزيادة في المقبوض عند الدفع النقدي: تُعتمد ربحاً إضافياً (افتراضي) أو تُهمل */
export function SurplusProfitField() {
  const { isOwner } = useUserRole();
  const [on, setOn] = useState(() => { try { return localStorage.getItem(KEY) !== 'false'; } catch { return true; } });
  if (!isOwner) return null;
  const change = async (v: boolean) => {
    setOn(v);
    try { localStorage.setItem(KEY, v ? 'true' : 'false'); } catch { /* ignore */ }
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) await (supabase as any).from('store_settings').update({ surplus_as_profit: v }).eq('user_id', user.id);
    } catch { /* ignore */ }
  };
  return (
    <div className="pt-3 border-t border-border flex items-start justify-between gap-3">
      <div>
        <div className="text-sm font-semibold">اعتماد الزيادة في المقبوض كربح إضافي</div>
        <p className="text-xs text-muted-foreground">عند أخذ مبلغ أكبر من الفاتورة نقداً: مفعّل = تُرفع الأسعار وتُسجَّل الزيادة ربحاً. معطّل = لا تُضاف للربح.</p>
      </div>
      <Switch checked={on} onCheckedChange={change} />
    </div>
  );
}
