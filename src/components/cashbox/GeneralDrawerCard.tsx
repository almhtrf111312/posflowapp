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
import { Switch } from '@/components/ui/switch';
import { Loader2, Landmark } from 'lucide-react';
import { toast } from '@/lib/sonner-bridge';
import { formatMoney } from '@/lib/utils';
import { round8 } from '@/lib/money-engine';
import { addActivityLog } from '@/lib/activity-log';
import {
  ensureGeneralDrawerCloud, countGeneralDrawerCloud, loadShiftExpectedFromMovements, addShiftTransactionCloud,
} from '@/lib/cloud/cashbox-cloud';
import { ShiftDetailsDialog } from './ShiftDetailsDialog';

const newOpId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function GeneralDrawerCard({ isOwner, userId, userName, isEn }: { isOwner: boolean; userId: string; userName: string; isEn: boolean }) {
  const [id, setId] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [mode, setMode] = useState<'count' | 'deposit' | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const opRef = useRef(newOpId());
  // Owner settings (store sync settings): who must open a shift before cash operations.
  const readRequire = () => {
    try {
      const sync = (JSON.parse(localStorage.getItem('posflow_settings_v1') || '{}')?.syncSettings || {}) as Record<string, unknown>;
      return { cashier: sync.requireShiftCashier !== false, owner: sync.requireShiftOwner === true };
    } catch { return { cashier: true, owner: false }; }
  };
  const [requireShift, setRequireShift] = useState(readRequire);
  const saveRequire = async (key: 'cashier' | 'owner', value: boolean) => {
    const next = { ...requireShift, [key]: value };
    setRequireShift(next);
    const { saveUnifiedStoreSettings, loadUnifiedStoreSettings } = await import('@/lib/store-settings-sync');
    const current = loadUnifiedStoreSettings().syncSettings || {};
    const res = await saveUnifiedStoreSettings({ syncSettings: { ...current, requireShiftCashier: next.cashier, requireShiftOwner: next.owner } });
    if (res && res.success === false) toast.error(res.message || (isEn ? 'Not saved' : 'لم يُحفظ'));
    else toast.success(isEn ? 'Saved' : 'تم الحفظ');
  };
  // Stable object: the details dialog reloads when its shift prop changes.
  const detailsShift = useMemo(() => (showDetails && id
    ? { id, userName: isEn ? 'General drawer' : 'الصندوق العام', openedAt: new Date().toISOString(), openingCash: 0, status: 'open' as const }
    : null), [showDetails, id, isEn]);

  const reload = useCallback(async () => {
    const gid = await ensureGeneralDrawerCloud();
    setId(gid);
    setBalance(gid ? await loadShiftExpectedFromMovements(gid, 0) : null);
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const submit = async () => {
    const v = parseFloat(amount);
    if (!id || !Number.isFinite(v) || v < 0 || (mode === 'deposit' && v <= 0)) {
      toast.error(isEn ? 'Enter a valid amount' : 'أدخل مبلغاً صحيحاً');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'count') {
        const r = await countGeneralDrawerCloud(round8(v), isEn ? `Counted by ${userName}` : `عدّه ${userName}`, opRef.current);
        addActivityLog('shift_closed', userId, userName, `${isEn ? 'General drawer count' : 'عدّ الصندوق العام'}: ${formatMoney(v, 'USD')} (${r.difference >= 0 ? '+' : ''}${formatMoney(r.difference, 'USD')})`);
        toast.success(r.difference === 0
          ? (isEn ? 'Matched' : 'الصندوق مطابق')
          : `${r.difference > 0 ? (isEn ? 'Surplus' : 'فائض') : (isEn ? 'Shortage' : 'عجز')} ${formatMoney(Math.abs(r.difference), 'USD')}`);
      } else {
        const ok = await addShiftTransactionCloud({ shiftId: id, type: 'deposit_capital', amount: round8(v), notes: isEn ? 'Cash added to the general drawer' : 'إيداع في الصندوق العام' });
        if (!ok) throw new Error(isEn ? 'Could not record the deposit' : 'تعذّر تسجيل الإيداع');
        addActivityLog('shift_opened', userId, userName, `${isEn ? 'General drawer deposit' : 'إيداع في الصندوق العام'}: ${formatMoney(v, 'USD')}`);
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
        </div>
      </CardHeader>
      {isOwner && (
        <CardContent className="space-y-2 pb-0">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>{isEn ? 'Cashiers must open a shift' : 'إلزام الكاشير بفتح وردية'}</span>
            <Switch checked={requireShift.cashier} onCheckedChange={(v) => void saveRequire('cashier', v)} />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>{isEn ? 'The owner must open a shift' : 'إلزام المالك بفتح وردية'}</span>
            <Switch checked={requireShift.owner} onCheckedChange={(v) => void saveRequire('owner', v)} />
          </label>
          <p className="text-xs text-muted-foreground">{isEn ? 'Without a required shift, cash operations go to the general drawer.' : 'بدون إلزام، العمليات النقدية بلا وردية تذهب إلى الصندوق العام.'}</p>
        </CardContent>
      )}
      <CardContent className="flex flex-wrap gap-2 pt-4">
        <Button size="sm" variant="outline" onClick={() => setShowDetails(true)}>{isEn ? 'Details' : 'التفاصيل'}</Button>
        {isOwner && <Button size="sm" variant="outline" onClick={() => { setMode('deposit'); setAmount(''); }}>{isEn ? 'Add cash' : 'إيداع'}</Button>}
        {isOwner && <Button size="sm" onClick={() => { setMode('count'); setAmount(''); opRef.current = newOpId(); }}>{isEn ? 'Count the drawer' : 'عدّ الصندوق'}</Button>}
      </CardContent>

      <Dialog open={mode !== null} onOpenChange={(o) => { if (!o) setMode(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mode === 'count' ? (isEn ? 'Count the general drawer' : 'عدّ الصندوق العام') : (isEn ? 'Add cash to the general drawer' : 'إيداع في الصندوق العام')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {mode === 'count' && balance !== null && (
              <div className="text-sm">{isEn ? 'Expected' : 'المتوقع'}: <b dir="ltr">{formatMoney(balance, 'USD')}</b></div>
            )}
            <div className="space-y-1">
              <Label>{mode === 'count' ? (isEn ? 'Counted cash (USD value)' : 'النقد المعدود (بقيمة الدولار)') : (isEn ? 'Amount (USD)' : 'المبلغ (دولار)')}</Label>
              <Input type="number" inputMode="decimal" min="0" value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
            {mode === 'count' && (
              <p className="text-xs text-muted-foreground">{isEn ? 'Optional. The difference is recorded as surplus or shortage; the drawer stays open.' : 'اختياري. الفرق يُسجَّل فائضاً أو عجزاً، والصندوق يبقى مفتوحاً.'}</p>
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
