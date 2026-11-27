// Owner view: every cashier's open shift, with remote close (counted cash + decision) and "open a shift for a cashier".
// Closing and opening go through the same server RPCs as the cashier's own device (close_cash_shift_atomic /
// open_cash_shift_atomic); the cashier's device then adopts or closes its local copy on its next sync.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ShiftDetailsDialog } from './ShiftDetailsDialog';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, PlayCircle, StopCircle, Users } from 'lucide-react';
import { toast } from '@/lib/sonner-bridge';
import { round8, getEnabledCurrencies } from '@/lib/money-engine';
import { formatMoney, formatDateTime } from '@/lib/utils';
import { addActivityLog } from '@/lib/activity-log';
import {
  closeShiftCloud, openShiftCloud, loadStoreOpenShifts, loadStoreCashiers, loadShiftExpectedFromMovements, CloudShift,
} from '@/lib/cloud/cashbox-cloud';

interface Props {
  ownerId: string;
  ownerName: string;
  isEn: boolean;
  /** Called after a close/open so the page can reload its lists. */
  onChanged?: () => void;
}

type OpenRow = CloudShift & { expected: number | null };

export function CashierShiftsManager({ ownerId, ownerName, isEn, onChanged }: Props) {
  const [rows, setRows] = useState<OpenRow[]>([]);
  const [cashiers, setCashiers] = useState<Array<{ id: string; name: string }>>([]);
  const [closing, setClosing] = useState<OpenRow | null>(null);
  const [counted, setCounted] = useState('');
  const [decision, setDecision] = useState<'accept' | 'defer'>('accept');
  const [opening, setOpening] = useState(false);
  const [openFor, setOpenFor] = useState('');
  // Opening float per currency (units of each currency); USD value = Σ units / rate.
  const [openAmounts, setOpenAmounts] = useState<Record<string, string>>({});
  const openCurrencies = [{ code: 'USD', rate: 1 }, ...getEnabledCurrencies()
    .filter(c => c.code.toUpperCase() !== 'USD' && c.rate > 0).map(c => ({ code: c.code.toUpperCase(), rate: c.rate }))];
  const [busy, setBusy] = useState(false);
  const [detailsRow, setDetailsRow] = useState<OpenRow | null>(null);
  const detailsInput = useMemo(() => (detailsRow ? {
    id: detailsRow.id, userName: detailsRow.cashier_name || (isEn ? 'Cashier' : 'كاشير'), openedAt: detailsRow.opened_at,
    openingCash: Number(detailsRow.opening_balance) || 0, status: 'open' as const, cashierId: detailsRow.cashier_id || undefined,
  } : null), [detailsRow, isEn]);

  const reload = useCallback(async () => {
    const [shifts, list] = await Promise.all([loadStoreOpenShifts(), loadStoreCashiers(ownerId)]);
    setCashiers(list);
    // Cashiers' shifts only: the owner's own shift is managed by the page above.
    const others = shifts.filter(s => s.cashier_id && s.cashier_id !== ownerId);
    const withExpected = await Promise.all(others.map(async s => ({
      ...s,
      expected: await loadShiftExpectedFromMovements(s.id, s.opening_balance).catch(() => null),
    })));
    setRows(withExpected);
  }, [ownerId]);

  useEffect(() => { void reload(); }, [reload]);

  const submitClose = async () => {
    if (!closing) return;
    const value = parseFloat(counted);
    if (!Number.isFinite(value) || value < 0) {
      toast.error(isEn ? 'Enter the counted amount' : 'أدخل المبلغ المعدود');
      return;
    }
    const expected = closing.expected ?? (Number(closing.expected_balance) || 0);
    setBusy(true);
    try {
      const ok = await closeShiftCloud({
        shiftId: closing.id,
        expectedBalance: expected,
        actualBalance: round8(value),
        varianceReason: isEn ? `Closed by the owner (${ownerName})` : `أُغلقت من حساب المالك (${ownerName})`,
        decision,
      });
      const diff = round8(value - expected);
      addActivityLog('shift_closed', ownerId, ownerName,
        `${isEn ? 'Closed cashier shift' : 'إغلاق وردية كاشير'} ${closing.cashier_name || ''} - ${formatMoney(value, 'USD')} (${diff >= 0 ? '+' : ''}${formatMoney(diff, 'USD')})`);
      if (ok) toast.success(isEn ? 'Shift closed' : 'تم إغلاق الوردية');
      else toast.warning(isEn ? 'Saved; it will be sent when the connection is back' : 'حُفظ الإغلاق وسيُرسل عند عودة الاتصال');
      setClosing(null);
      setCounted('');
      setDecision('accept');
      await reload();
      onChanged?.();
    } catch (err) {
      console.error('[CashierShiftsManager] close failed:', err);
      toast.error(err instanceof Error ? err.message : (isEn ? 'Could not close the shift' : 'تعذّر إغلاق الوردية'));
    } finally {
      setBusy(false);
    }
  };

  const submitOpen = async () => {
    const cashier = cashiers.find(c => c.id === openFor);
    const byCcy: Record<string, number> = {};
    let value = 0;
    let bad = false;
    openCurrencies.forEach(c => {
      const raw = (openAmounts[c.code] || '').trim();
      if (!raw) return;
      const units = parseFloat(raw);
      if (!Number.isFinite(units) || units < 0) { bad = true; return; }
      if (units > 0) { byCcy[c.code] = round8(units); value = round8(value + units / c.rate); }
    });
    if (!cashier || bad) {
      toast.error(isEn ? 'Choose a cashier and an opening amount' : 'اختر الكاشير وأدخل رصيد الافتتاح');
      return;
    }
    setBusy(true);
    try {
      const res = await openShiftCloud({
        shiftId: crypto.randomUUID(),
        cashierId: cashier.id,
        cashierName: cashier.name,
        openingBalance: round8(value),
        openingByCurrency: Object.keys(byCcy).length > 0 ? byCcy : undefined,
      });
      if (res === 'conflict') {
        toast.error(isEn ? 'This cashier already has an open shift' : 'لهذا الكاشير وردية مفتوحة بالفعل');
      } else {
        addActivityLog('shift_opened', ownerId, ownerName, `${isEn ? 'Opened a shift for' : 'فتح وردية للكاشير'} ${cashier.name} - ${Object.entries(byCcy).map(([k, v]) => `${v} ${k}`).join('، ') || formatMoney(0, 'USD')}`);
        toast.success(isEn ? 'Shift opened for the cashier' : 'تم فتح وردية للكاشير');
        setOpening(false);
        setOpenFor('');
        setOpenAmounts({});
      }
      await reload();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const closingExpected = closing ? (closing.expected ?? (Number(closing.expected_balance) || 0)) : 0;
  const closingDiff = closing && counted !== '' ? round8((parseFloat(counted) || 0) - closingExpected) : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-primary" />
            {isEn ? "Cashiers' open shifts" : 'ورديات الكاشيرية المفتوحة'}
          </CardTitle>
          <CardDescription>
            {isEn ? 'Close a cashier shift from your account, or open one for a cashier.' : 'أغلق وردية كاشير من حسابك، أو افتح وردية لكاشير.'}
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpening(true)} disabled={!cashiers.length}>
          <PlayCircle className="h-4 w-4 shrink-0" />
          {isEn ? 'Open for a cashier' : 'فتح وردية لكاشير'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 && (
          <p className="text-sm text-muted-foreground">{isEn ? 'No open cashier shifts.' : 'لا توجد ورديات كاشير مفتوحة.'}</p>
        )}
        {rows.map(r => (
          <div key={r.id} className="flex items-center justify-between gap-3 rounded-xl border p-3">
            <div className="min-w-0">
              <div className="font-semibold truncate">{r.cashier_name || (isEn ? 'Cashier' : 'كاشير')}</div>
              <div className="text-xs text-muted-foreground">{formatDateTime(r.opened_at)}</div>
              <div className="text-xs">
                {isEn ? 'Opening' : 'الافتتاح'}: {formatMoney(Number(r.opening_balance) || 0, 'USD')} ·{' '}
                {isEn ? 'Expected' : 'المتوقع'}: <span className="font-bold">{formatMoney(r.expected ?? (Number(r.expected_balance) || 0), 'USD')}</span>
              </div>
            </div>
            <div className="flex shrink-0 gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setDetailsRow(r)}>{isEn ? 'Details' : 'التفاصيل'}</Button>
            <Button size="sm" variant="destructive" onClick={() => { setClosing(r); setCounted(''); setDecision('accept'); }}>
              <StopCircle className="h-4 w-4 shrink-0" />
              {isEn ? 'Close' : 'إغلاق'}
            </Button>
            </div>
          </div>
        ))}
      </CardContent>

      <Dialog open={!!closing} onOpenChange={(o) => { if (!o) setClosing(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isEn ? 'Close cashier shift' : 'إغلاق وردية الكاشير'} — {closing?.cashier_name}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>{isEn ? 'Expected in the drawer' : 'المتوقع في الدرج'}: <b>{formatMoney(closingExpected, 'USD')}</b></span>
              <Button size="sm" variant="ghost" onClick={() => closing && setDetailsRow(closing)}>{isEn ? 'Details' : 'التفاصيل'}</Button>
            </div>
            <div className="space-y-1">
              <Label>{isEn ? 'Counted cash (USD)' : 'النقد المعدود (دولار)'}</Label>
              <Input type="number" inputMode="decimal" min="0" value={counted} onChange={e => setCounted(e.target.value)} />
            </div>
            {closingDiff !== null && closingDiff !== 0 && (
              <>
                <div className={closingDiff < 0 ? 'text-destructive text-sm font-bold' : 'text-info text-sm font-bold'}>
                  {closingDiff < 0 ? (isEn ? 'Shortage' : 'نقص') : (isEn ? 'Surplus' : 'زيادة')} {formatMoney(Math.abs(closingDiff), 'USD')}
                </div>
                <RadioGroup value={decision} onValueChange={(v) => setDecision(v as 'accept' | 'defer')} className="space-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value="accept" />
                    {isEn ? 'Record the difference now (surplus/shortage)' : 'تسجيل الفرق الآن كفائض أو عجز'}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value="defer" />
                    {isEn ? 'Defer: decide later' : 'تأجيل القرار لاحقاً'}
                  </label>
                </RadioGroup>
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosing(null)}>{isEn ? 'Cancel' : 'إلغاء'}</Button>
            <Button variant="destructive" onClick={submitClose} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {isEn ? 'Close shift' : 'إغلاق الوردية'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={opening} onOpenChange={setOpening}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isEn ? 'Open a shift for a cashier' : 'فتح وردية لكاشير'}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <div className="space-y-1">
              <Label>{isEn ? 'Cashier' : 'الكاشير'}</Label>
              <Select value={openFor} onValueChange={setOpenFor}>
                <SelectTrigger><SelectValue placeholder={isEn ? 'Choose' : 'اختر'} /></SelectTrigger>
                <SelectContent>
                  {cashiers.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {openCurrencies.map(c => (
              <div key={c.code} className="space-y-1">
                <Label>{isEn ? 'Opening cash' : 'رصيد الافتتاح'} ({c.code})</Label>
                <Input type="number" inputMode="decimal" min="0" value={openAmounts[c.code] ?? ''}
                  onChange={e => setOpenAmounts(prev => ({ ...prev, [c.code]: e.target.value }))} />
              </div>
            ))}
            <p className="text-xs text-muted-foreground">{isEn ? 'The opening cash is taken from the general drawer.' : 'رصيد الافتتاح يُسحب من الصندوق العام.'}</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpening(false)}>{isEn ? 'Cancel' : 'إلغاء'}</Button>
            <Button onClick={submitOpen} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {isEn ? 'Open shift' : 'فتح الوردية'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ShiftDetailsDialog shift={detailsInput} isEn={isEn} onClose={() => setDetailsRow(null)} />
    </Card>
  );
}
