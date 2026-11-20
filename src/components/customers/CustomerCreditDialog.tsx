import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/sonner-bridge';
import { getActiveShift, addWithdrawalFromShift } from '@/lib/cashbox-store';
import { extractErrorMessage } from '@/lib/sync-queue';
import { formatMoney } from '@/lib/utils';
import { getEnabledCurrencies, fromUsd, round8 } from '@/lib/money-engine';
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
  const [payCcy, setPayCcy] = useState('USD');
  const payCurrencies = getEnabledCurrencies();

  const refresh = useCallback(async () => {
    if (!customer) return;
    const [s, l, d] = await Promise.all([loadCreditSummary(customer.id), loadCreditLedger(customer.id), loadOpenDebts(customer.id)]);
    setSum(s); setLedger(l); setDebts(d);
    setLimitText(s.creditLimit == null ? '' : String(s.creditLimit));
  }, [customer]);

  useEffect(() => { setAmount(''); setReason(''); void refresh(); }, [refresh]);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); setAmount(''); await refresh(); }
    catch (e) { toast.error(extractErrorMessage(e) || 'حدث خطأ'); }
    finally { setBusy(false); }
  };
  const val = Number(amount);
  const valid = val > 0;

  return (
    <Dialog open={!!customer} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader><DialogTitle>رصيد وحد ائتمان: {customer?.name}</DialogTitle></DialogHeader>
        {customer && sum && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-xl border p-3"><div className="text-xs text-muted-foreground">رصيد العميل لدينا</div><div className="font-mono font-bold text-emerald-600">{formatMoney(sum.storeCredit)}</div></div>
              <div className="rounded-xl border p-3"><div className="text-xs text-muted-foreground">دينه الحالي</div><div className="font-mono font-bold text-red-600">{formatMoney(sum.totalDebt)}</div></div>
            </div>

            {isOwner && (
              <div className="rounded-xl border p-3 space-y-2">
                <div className="text-xs font-semibold">حد الائتمان (اتركه فارغاً = بلا حد)</div>
                <div className="flex gap-2">
                  <Input type="number" inputMode="decimal" value={limitText} onChange={e => setLimitText(e.target.value)} />
                  <Button disabled={busy} onClick={() => run(() => setCreditLimit(customer.id, limitText.trim() === '' ? null : Number(limitText)), 'تم حفظ حد الائتمان')}>حفظ</Button>
                </div>
              </div>
            )}

            <div className="rounded-xl border p-3 space-y-2">
              <Input type="number" inputMode="decimal" placeholder="المبلغ" value={amount} onChange={e => setAmount(e.target.value)} />
              <Input placeholder="السبب / رقم الفاتورة (للإصدار)" value={reason} onChange={e => setReason(e.target.value)} />
              {payCurrencies.length > 1 && (
                <select className="w-full h-9 rounded-md border bg-background px-2 text-sm" value={payCcy} onChange={e => setPayCcy(e.target.value)} title="عملة الصرف النقدي">
                  {payCurrencies.map(c => <option key={c.code} value={c.code}>صرف بعملة {c.code}</option>)}
                </select>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy || !valid} onClick={() => run(() => issueStoreCredit(customer.id, val, reason), 'تم إصدار الرصيد')}>إصدار رصيد</Button>
                <Button size="sm" variant="outline" disabled={busy || !valid || sum.storeCredit <= 0 || !getActiveShift()}
                  onClick={() => run(async () => { await payoutStoreCredit(customer.id, val, getActiveShift()!.id, payCcy, payCcy === 'USD' ? val : round8(fromUsd(val, payCcy))); addWithdrawalFromShift(val, payCcy, payCcy === 'USD' ? val : round8(fromUsd(val, payCcy))); }, 'تم صرف الرصيد نقداً')}>
                  صرف نقدي من الصندوق
                </Button>
              </div>
              {debts.length > 0 && sum.storeCredit > 0 && (
                <div className="space-y-1 pt-1">
                  <div className="text-xs text-muted-foreground">تسديد دين من الرصيد:</div>
                  {debts.map(d => (
                    <Button key={d.id} size="sm" variant="secondary" className="w-full justify-between" disabled={busy || !valid}
                      onClick={() => run(() => applyCreditToDebt(d.id, Math.min(val, d.remaining_debt)), 'تم تسديد الدين من الرصيد')}>
                      <span>دين {d.invoice_id || ''}</span><span className="font-mono">{formatMoney(d.remaining_debt)}</span>
                    </Button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1">
              {ledger.map(r => (
                <div key={r.id} className="flex justify-between text-xs rounded-lg border px-3 py-2">
                  <div><div className="font-medium">{LABEL[r.entry_type] || r.entry_type}{r.invoice_number ? ` · ${r.invoice_number}` : ''}</div>
                    <div className="text-muted-foreground">{new Date(r.created_at).toLocaleString('ar')}{r.reason ? ` — ${r.reason}` : ''}</div></div>
                  <span className={'font-mono ' + (r.amount > 0 ? 'text-emerald-600' : 'text-red-600')}>{r.amount > 0 ? '+' : ''}{formatMoney(r.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
