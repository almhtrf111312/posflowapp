import { useCallback, useEffect, useState } from 'react';
import { CreditCard, Loader2 } from 'lucide-react';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/lib/sonner-bridge';
import { getActiveShift, addWithdrawalFromShift } from '@/lib/cashbox-store';
import { extractErrorMessage } from '@/lib/sync-queue';
import { formatMoney } from '@/lib/utils';
import { getEnabledCurrencies, toUsd, round8 } from '@/lib/money-engine';
import {
  loadCreditSummary, loadCreditLedger, loadOpenDebts, setCreditLimit, issueStoreCredit, applyCreditToDebt, payoutStoreCredit,
  CreditSummary, CreditLedgerRow, OpenDebt,
} from '@/lib/cloud/customer-credit-cloud';

const LABEL: Record<string, string> = { issue: 'إصدار رصيد', spend: 'تسديد دين من الرصيد', payout: 'صرف نقدي', adjustment: 'تسوية' };

export function CustomerCreditDialog({ customer, isOwner, onOpenChange }: {
  customer: { id: string; name: string } | null; isOwner: boolean; onOpenChange: (o: boolean) => void;
}) {
  const [sum, setSum] = useState<CreditSummary | null>(null);
  const [ledger, setLedger] = useState<CreditLedgerRow[]>([]);
  const [debts, setDebts] = useState<OpenDebt[]>([]);
  const [limitText, setLimitText] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const payCurrencies = getEnabledCurrencies();
  const [payCcy, setPayCcy] = useState(() => payCurrencies[0]?.code || 'USD');

  const refresh = useCallback(async () => {
    if (!customer) return;
    const [s, l, d] = await Promise.all([loadCreditSummary(customer.id), loadCreditLedger(customer.id), loadOpenDebts(customer.id)]);
    setSum(s); setLedger(l); setDebts(d);
    setLimitText(s.creditLimit == null ? '' : String(s.creditLimit));
  }, [customer]);

  useEffect(() => {
    setAmount('');
    setReason('');
    setPayCcy(payCurrencies[0]?.code || 'USD');
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); setAmount(''); await refresh(); }
    catch (e) { toast.error(extractErrorMessage(e) || 'حدث خطأ'); }
    finally { setBusy(false); }
  };

  // توحيد سلوك الإدخال مع نافذة الموردين: المبلغ المُدخل بعملة الاختيار ويُحوَّل إلى USD للتسجيل المحاسبي
  const val = Number(amount);
  const valid = Number.isFinite(val) && val > 0;
  const usdVal = valid ? (payCcy === 'USD' ? round8(val) : round8(toUsd(val, payCcy))) : 0;

  return (
    <Dialog open={!!customer} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px] gap-0"
        onPointerDownOutside={(e) => { if (busy || amount || reason) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (busy || amount || reason) e.preventDefault(); }}
      >
        <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
          <DialogTitle>رصيد وحد ائتمان: {customer?.name}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {customer && sum && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl border border-border/60 p-3">
                  <div className="text-xs text-muted-foreground">رصيد العميل لدينا</div>
                  <div className="font-bold text-success mt-0.5"><span dir="ltr" className="inline-block tabular-nums">{formatMoney(sum.storeCredit)}</span></div>
                </div>
                <div className="rounded-xl border border-border/60 p-3">
                  <div className="text-xs text-muted-foreground">دينه الحالي</div>
                  <div className="font-bold text-destructive mt-0.5"><span dir="ltr" className="inline-block tabular-nums">{formatMoney(sum.totalDebt)}</span></div>
                </div>
              </div>

              {isOwner && (
                <div className="rounded-xl border border-border/60 p-3 space-y-1.5">
                  <div className="text-xs font-semibold">حد الائتمان بالدولار (اتركه فارغاً = بلا حد)</div>
                  <div className="flex gap-2">
                    <Input type="number" inputMode="decimal" dir="ltr" className="tabular-nums" value={limitText} onChange={e => setLimitText(e.target.value)} />
                    <Button disabled={busy} onClick={() => run(() => setCreditLimit(customer.id, limitText.trim() === '' ? null : Number(limitText)), 'تم حفظ حد الائتمان')}>
                      {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                      حفظ
                    </Button>
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-border/60 p-3 space-y-3">
                <div className="space-y-1.5">
                  <Input type="number" inputMode="decimal" dir="ltr" className="tabular-nums" placeholder={`المبلغ (${payCcy})`} value={amount} onChange={e => setAmount(e.target.value)} />
                  {payCurrencies.length > 1 && (
                    <Select value={payCcy} onValueChange={setPayCcy}>
                      <SelectTrigger className="min-h-11 sm:min-h-10 w-full rounded-[14px]" aria-label="العملة">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-h-[min(20rem,60dvh)] overflow-y-auto">
                        {payCurrencies.map(c => (
                          <SelectItem key={c.code} value={c.code}>{c.code}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {valid && payCcy !== 'USD' && (
                    <div className="text-xs text-muted-foreground">المعادل المحاسبي: <span dir="ltr" className="inline-block tabular-nums font-medium">{formatMoney(usdVal)}</span></div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Input placeholder="السبب / رقم الفاتورة (للإصدار)" value={reason} onChange={e => setReason(e.target.value)} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={busy || !valid} onClick={() => run(() => issueStoreCredit(customer.id, usdVal, reason), 'تم إصدار الرصيد')}>
                    {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                    إصدار رصيد
                  </Button>
                  <Button variant="outline" disabled={busy || !valid || sum.storeCredit <= 0 || !getActiveShift()}
                    onClick={() => run(async () => {
                      await payoutStoreCredit(customer.id, usdVal, getActiveShift()!.id, payCcy, val);
                      addWithdrawalFromShift(usdVal, payCcy, val);
                    }, 'تم صرف الرصيد نقداً')}>
                    {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                    صرف نقدي من الصندوق
                  </Button>
                </div>
                {debts.length > 0 && sum.storeCredit > 0 && (
                  <div className="space-y-1.5 pt-1">
                    <div className="text-xs text-muted-foreground">تسديد دين من الرصيد:</div>
                    {debts.map(d => (
                      <Button key={d.id} variant="secondary" className="w-full justify-between" disabled={busy || !valid}
                        onClick={() => run(() => applyCreditToDebt(d.id, Math.min(usdVal, d.remaining_debt)), 'تم تسديد الدين من الرصيد')}>
                        <span>دين <span dir="ltr" className="inline-block tabular-nums">{d.invoice_id || ''}</span></span>
                        <span dir="ltr" className="inline-block tabular-nums font-mono">{formatMoney(d.remaining_debt)}</span>
                      </Button>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                {ledger.length === 0 ? (
                  <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
                    <CreditCard className="w-12 h-12 text-muted-foreground/50 mb-3" />
                    <p className="text-sm sm:text-base font-semibold text-foreground">لا توجد حركات مسجلة</p>
                  </div>
                ) : ledger.map(r => (
                  <div key={r.id} className="flex justify-between items-center gap-2 text-xs rounded-xl border border-border/60 px-3 py-2">
                    <div className="min-w-0">
                      <div className="font-medium">{LABEL[r.entry_type] || r.entry_type}{r.invoice_number ? <> · <span dir="ltr" className="inline-block tabular-nums">{r.invoice_number}</span></> : ''}</div>
                      <div className="text-muted-foreground"><span dir="ltr" className="inline-block tabular-nums">{new Date(r.created_at).toLocaleString('ar')}</span>{r.reason ? ` — ${r.reason}` : ''}</div>
                    </div>
                    <span dir="ltr" className={'inline-block tabular-nums font-mono font-semibold shrink-0 ' + (r.amount > 0 ? 'text-success' : 'text-destructive')}>{r.amount > 0 ? '+' : ''}{formatMoney(r.amount)}</span>
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
