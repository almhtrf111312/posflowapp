import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/sonner-bridge';
import { loadShiftVarianceTolerance, saveShiftVarianceTolerance } from '@/lib/cloud/cashbox-cloud';
import { useUserRole } from '@/hooks/user-role-context';
import { useLanguage } from '@/hooks/language-context';

/** Shift closing variance tolerance (in USD) — read by server on shift close */
export function ShiftToleranceField() {
  const { isOwner } = useUserRole();
  const { t } = useLanguage();
  const [value, setValue] = useState('1');
  const [saving, setSaving] = useState(false);

  useEffect(() => { void loadShiftVarianceTolerance().then(v => setValue(String(v))); }, []);
  if (!isOwner) return null;

  const save = async () => {
    const n = parseFloat(value);
    if (!Number.isFinite(n) || n < 0) { toast.error(t('storeSettings.shiftToleranceInvalid')); return; }
    setSaving(true);
    const ok = await saveShiftVarianceTolerance(n);
    setSaving(false);
    if (ok) toast.success(t('storeSettings.shiftToleranceSaved')); else toast.error(t('storeSettings.shiftToleranceSaveError'));
  };

  return (
    <div className="pt-3 border-t border-border space-y-2">
      <div className="text-sm font-semibold">{t('storeSettings.shiftToleranceTitle')}</div>
      <p className="text-xs text-muted-foreground">{t('storeSettings.shiftToleranceDesc')}</p>
      <div className="flex gap-2">
        <Input type="number" min="0" step="0.1" value={value} onChange={e => setValue(e.target.value)} className="max-w-[140px]" />
        <Button size="sm" onClick={save} disabled={saving}>{t('common.save')}</Button>
      </div>
    </div>
  );
}
