import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Loader2, ArrowRight } from 'lucide-react';
import { toast } from '@/lib/sonner-bridge';
import { getActiveShift, addWithdrawalFromShift, addDepositToShift } from '@/lib/cashbox-store';
import { extractErrorMessage } from '@/lib/sync-queue';
import { formatMoney } from '@/lib/utils';
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
      const args = { supplierId: selected.id, amount: val, note, source, shiftId: shift?.id };
      if (mode === 'pay') await paySupplierCloud(args); else await refundFromSupplierCloud(args);
      if (source === 'drawer') { if (mode === 'pay') addWithdrawalFromShift(val, 'USD'); else addDepositToShift(val, 'USD'); }
      toast.success(mode === 'pay' ? 'تم تسجيل الدفعة' : 'تم تسجيل الاسترداد');
      setMode(null);
      await refresh(selected.id);
    } catch (e) {
      toast.error(extractErrorMessage(e) || 'حدث خطأ');
    } finally { setBusy(false); }
  };

  const due = selected?.balance_due ?? 0;
  const shift = getActiveShift();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>{selected ? selected.name : 'الموردون'}</DialogTitle>
        </DialogHeader>

        {loading && <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 animate-spin" /></div>}

        {!selected && !loading && (
          <div className="space-y-2">
            {suppliers.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">لا يوجد موردون بعد — يُنشأ المورد من نافذة فاتورة الشراء.</p>}
            {suppliers.map(s => (
              <button key={s.id} type="button" onClick={() => pick(s)}
                className="w-full flex items-center justify-between rounded-xl border p-3 text-start hover:bg-muted/40">
                <span className="font-medium">{s.name}{s.company ? ` (${s.company})` : ''}</span>
                <span className={s.balance_due > 0 ? 'text-red-600 font-mono' : s.balance_due < 0 ? 'text-emerald-600 font-mono' : 'text-muted-foreground font-mono'}>
                  {s.balance_due > 0 ? `علينا ${formatMoney(s.balance_due)}` : s.balance_due < 0 ? `لنا ${formatMoney(-s.balance_due)}` : 'مسدّد'}
                </span>
              </button>
            ))}
          </div>
        )}

        {selected && (
          <div className="space-y-3">
            <Button variant="ghost" size="sm" onClick={() => { setSelected(null); setMode(null); }}>
              <ArrowRight className="w-4 h-4 ms-1" /> كل الموردين
            </Button>
            <div className="rounded-xl border p-3 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{due >= 0 ? 'المستحق للمورد' : 'رصيد دائن لنا عند المورد'}</span>
              <span className="font-mono font-bold">{formatMoney(Math.abs(due))}</span>
            </div>

            {!mode && (
              <div className="flex gap-2">
                <Button className="flex-1" disabled={due <= 0} onClick={() => startMode('pay')}>دفع للمورد</Button>
                <Button className="flex-1" variant="outline" disabled={due >= 0} onClick={() => startMode('refund')}>استرداد من المورد</Button>
              </div>
            )}

            {mode && (
              <div className="rounded-xl border p-3 space-y-3">
                <Label>{mode === 'pay' ? 'مبلغ الدفعة' : 'المبلغ المسترد'}</Label>
                <Input type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
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
                <div className="flex gap-2">
                  <Button className="flex-1" disabled={busy} onClick={submit}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'تأكيد'}</Button>
                  <Button variant="outline" onClick={() => setMode(null)}>إلغاء</Button>
                </div>
              </div>
            )}

            <div className="space-y-1">
              {ledger.map(r => (
                <div key={r.id} className="flex items-center justify-between text-xs rounded-lg border px-3 py-2">
                  <div>
                    <div className="font-medium">{TYPE_LABEL[r.entry_type] || r.entry_type}
                      {r.payment_source ? ` · ${r.payment_source === 'drawer' ? 'من الصندوق' : 'خارجي'}` : ''}</div>
                    <div className="text-muted-foreground">{new Date(r.created_at).toLocaleString('ar')}{r.note ? ` — ${r.note}` : ''}</div>
                  </div>
                  <span className={'font-mono ' + (r.amount > 0 ? 'text-red-600' : 'text-emerald-600')}>{r.amount > 0 ? '+' : ''}{formatMoney(r.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
