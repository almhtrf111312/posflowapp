import { useMemo, useRef, useState } from 'react';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
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
  // One operation id per exchange, reused if the user retries after an error (F-20); renewed after a success.
  const opIdRef = useRef<string>((typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`));

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
      await recordShiftFxCloud({ shiftId, fromCode: from, fromAmount: a, fromUsd: fromUsdVal, toCode: to, toAmount: b, toUsd: toUsdVal, operationId: opIdRef.current });
      opIdRef.current = (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      addWithdrawalFromShift(fromUsdVal, from, a);
      addDepositToShift(toUsdVal, to, b);
      toast.success('تم تسجيل التحويل');
      setFromAmt(''); setToAmt('');
      onDone?.();
      onOpenChange(false);
    } catch (e) { toast.error(extractErrorMessage(e) || 'حدث خطأ'); } finally { setBusy(false); }
  };

  const isDirty = busy || Boolean(fromAmt || toAmt);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(calc(100vw-1.5rem),28rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]"
        onPointerDownOutside={(e) => { if (isDirty) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (isDirty) e.preventDefault(); }}
      >
        <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
          <DialogTitle>تحويل عملة داخل الصندوق</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="text-xs text-muted-foreground">يخرج المبلغ الأول من الصندوق ويدخل المبلغ الثاني بعملة أخرى. عدّل المبلغ الثاني إن اختلف سعر الصرف الفعلي.</div>
          <div className="flex items-center gap-2">
            <Select value={from} onValueChange={v => { setFrom(v); suggest(fromAmt, v, to); }}>
              <SelectTrigger className="min-h-11 sm:min-h-10 w-28 shrink-0 rounded-[14px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-[min(20rem,60dvh)] overflow-y-auto">
                {currencies.map(c => <SelectItem key={c.code} value={c.code}>{c.code}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input dir="ltr" className="tabular-nums" type="number" inputMode="decimal" placeholder="المبلغ الخارج" value={fromAmt} onChange={e => { setFromAmt(e.target.value); suggest(e.target.value, from, to); }} />
          </div>
          <div className="flex items-center gap-2">
            <Select value={to} onValueChange={v => { setTo(v); suggest(fromAmt, from, v); }}>
              <SelectTrigger className="min-h-11 sm:min-h-10 w-28 shrink-0 rounded-[14px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-[min(20rem,60dvh)] overflow-y-auto">
                {currencies.map(c => <SelectItem key={c.code} value={c.code}>{c.code}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input dir="ltr" className="tabular-nums" type="number" inputMode="decimal" placeholder="المبلغ الداخل" value={toAmt} onChange={e => setToAmt(e.target.value)} />
          </div>
        </DialogBody>
        <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
          <Button variant="outline" size="default" disabled={busy} onClick={() => onOpenChange(false)}>إلغاء</Button>
          <Button variant="default" size="default" disabled={busy} onClick={submit}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            تأكيد التحويل
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
