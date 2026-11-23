import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, ArrowLeft, Truck } from 'lucide-react';
import { toast } from '@/lib/sonner-bridge';
import { getActiveShift, addWithdrawalFromShift, addDepositToShift } from '@/lib/cashbox-store';
import { extractErrorMessage } from '@/lib/sync-queue';
import { formatMoney } from '@/lib/utils';
import { getEnabledCurrencies, toUsd, round8 } from '@/lib/money-engine';
import {
  loadSuppliersCloud, loadSupplierLedgerCloud, paySupplierCloud, refundFromSupplierCloud,
  SupplierBalance, SupplierLedgerRow, SupplierMoneySource,
} from '@/lib/cloud/suppliers-cloud';

const TYPE_LABEL: Record<string, string> = {
  purchase: 'فاتورة شراء', payment: 'دفعة للمورد', purchase_return: 'مرتجع مشتريات', adjustment: 'تسوية', refund: 'استرداد من المورد',
};

export function SuppliersDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [suppliers, setSuppliers] = useState<SupplierBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<SupplierBalance | null>(null);
  const [ledger, setLedger] = useState<SupplierLedgerRow[]>([]);
  const [mode, setMode] = useState<'pay' | 'refund' | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [source, setSource] = useState<SupplierMoneySource>('external');
  const [busy, setBusy] = useState(false);
  const [ccy, setCcy] = useState('USD');
  const currencies = getEnabledCurrencies();

  const refresh = useCallback(async (keepId?: string) => {
    setLoading(true);
    const list = await loadSuppliersCloud();
    setSuppliers(list);
    const cur = list.find(s => s.id === (keepId ?? selected?.id)) || null;
    setSelected(cur);
    setLedger(cur ? await loadSupplierLedgerCloud(cur.id) : []);
    setLoading(false);
  }, [selected?.id]);

  useEffect(() => { if (open) { setMode(null); void refresh(); } /* eslint-disable-next-line */ }, [open]);

  const pick = async (s: SupplierBalance) => {
    setSelected(s); setMode(null);
    setLedger(await loadSupplierLedgerCloud(s.id));
  };

  const startMode = (m: 'pay' | 'refund') => {
    setMode(m); setAmount(''); setNote('');
    setSource(getActiveShift() ? 'drawer' : 'external');
  };

  const submit = async () => {
    if (!selected || !mode) return;
    const val = Number(amount);
    if (!(val > 0)) { toast.error('أدخل مبلغاً صحيحاً'); return; }
    const shift = getActiveShift();
    if (source === 'drawer' && !shift) { toast.error('لا توجد وردية مفتوحة'); return; }
    setBusy(true);
    try {
      const usd = ccy === 'USD' ? val : round8(toUsd(val, ccy));
      const args = { supplierId: selected.id, amount: usd, note, source, shiftId: shift?.id, currency: ccy, currencyAmount: val, rate: usd > 0 ? round8(val / usd) : undefined };
      if (mode === 'pay') await paySupplierCloud(args); else await refundFromSupplierCloud(args);
      if (source === 'drawer') { if (mode === 'pay') addWithdrawalFromShift(usd, ccy, val); else addDepositToShift(usd, ccy, val); }
      toast.success(mode === 'pay' ? 'تم تسجيل الدفعة' : 'تم تسجيل الاسترداد');
      setMode(null);
      await refresh(selected.id);
    } catch (e) {
      toast.error(extractErrorMessage(e) || 'حدث خطأ');
    } finally { setBusy(false); }
  };

  const due = selected?.balance_due ?? 0;
  const shift = getActiveShift();

  const isDirty = busy || (mode !== null && Boolean(amount.trim() || note.trim()));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]"
        onPointerDownOutside={(e) => { if (isDirty) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (isDirty) e.preventDefault(); }}
      >
        <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
          <DialogTitle>{selected ? selected.name : 'الموردون'}</DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {loading && <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>}

          {!selected && !loading && (
            <div className="space-y-2">
              {suppliers.length === 0 && (
                <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
                  <Truck className="w-12 h-12 text-muted-foreground/50 mb-3" />
                  <p className="text-xs sm:text-sm text-muted-foreground">لا يوجد موردون بعد — يُنشأ المورد من نافذة فاتورة الشراء.</p>
                </div>
              )}
              {suppliers.map(s => (
                <button key={s.id} type="button" onClick={() => pick(s)}
                  className="w-full flex items-center justify-between gap-2 rounded-xl border border-border p-3 text-start hover:bg-muted/40 transition-colors">
                  <span className="font-medium">{s.name}{s.company ? ` (${s.company})` : ''}</span>
                  <span className={s.balance_due > 0 ? 'text-destructive font-mono' : s.balance_due < 0 ? 'text-success font-mono' : 'text-muted-foreground font-mono'}>
                    {s.balance_due > 0 ? <>علينا <span dir="ltr" className="inline-block tabular-nums">{formatMoney(s.balance_due)}</span></> : s.balance_due < 0 ? <>لنا <span dir="ltr" className="inline-block tabular-nums">{formatMoney(-s.balance_due)}</span></> : 'مسدّد'}
                  </span>
                </button>
              ))}
            </div>
          )}

          {selected && (
            <div className="space-y-3">
              <Button variant="ghost" size="sm" onClick={() => { setSelected(null); setMode(null); }}>
                <ArrowLeft className="w-4 h-4 rtl:rotate-180" /> كل الموردين
              </Button>
              <div className="rounded-xl border border-border p-3 flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{due >= 0 ? 'المستحق للمورد' : 'رصيد دائن لنا عند المورد'}</span>
                <span dir="ltr" className="inline-block font-mono font-bold tabular-nums">{formatMoney(Math.abs(due))}</span>
              </div>

              {!mode && (
                <div className="flex gap-2">
                  <Button className="flex-1" disabled={due <= 0} onClick={() => startMode('pay')}>دفع للمورد</Button>
                  <Button className="flex-1" variant="outline" disabled={due >= 0} onClick={() => startMode('refund')}>استرداد من المورد</Button>
                </div>
              )}

              {mode && (
                <div className="rounded-xl border border-border p-3 space-y-3">
                  <div className="space-y-1.5">
                    <Label>{mode === 'pay' ? 'مبلغ الدفعة' : 'المبلغ المسترد'}</Label>
                    <Input dir="ltr" className="tabular-nums" type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
                  </div>
                  {currencies.length > 1 && (
                    <Select value={ccy} onValueChange={setCcy}>
                      <SelectTrigger className="min-h-11 sm:min-h-10 w-full rounded-[14px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-h-[min(20rem,60dvh)] overflow-y-auto">
                        {currencies.map(c => <SelectItem key={c.code} value={c.code}>{c.code}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                  <Input placeholder="ملاحظة (اختياري)" value={note} onChange={e => setNote(e.target.value)} />
                  <RadioGroup value={source} onValueChange={v => setSource(v as SupplierMoneySource)} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="drawer" id="sup-src-drawer" disabled={!shift} />
                      <Label htmlFor="sup-src-drawer" className="text-sm">
                        {mode === 'pay' ? 'من الصندوق (الغلة)' : 'يدخل الصندوق'}{!shift ? ' — لا توجد وردية مفتوحة' : ''}
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="external" id="sup-src-ext" />
                      <Label htmlFor="sup-src-ext" className="text-sm">
                        {mode === 'pay' ? 'من مصدر خارجي (لا يمسّ الصندوق)' : 'يُستلم خارج الصندوق'}
                      </Label>
                    </div>
                  </RadioGroup>
                  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button variant="outline" size="default" disabled={busy} onClick={() => setMode(null)}>إلغاء</Button>
                    <Button variant="default" size="default" disabled={busy} onClick={submit}>
                      {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                      تأكيد
                    </Button>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                {ledger.map(r => (
                  <div key={r.id} className="flex items-center justify-between text-xs rounded-lg border border-border px-3 py-2">
                    <div>
                      <div className="font-medium">{TYPE_LABEL[r.entry_type] || r.entry_type}
                        {r.payment_source ? ` · ${r.payment_source === 'drawer' ? 'من الصندوق' : 'خارجي'}` : ''}</div>
                      <div className="text-muted-foreground">{new Date(r.created_at).toLocaleString('ar')}{r.note ? ` — ${r.note}` : ''}</div>
                    </div>
                    <span dir="ltr" className={'inline-block font-mono tabular-nums ' + (r.amount > 0 ? 'text-destructive' : 'text-success')}>{r.amount > 0 ? '+' : ''}{formatMoney(r.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </DialogBody>

        <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
          <Button variant="outline" size="default" onClick={() => onOpenChange(false)}>إغلاق</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
