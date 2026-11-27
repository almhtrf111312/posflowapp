// Shift details: totals per movement kind (sales, debt payments, expenses, purchases/suppliers, deposits, withdrawals,
// refunds, differences) and the full movement list. Read-only; figures come from the shift's cloud movements (F-18).
import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { formatMoney, formatDateTime } from '@/lib/utils';
import { loadShiftMovements, ShiftMovementRow } from '@/lib/cloud/cashbox-cloud';
import { INFLOW_TYPES } from '@/lib/shift-adopt';
import { round8 } from '@/lib/money-engine';

export interface ShiftSummaryInput {
  id: string;
  userName: string;
  openedAt: string;
  closedAt?: string;
  openingCash: number;
  expectedCash?: number;
  closingCash?: number;
  discrepancy?: number;
  status: 'open' | 'closed';
}

const LABELS: Record<string, [string, string]> = {
  sale: ['مبيعات نقدية', 'Cash sales'],
  debt_payment: ['تسديد ديون', 'Debt payments'],
  expense: ['مصاريف', 'Expenses'],
  expense_refund: ['استرجاع مصاريف', 'Expense refunds'],
  supplier_payment: ['دفعات موردين ومشتريات', 'Supplier payments / purchases'],
  supplier_refund: ['استرداد من موردين', 'Supplier refunds'],
  refund: ['مرتجعات للزبائن', 'Customer refunds'],
  deposit: ['إيداع', 'Deposits'],
  deposit_capital: ['إيداع رأس مال', 'Capital deposits'],
  deposit_revenue: ['إيداع إيراد', 'Revenue deposits'],
  deposit_purchase_cover: ['إيداع لتغطية شراء', 'Purchase cover deposits'],
  withdrawal: ['سحب', 'Withdrawals'],
  store_credit_refund: ['صرف رصيد متجر', 'Store credit payouts'],
  surplus: ['فائض', 'Surplus'],
  shortage: ['عجز', 'Shortage'],
  fx_in: ['صرف عملة (داخل)', 'FX in'],
  fx_out: ['صرف عملة (خارج)', 'FX out'],
  transfer_in: ['تحويل داخل', 'Transfer in'],
  transfer_out: ['تحويل خارج', 'Transfer out'],
};

export function ShiftDetailsDialog({ shift, isEn, onClose }: { shift: ShiftSummaryInput | null; isEn: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<ShiftMovementRow[] | null>(null);

  useEffect(() => {
    if (!shift) return;
    let alive = true;
    setRows(null);
    void loadShiftMovements(shift.id).then(r => { if (alive) setRows(r); });
    return () => { alive = false; };
  }, [shift]);

  const groups = useMemo(() => {
    const m = new Map<string, { total: number; count: number }>();
    (rows || []).forEach(r => {
      const g = m.get(r.type) || { total: 0, count: 0 };
      g.total = round8(g.total + r.amount); g.count += 1;
      m.set(r.type, g);
    });
    return Array.from(m.entries()).sort((a, b) => b[1].total - a[1].total);
  }, [rows]);

  const label = (type: string) => (LABELS[type] ? LABELS[type][isEn ? 1 : 0] : type);

  return (
    <Dialog open={!!shift} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-[min(calc(100vw-1.5rem),34rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]">
        <DialogHeader className="shrink-0 px-4 pt-4 pb-3 border-b border-border/60 text-start pe-12">
          <DialogTitle>{isEn ? 'Shift details' : 'تفاصيل الوردية'} — {shift?.userName}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4 overflow-y-auto">
          {shift && (
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-muted-foreground">{isEn ? 'Opened' : 'الفتح'}</div><div dir="ltr" className="text-end tabular-nums">{formatDateTime(shift.openedAt)}</div>
              <div className="text-muted-foreground">{isEn ? 'Closed' : 'الإغلاق'}</div><div dir="ltr" className="text-end tabular-nums">{shift.closedAt ? formatDateTime(shift.closedAt) : '-'}</div>
              <div className="text-muted-foreground">{isEn ? 'Opening' : 'الافتتاح'}</div><div dir="ltr" className="text-end tabular-nums">{formatMoney(shift.openingCash, 'USD')}</div>
            </div>
          )}
          {rows === null ? (
            <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{isEn ? 'No drawer movements (or no connection).' : 'لا توجد حركات صندوق (أو لا يوجد اتصال).'}</p>
          ) : (
            <>
              <div className="space-y-1.5">
                {groups.map(([type, g]) => (
                  <div key={type} className="flex items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-sm">
                    <span>{label(type)} <span className="text-xs text-muted-foreground">({g.count})</span></span>
                    <span dir="ltr" className={INFLOW_TYPES.includes(type) ? 'tabular-nums font-bold text-success' : 'tabular-nums font-bold text-destructive'}>
                      {INFLOW_TYPES.includes(type) ? '+' : '−'}{formatMoney(g.total, 'USD')}
                    </span>
                  </div>
                ))}
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground">{isEn ? 'All movements' : 'كل الحركات'}</p>
                {rows.map(r => (
                  <div key={r.id} className="flex items-start justify-between gap-2 border-b border-border/50 py-1.5 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium">{label(r.type)}{r.reference_id ? <span className="text-muted-foreground" dir="ltr"> · {r.reference_id}</span> : null}</div>
                      {r.notes && <div className="text-muted-foreground truncate">{r.notes}</div>}
                      <div className="text-muted-foreground" dir="ltr">{formatDateTime(r.created_at)}</div>
                    </div>
                    <div className="text-end shrink-0" dir="ltr">
                      <div className="tabular-nums font-bold">{INFLOW_TYPES.includes(r.type) ? '+' : '−'}{formatMoney(r.amount, 'USD')}</div>
                      {r.currency && r.currency !== 'USD' && r.currency_amount != null && (
                        <div className="tabular-nums text-muted-foreground">{r.currency_amount} {r.currency}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
