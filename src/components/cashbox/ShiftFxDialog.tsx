import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/sonner-bridge';
import { getEnabledCurrencies, toUsd, fromUsd, round8 } from '@/lib/money-engine';
import { addWithdrawalFromShift, addDepositToShift } from '@/lib/cashbox-store';
import { recordShiftFxCloud } from '@/lib/cloud/cashbox-cloud';
import { extractErrorMessage } from '@/lib/sync-queue';

export function ShiftFxDialog({ open, onOpenChange, shiftId, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; shiftId: string; onDone?: () => void }) {
  const currencies = useMemo(() => getEnabledCurrencies(), []);
  const [from, setFrom] = useState(currencies[0]?.code || 'USD');
  const [to, setTo] = useState(currencies[1]?.code || currencies[0]?.code || 'USD');
  const [fromAmt, setFromAmt] = useState('');
  const [toAmt, setToAmt] = useState('');
  const [busy, setBusy] = useState(false);

  const suggest = (amt: string, f: string, t: string) => {
    const n = Number(amt);
    if (n > 0 && f !== t) setToAmt(String(Math.round(fromUsd(toUsd(n, f), t) * 100) / 100));
  };

  const submit = async () => {
    const a = Number(fromAmt), b = Number(toAmt);
    if (from === to || !(a > 0) || !(b > 0)) { toast.error('اختر عملتين مختلفتين وأدخل المبلغين'); return; }
    const fromUsdVal = round8(toUsd(a, from));
    const toUsdVal = round8(toUsd(b, to));
    setBusy(true);
    try {
      await recordShiftFxCloud({ shiftId, fromCode: from, fromAmount: a, fromUsd: fromUsdVal, toCode: to, toAmount: b, toUsd: toUsdVal });
      addWithdrawalFromShift(fromUsdVal, from, a);
      addDepositToShift(toUsdVal, to, b);
      toast.success('تم تسجيل التحويل');
      setFromAmt(''); setToAmt('');
      onDone?.();
      onOpenChange(false);
    } catch (e) { toast.error(extractErrorMessage(e) || 'حدث خطأ'); } finally { setBusy(false); }
  };

  const sel = 'h-10 rounded-md border border-input bg-background px-2 text-sm';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" dir="rtl">
        <DialogHeader><DialogTitle>تحويل عملة داخل الصندوق</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">يخرج المبلغ الأول من الصندوق ويدخل المبلغ الثاني بعملة أخرى. عدّل المبلغ الثاني إن اختلف سعر الصرف الفعلي.</div>
          <div className="flex gap-2">
            <select className={sel} value={from} onChange={e => { setFrom(e.target.value); suggest(fromAmt, e.target.value, to); }}>{currencies.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}</select>
            <Input type="number" inputMode="decimal" placeholder="المبلغ الخارج" value={fromAmt} onChange={e => { setFromAmt(e.target.value); suggest(e.target.value, from, to); }} />
          </div>
          <div className="flex gap-2">
            <select className={sel} value={to} onChange={e => { setTo(e.target.value); suggest(fromAmt, from, e.target.value); }}>{currencies.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}</select>
            <Input type="number" inputMode="decimal" placeholder="المبلغ الداخل" value={toAmt} onChange={e => setToAmt(e.target.value)} />
          </div>
          <Button className="w-full" disabled={busy} onClick={submit}>تأكيد التحويل</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
