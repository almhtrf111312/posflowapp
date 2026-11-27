// General store drawer card (D-35): the store's permanent drawer. Shows its balance (from its cloud movements, F-18),
// opens its movement details, lets the owner add cash (starting balance / capital deposit) and count it (optional
// reconciliation: the difference is posted as surplus/shortage, the drawer stays open). Cashier shifts hand their counted
// cash to it when they close and take their opening float from it when they open (server triggers).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Landmark } from 'lucide-react';
import { toast } from '@/lib/sonner-bridge';
import { formatMoney } from '@/lib/utils';
import { round8, getEnabledCurrencies } from '@/lib/money-engine';
import { INFLOW_TYPES, OUTFLOW_TYPES } from '@/lib/shift-adopt';
import { addActivityLog } from '@/lib/activity-log';
import {
  ensureGeneralDrawerCloud, countGeneralDrawerCloud, loadShiftExpectedFromMovements, addShiftTransactionCloud, loadShiftMovements,
} from '@/lib/cloud/cashbox-cloud';
import { ShiftDetailsDialog } from './ShiftDetailsDialog';

const newOpId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function GeneralDrawerCard({ isOwner, userId, userName, isEn }: { isOwner: boolean; userId: string; userName: string; isEn: boolean }) {
  const [id, setId] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  // Balance per currency (units of each currency), from the drawer's movements; USD includes the starting balance.
  const [byCurrency, setByCurrency] = useState<Record<string, number>>({});
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [depositCcy, setDepositCcy] = useState('USD');
  const [mode, setMode] = useState<'count' | 'deposit' | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const opRef = useRef(newOpId());
  // Stable object: the details dialog reloads when its shift prop changes.
  const detailsShift = useMemo(() => (showDetails && id
    ? { id, userName: isEn ? 'General drawer' : 'الصندوق العام', openedAt: new Date().toISOString(), openingCash: 0, status: 'open' as const }
    : null), [showDetails, id, isEn]);

  const reload = useCallback(async () => {
    const gid = await ensureGeneralDrawerCloud();
    setId(gid);
    setBalance(gid ? await loadShiftExpectedFromMovements(gid, 0) : null);
    if (gid) {
      const rows = await loadShiftMovements(gid);
      const map: Record<string, number> = {};
      rows.forEach(r => {
        const code = (r.currency || 'USD').toUpperCase();
        const units = r.currency_amount ?? r.amount;
        const sign = INFLOW_TYPES.includes(r.type) ? 1 : OUTFLOW_TYPES.includes(r.type) ? -1 : 0;
        map[code] = round8((map[code] || 0) + sign * units);
      });
      setByCurrency(map);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const submit = async () => {
    if (mode === 'count') {
      const list = countCurrencies
        .filter(c => (counts[c.code] ?? '').trim() !== '')
        .map(c => ({ code: c.code, counted: parseFloat(counts[c.code]), rate: c.code === 'USD' ? 1 : c.rate }));
      if (!id || list.length === 0 || list.some(c => !Number.isFinite(c.counted) || c.counted < 0)) {
        toast.error(isEn ? 'Enter the counted amount' : 'أدخل المبلغ المعدود');
        return;
      }
      setBusy(true);
      try {
        const res = await countGeneralDrawerCloud(list, isEn ? `Counted by ${userName}` : `عدّه ${userName}`, opRef.current);
        void import('@/lib/sync-history').then(m => m.logDirectSync(`direct-count-${opRef.current}`, 'general_count', 'عدّ الصندوق العام', true, undefined, undefined, 'system'));
        const diffs = res.filter(r => r.difference !== 0);
        addActivityLog('shift_closed', userId, userName, `${isEn ? 'General drawer count' : 'عدّ الصندوق العام'}: ${res.map(r => `${r.counted} ${r.code} (${r.difference >= 0 ? '+' : ''}${r.difference})`).join('، ')}`);
        toast.success(diffs.length === 0 ? (isEn ? 'Matched' : 'الصندوق مطابق')
          : diffs.map(r => `${r.difference > 0 ? (isEn ? 'Surplus' : 'فائض') : (isEn ? 'Shortage' : 'عجز')} ${Math.abs(r.difference)} ${r.code}`).join('، '));
        opRef.current = newOpId();
        setMode(null);
        setCounts({});
        await reload();
      } catch (err) {
        console.error('[GeneralDrawerCard] count failed:', err);
        toast.error(err instanceof Error ? err.message : (isEn ? 'Failed' : 'تعذّرت العملية'));
      } finally {
        setBusy(false);
      }
      return;
    }
    const v = parseFloat(amount);
    if (!id || !Number.isFinite(v) || v < 0 || (mode === 'deposit' && v <= 0)) {
      toast.error(isEn ? 'Enter a valid amount' : 'أدخل مبلغاً صحيحاً');
      return;
    }
    setBusy(true);
    try {
      {
        // Deposit in any enabled currency: stored in USD with the original amount and its rate (F-01).
        const rate = depositCcy === 'USD' ? 1 : (getEnabledCurrencies().find(c => c.code.toUpperCase() === depositCcy)?.rate || 0);
        if (!(rate > 0)) throw new Error(isEn ? 'This currency has no exchange rate' : 'لا يوجد سعر صرف لهذه العملة');
        const ok = await addShiftTransactionCloud({
          shiftId: id, type: 'deposit_capital', amount: round8(v / rate), currency: depositCcy, currencyAmount: round8(v), exchangeRate: rate,
          notes: isEn ? 'Cash added to the general drawer' : 'إيداع في الصندوق العام',
        });
        if (!ok) throw new Error(isEn ? 'Could not record the deposit' : 'تعذّر تسجيل الإيداع');
        void import('@/lib/sync-history').then(m => m.logDirectSync(`direct-dep-${opRef.current}`, 'general_deposit', 'إيداع في الصندوق العام', true, undefined, undefined, 'system'));
        addActivityLog('shift_opened', userId, userName, `${isEn ? 'General drawer deposit' : 'إيداع في الصندوق العام'}: ${v} ${depositCcy}`);
        toast.success(isEn ? 'Deposit recorded' : 'تم تسجيل الإيداع');
      }
      opRef.current = newOpId();
      setMode(null);
      setAmount('');
      await reload();
    } catch (err) {
      console.error('[GeneralDrawerCard] action failed:', err);
      toast.error(err instanceof Error ? err.message : (isEn ? 'Failed' : 'تعذّرت العملية'));
    } finally {
      setBusy(false);
    }
  };

  // Currencies to count: USD, the enabled ones, and any currency already in the drawer.
  const enabled = getEnabledCurrencies();
  const countCurrencies = Array.from(new Set(['USD', ...enabled.map(c => c.code.toUpperCase()), ...Object.keys(byCurrency)]))
    .map(code => ({ code, rate: code === 'USD' ? 1 : (enabled.find(c => c.code.toUpperCase() === code)?.rate || 0) }));

  if (!id) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Landmark className="h-4 w-4 text-primary" />
            {isEn ? 'General store drawer' : 'الصندوق العام'}
          </CardTitle>
          <CardDescription>
            {isEn ? 'Cash outside shifts, plus the cash of every closed shift.' : 'النقد خارج الورديات، ونقد كل وردية عند إغلاقها.'}
          </CardDescription>
        </div>
        <div className="text-end shrink-0">
          <div className="text-xs text-muted-foreground">{isEn ? 'Balance' : 'الرصيد'}</div>
          <div dir="ltr" className={balance !== null && balance < 0 ? 'text-lg font-black tabular-nums text-destructive' : 'text-lg font-black tabular-nums'}>
            {balance === null ? '—' : formatMoney(balance, 'USD')}
          </div>
          {Object.entries(byCurrency).filter(([code, v]) => code !== 'USD' && v !== 0).map(([code, v]) => (
            <div key={code} dir="ltr" className="text-xs tabular-nums text-muted-foreground">{v} {code}</div>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2 pt-4">
        <Button size="sm" variant="outline" onClick={() => setShowDetails(true)}>{isEn ? 'Details' : 'التفاصيل'}</Button>
        {isOwner && <Button size="sm" variant="outline" onClick={() => { setMode('deposit'); setAmount(''); }}>{isEn ? 'Add cash' : 'إيداع'}</Button>}
        {isOwner && <Button size="sm" onClick={() => { setMode('count'); setCounts({}); opRef.current = newOpId(); }}>{isEn ? 'Count the drawer' : 'عدّ الصندوق'}</Button>}
      </CardContent>

      <Dialog open={mode !== null} onOpenChange={(o) => { if (!o) setMode(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mode === 'count' ? (isEn ? 'Count the general drawer' : 'عدّ الصندوق العام') : (isEn ? 'Add cash to the general drawer' : 'إيداع في الصندوق العام')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {mode === 'count' && (
              <div className="rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground space-y-1">
                <p>{isEn
                  ? 'Count what is physically in the general drawer, each currency in its own units. The app compares it with the expected amount and records any difference as surplus or shortage.'
                  : 'عدّ ما هو موجود فعلاً في الصندوق العام، كل عملة بوحداتها هي (الليرة بالليرة والدولار بالدولار). يقارنه التطبيق بالمتوقع ويسجّل أي فرق كفائض أو عجز.'}</p>
                <p>{isEn ? 'A negative expected amount means more went out in that currency than came in.' : 'المتوقع السالب يعني أن ما خرج بهذه العملة أكثر مما دخل بها.'}</p>
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2"
                  onClick={() => setCounts(Object.fromEntries(countCurrencies.map(c => [c.code, String(Math.max(0, byCurrency[c.code] ?? 0))])))}>
                  {isEn ? 'Fill with the expected amounts' : 'تعبئة بالمبالغ المتوقعة'}
                </Button>
              </div>
            )}
            {mode === 'count' ? countCurrencies.map(c => (
              <div key={c.code} className="space-y-1">
                <Label className="flex justify-between gap-2">
                  <span>{isEn ? 'Counted' : 'المعدود'} {c.code}</span>
                  <span className="text-xs text-muted-foreground">
                    {isEn ? 'Expected' : 'المتوقع'}:{' '}
                    <b dir="ltr" className={(byCurrency[c.code] ?? 0) < 0 ? 'tabular-nums text-destructive' : 'tabular-nums text-foreground'}>{byCurrency[c.code] ?? 0} {c.code}</b>
                  </span>
                </Label>
                <Input type="number" inputMode="decimal" min="0" value={counts[c.code] ?? ''} disabled={c.code !== 'USD' && !c.rate}
                  onChange={e => setCounts(prev => ({ ...prev, [c.code]: e.target.value }))} />
              </div>
            )) : (
              <div className="space-y-1">
                <Label>{isEn ? 'Amount' : 'المبلغ'}</Label>
                <div className="flex gap-2">
                  <Input className="flex-1" type="number" inputMode="decimal" min="0" value={amount} onChange={e => setAmount(e.target.value)} />
                  <select className="h-10 rounded-md border border-input bg-background px-2 text-sm" value={depositCcy} onChange={e => setDepositCcy(e.target.value)}>
                    {countCurrencies.filter(c => c.code === 'USD' || c.rate > 0).map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
                  </select>
                </div>
              </div>
            )}
            {mode === 'count' && (
              <p className="text-xs text-muted-foreground">{isEn ? 'Optional. Leave a currency empty to skip it. Each difference is recorded as surplus or shortage in its currency; the drawer stays open.' : 'اختياري. اترك العملة فارغة لتخطّيها. كل فرق يُسجَّل فائضاً أو عجزاً بعملته، والصندوق يبقى مفتوحاً.'}</p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMode(null)}>{isEn ? 'Cancel' : 'إلغاء'}</Button>
            <Button onClick={submit} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {isEn ? 'Save' : 'حفظ'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ShiftDetailsDialog
        shift={detailsShift}
        isEn={isEn}
        onClose={() => setShowDetails(false)}
      />
    </Card>
  );
}
