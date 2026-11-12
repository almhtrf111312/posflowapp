import { useEffect, useMemo, useState } from 'react';
import { FileX2 } from 'lucide-react';
import { formatReportAmount } from '@/lib/utils';
import { toLocalDateString } from '@/lib/date-utils';
import { useLanguage } from '@/hooks/use-language';
import {
  loadDebtWriteoffsCloud,
  loadDebtWriteoffsLocally,
  type DebtWriteoffRecord,
} from '@/lib/cloud/accounting-admin-cloud';

interface Props {
  dateRange: { from: string; to: string };
}

/**
 * The debt write-off log: one row per written-off debt with the amount, the
 * pending profit that was cancelled, the loss, and who carried it.
 */
export function DebtWriteoffsReport({ dateRange }: Props) {
  const { isRTL } = useLanguage();
  const tr = (ar: string, en: string) => (isRTL ? ar : en);
  const [records, setRecords] = useState<DebtWriteoffRecord[]>(() => loadDebtWriteoffsLocally());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    loadDebtWriteoffsCloud()
      .then(rows => { if (alive) setRecords(rows); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const rows = useMemo(() => records.filter(r => {
    const day = toLocalDateString(r.writtenOffAt);
    if (dateRange.from && day < dateRange.from) return false;
    if (dateRange.to && day > dateRange.to) return false;
    return true;
  }), [records, dateRange.from, dateRange.to]);

  const totals = useMemo(() => rows.reduce((t, r) => ({
    amount: t.amount + r.amount,
    cancelled: t.cancelled + (r.pendingProfitCancelled ?? 0),
    loss: t.loss + (r.lossAmount ?? r.amount),
    partners: t.partners + r.partners.reduce((s, p) => s + p.amount, 0),
    owner: t.owner + (r.ownerLoss ?? 0),
  }), { amount: 0, cancelled: 0, loss: 0, partners: 0, owner: 0 }), [rows]);

  const dash = '—';
  const money = (value: number | null) => (value === null ? dash : formatReportAmount(value));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {[
          { label: tr('المبالغ المشطوبة', 'Written-off amounts'), value: totals.amount, tone: '' },
          { label: tr('خسارة الديون المعدومة', 'Bad-debt loss'), value: totals.loss, tone: 'text-destructive' },
          { label: tr('تحمّلها الشركاء', 'Carried by partners'), value: totals.partners, tone: '' },
          { label: tr('تحمّلها المالك', 'Carried by the owner'), value: totals.owner, tone: '' },
        ].map(card => (
          <div key={card.label} className="rounded-xl border border-border bg-card p-3">
            <p className={`text-lg font-bold ${card.tone}`}>{formatReportAmount(card.value)}</p>
            <p className="text-xs text-muted-foreground">{card.label}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            <FileX2 className="w-8 h-8 mx-auto mb-2 opacity-50" />
            {loading
              ? tr('جاري التحميل...', 'Loading...')
              : tr('لا توجد ديون مشطوبة في هذه الفترة', 'No written-off debts in this period')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start font-semibold">{tr('التاريخ', 'Date')}</th>
                  <th className="p-2 text-start font-semibold">{tr('العميل', 'Customer')}</th>
                  <th className="p-2 text-start font-semibold">{tr('الفاتورة', 'Invoice')}</th>
                  <th className="p-2 text-center font-semibold">{tr('المبلغ المشطوب', 'Written off')}</th>
                  <th className="p-2 text-center font-semibold">{tr('ربح معلّق أُلغي', 'Pending profit cancelled')}</th>
                  <th className="p-2 text-center font-semibold">{tr('الخسارة', 'Loss')}</th>
                  <th className="p-2 text-start font-semibold">{tr('على الشركاء', 'On partners')}</th>
                  <th className="p-2 text-center font-semibold">{tr('على المالك', 'On the owner')}</th>
                  <th className="p-2 text-start font-semibold">{tr('السبب', 'Reason')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="p-2 whitespace-nowrap">{toLocalDateString(r.writtenOffAt)}</td>
                    <td className="p-2">{r.customerName || dash}</td>
                    <td className="p-2 whitespace-nowrap">{r.invoiceId || tr('دين نقدي', 'Cash loan')}</td>
                    <td className="p-2 text-center">{formatReportAmount(r.amount)}</td>
                    <td className="p-2 text-center">{money(r.pendingProfitCancelled)}</td>
                    <td className="p-2 text-center text-destructive font-medium">{money(r.lossAmount)}</td>
                    <td className="p-2">
                      {r.partners.length === 0 ? dash : r.partners.map((p, i) => (
                        <div key={`${r.id}-${i}`} className="whitespace-nowrap">
                          {p.partnerName}: {formatReportAmount(p.amount)}
                          {p.category ? <span className="text-muted-foreground"> ({p.category})</span> : null}
                        </div>
                      ))}
                    </td>
                    <td className="p-2 text-center">{money(r.ownerLoss)}</td>
                    <td className="p-2 text-muted-foreground">{r.reason || dash}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-muted/30 font-bold">
                <tr className="border-t border-border">
                  <td className="p-2" colSpan={3}>{tr('الإجمالي', 'Total')}</td>
                  <td className="p-2 text-center">{formatReportAmount(totals.amount)}</td>
                  <td className="p-2 text-center">{formatReportAmount(totals.cancelled)}</td>
                  <td className="p-2 text-center text-destructive">{formatReportAmount(totals.loss)}</td>
                  <td className="p-2">{formatReportAmount(totals.partners)}</td>
                  <td className="p-2 text-center">{formatReportAmount(totals.owner)}</td>
                  <td className="p-2" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
