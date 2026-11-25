import { useEffect, useMemo, useState } from 'react';
import { FileX2 } from 'lucide-react';
import { formatReportAmount } from '@/lib/utils';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toLocalDateString } from '@/lib/date-utils';
import { useLanguage } from '@/hooks/language-context';
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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        {[
          { label: tr('المبالغ المشطوبة', 'Written-off amounts'), value: totals.amount, tone: '' },
          { label: tr('خسارة الديون المعدومة', 'Bad-debt loss'), value: totals.loss, tone: 'text-destructive' },
          { label: tr('تحمّلها الشركاء', 'Carried by partners'), value: totals.partners, tone: '' },
          { label: tr('تحمّلها المالك', 'Carried by the owner'), value: totals.owner, tone: '' },
        ].map(card => (
          <div key={card.label} className="rounded-xl border border-border bg-card p-3">
            <p className={`text-lg font-bold ${card.tone}`}><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(card.value)}</span></p>
            <p className="text-xs text-muted-foreground">{card.label}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
            <FileX2 className="w-12 h-12 text-muted-foreground/50 mb-3" />
            <p className="text-sm sm:text-base font-semibold text-foreground">
              {loading
                ? tr('جاري التحميل...', 'Loading...')
                : tr('لا توجد ديون مشطوبة في هذه الفترة', 'No written-off debts in this period')}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-start">{tr('التاريخ', 'Date')}</TableHead>
                  <TableHead className="text-start">{tr('العميل', 'Customer')}</TableHead>
                  <TableHead className="text-start">{tr('الفاتورة', 'Invoice')}</TableHead>
                  <TableHead className="text-end">{tr('المبلغ المشطوب', 'Written off')}</TableHead>
                  <TableHead className="text-end">{tr('ربح معلّق أُلغي', 'Pending profit cancelled')}</TableHead>
                  <TableHead className="text-end">{tr('الخسارة', 'Loss')}</TableHead>
                  <TableHead className="text-start">{tr('على الشركاء', 'On partners')}</TableHead>
                  <TableHead className="text-end">{tr('على المالك', 'On the owner')}</TableHead>
                  <TableHead className="text-start">{tr('السبب', 'Reason')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(r => (
                  <TableRow key={r.id} className="align-top">
                    <TableCell className="whitespace-nowrap"><span dir="ltr" className="inline-block tabular-nums">{toLocalDateString(r.writtenOffAt)}</span></TableCell>
                    <TableCell>{r.customerName || dash}</TableCell>
                    <TableCell className="whitespace-nowrap"><span dir="ltr" className="inline-block tabular-nums">{r.invoiceId || tr('دين نقدي', 'Cash loan')}</span></TableCell>
                    <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(r.amount)}</span></TableCell>
                    <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{money(r.pendingProfitCancelled)}</span></TableCell>
                    <TableCell className="text-end text-destructive font-medium"><span dir="ltr" className="inline-block tabular-nums">{money(r.lossAmount)}</span></TableCell>
                    <TableCell>
                      {r.partners.length === 0 ? dash : r.partners.map((p, i) => (
                        <div key={`${r.id}-${i}`} className="whitespace-nowrap">
                          {p.partnerName}: <span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(p.amount)}</span>
                          {p.category ? <span className="text-muted-foreground"> ({p.category})</span> : null}
                        </div>
                      ))}
                    </TableCell>
                    <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{money(r.ownerLoss)}</span></TableCell>
                    <TableCell className="text-muted-foreground">{r.reason || dash}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow className="font-bold">
                  <TableCell colSpan={3}>{tr('الإجمالي', 'Total')}</TableCell>
                  <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(totals.amount)}</span></TableCell>
                  <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(totals.cancelled)}</span></TableCell>
                  <TableCell className="text-end text-destructive"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(totals.loss)}</span></TableCell>
                  <TableCell><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(totals.partners)}</span></TableCell>
                  <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(totals.owner)}</span></TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
