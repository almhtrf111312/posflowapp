import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { useUserRole } from '@/hooks/use-user-role';

const KEY = 'posflow_surplus_as_profit';

/** الزيادة في المقبوض عند الدفع النقدي: تُعتمد ربحاً إضافياً (افتراضي) أو تُهمل */
export function SurplusProfitField() {
  const { isOwner } = useUserRole();
  const [on, setOn] = useState(() => { try { return localStorage.getItem(KEY) !== 'false'; } catch { return true; } });
  if (!isOwner) return null;
  const change = (v: boolean) => { setOn(v); try { localStorage.setItem(KEY, v ? 'true' : 'false'); } catch { /* ignore */ } };
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
