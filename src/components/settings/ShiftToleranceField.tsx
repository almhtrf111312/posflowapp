import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/sonner-bridge';
import { loadShiftVarianceTolerance, saveShiftVarianceTolerance } from '@/lib/cloud/cashbox-cloud';
import { useUserRole } from '@/hooks/use-user-role';

/** حد سماح فروقات إقفال الوردية (بالدولار) — يقرأه الخادم عند الإقفال */
export function ShiftToleranceField() {
  const { isOwner } = useUserRole();
  const [value, setValue] = useState('1');
  const [saving, setSaving] = useState(false);

  useEffect(() => { void loadShiftVarianceTolerance().then(v => setValue(String(v))); }, []);
  if (!isOwner) return null;

  const save = async () => {
    const n = parseFloat(value);
    if (!Number.isFinite(n) || n < 0) { toast.error('أدخل قيمة صحيحة'); return; }
    setSaving(true);
    const ok = await saveShiftVarianceTolerance(n);
    setSaving(false);
    if (ok) toast.success('تم حفظ حد السماح'); else toast.error('تعذر الحفظ (تحقق من الاتصال)');
  };

  return (
    <div className="pt-3 border-t border-border space-y-2">
      <div className="text-sm font-semibold">حد سماح فروقات الصندوق (بالدولار)</div>
      <p className="text-xs text-muted-foreground">أي فرق عند إقفال الوردية لا يتجاوز هذا المبلغ (لكل عملة وللصافي) يُعتمد فرق تقريب دون سؤال.</p>
      <div className="flex gap-2">
        <Input type="number" min="0" step="0.1" value={value} onChange={e => setValue(e.target.value)} className="max-w-[140px]" />
        <Button size="sm" onClick={save} disabled={saving}>حفظ</Button>
      </div>
    </div>
  );
}
