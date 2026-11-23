import { useEffect, useMemo, useState } from 'react';
import { Lock, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { formatReportAmount } from '@/lib/utils';
import { toast } from '@/lib/sonner-bridge';
import { toLocalDateString } from '@/lib/date-utils';
import { useLanguage } from '@/hooks/use-language';
import { useActionGuard } from '@/hooks/use-action-guard';
import { computeProfitSummary } from '@/lib/profit-engine';
import type { ProfitLedger } from '@/lib/cloud/profit-ledger-cloud';
import type { Invoice } from '@/lib/cloud/invoices-cloud';
import type { Expense } from '@/lib/cloud/expenses-cloud';
import {
  closeAccountingPeriodCloud,
  loadPeriodClosuresCloud,
  loadPeriodClosuresLocally,
  type PeriodClosure,
} from '@/lib/cloud/accounting-admin-cloud';

interface Props {
  invoices: Invoice[];
  expenses: Expense[];
  profitLedger: ProfitLedger;
  /** Store owner only; the server enforces it as well. */
  canClose: boolean;
}

/** First and last day of the previous month, as local YYYY-MM-DD. */
function previousMonthRange(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  return { from: toLocalDateString(first), to: toLocalDateString(last) };
}

export function PeriodClosingPanel({ invoices, expenses, profitLedger, canClose }: Props) {
  const { isRTL } = useLanguage();
  const tr = (ar: string, en: string) => (isRTL ? ar : en);
  const initial = useMemo(previousMonthRange, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [closures, setClosures] = useState<PeriodClosure[]>(() => loadPeriodClosuresLocally());
  const [showConfirm, setShowConfirm] = useState(false);
  const closeGuard = useActionGuard();

  useEffect(() => {
    let alive = true;
    loadPeriodClosuresCloud().then(rows => { if (alive) setClosures(rows); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const today = toLocalDateString(new Date());
  const rangeError = !from || !to
    ? tr('اختر بداية الفترة ونهايتها', 'Choose the period start and end')
    : from > to
      ? tr('بداية الفترة بعد نهايتها', 'The period starts after it ends')
      : to > today
        ? tr('لا يمكن إقفال فترة لم تنتهِ بعد', 'A period that has not ended cannot be closed')
        : closures.some(c => c.periodStart <= to && c.periodEnd >= from)
          ? tr('هذه الفترة تتداخل مع فترة مقفلة سابقاً', 'This period overlaps a closed period')
          : '';

  // Preview from the device data, with the same definition the server uses when it closes.
  const preview = useMemo(() => computeProfitSummary({
    invoices,
    payments: profitLedger.payments,
    writeoffs: profitLedger.writeoffs,
    expenses: expenses.map(exp => ({ amount: Number(exp.amount) || 0, date: String(exp.date) })),
    range: from && to && from <= to ? { from, to } : undefined,
    dayOf: toLocalDateString,
  }), [invoices, expenses, profitLedger, from, to]);

  const rows: { label: string; value: number; tone?: string; strong?: boolean }[] = [
    { label: tr('المبيعات (بدون الضريبة)', 'Sales (excluding tax)'), value: preview.sales },
    { label: tr('الربح المحقق', 'Realized profit'), value: preview.realizedProfit, tone: 'text-success' },
    { label: tr('المصاريف', 'Expenses'), value: preview.expenses, tone: 'text-destructive' },
    { label: tr('خسارة الديون المعدومة', 'Bad-debt loss'), value: preview.badDebtLoss, tone: 'text-destructive' },
    { label: tr('صافي الربح', 'Net profit'), value: preview.netProfit, tone: preview.netProfit >= 0 ? 'text-success' : 'text-destructive', strong: true },
    { label: tr('أرباح معلّقة (لا تدخل في الصافي)', 'Pending profit (not in net)'), value: preview.pendingProfit, tone: 'text-warning' },
  ];

  const runClose = () => closeGuard.run(async () => {
    setShowConfirm(false);
    const toastId = 'close-period';
    toast.loading(tr('جاري إقفال الفترة...', 'Closing the period...'), { id: toastId });
    const result = await closeAccountingPeriodCloud(from, to);
    if (!result.ok) {
      toast.error(result.message, { id: toastId, duration: 9000 });
      return;
    }
    toast.success(tr('تم إقفال الفترة وتثبيت أرقامها', 'The period was closed and its figures are fixed'), { id: toastId });
    setClosures(await loadPeriodClosuresCloud());
  });

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2 font-bold">
          <Lock className="w-4 h-4 text-primary" />
          <span>{tr('إقفال فترة محاسبية', 'Close an accounting period')}</span>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {tr(
            'الإقفال يثبّت أرقام الفترة نهائياً في سجل لا يُعدَّل. بعده لا يمكن استرداد فواتير هذه الفترة ولا حذف مصاريفها ولا تعديل أو إلغاء مشترياتها، ولا يمكن التراجع عن الإقفال.',
            'Closing fixes the period figures in a record that cannot be edited. Afterwards its invoices cannot be refunded, its expenses cannot be deleted and its purchases cannot be edited or cancelled. Closing cannot be undone.',
          )}
        </p>

        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs space-y-1">
            <span className="text-muted-foreground">{tr('من', 'From')}</span>
            <Input type="date" value={from} max={today} onChange={e => setFrom(e.target.value)} />
          </label>
          <label className="text-xs space-y-1">
            <span className="text-muted-foreground">{tr('إلى', 'To')}</span>
            <Input type="date" value={to} max={today} onChange={e => setTo(e.target.value)} />
          </label>
        </div>

        <div className="rounded-xl border border-border divide-y divide-border text-sm">
          {rows.map(row => (
            <div key={row.label} className="flex items-center justify-between px-3 py-2">
              <span className={row.strong ? 'font-bold' : 'text-muted-foreground'}>{row.label}</span>
              <span dir="ltr" className={`inline-block tabular-nums ${row.strong ? 'font-bold' : 'font-medium'} ${row.tone ?? ''}`}>{formatReportAmount(row.value)}</span>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {tr(
            'هذه معاينة من بيانات هذا الجهاز. الأرقام التي تُثبَّت يحسبها الخادم لحظة الإقفال بالتعريف نفسه.',
            'This is a preview from this device. The fixed figures are computed by the server at closing time with the same definition.',
          )}
        </p>

        {rangeError && (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <ShieldAlert className="w-4 h-4 shrink-0" />
            <span>{rangeError}</span>
          </div>
        )}
        {!canClose && (
          <p className="text-xs text-muted-foreground">{tr('إقفال الفترة لمالك المتجر فقط.', 'Only the store owner can close a period.')}</p>
        )}

        <Button
          className="w-full h-10 rounded-xl font-bold"
          disabled={!canClose || !!rangeError || closeGuard.isRunning}
          onClick={() => setShowConfirm(true)}
        >
          {closeGuard.isRunning
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <><Lock className="w-4 h-4 me-2" />{tr('إقفال الفترة', 'Close the period')}</>}
        </Button>
      </div>

      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 font-bold text-sm border-b border-border">{tr('الفترات المقفلة', 'Closed periods')}</div>
        {closures.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{tr('لا توجد فترات مقفلة بعد', 'No closed periods yet')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-start">{tr('الفترة', 'Period')}</TableHead>
                  <TableHead className="text-end">{tr('المبيعات', 'Sales')}</TableHead>
                  <TableHead className="text-end">{tr('الربح المحقق', 'Realized')}</TableHead>
                  <TableHead className="text-end">{tr('المصاريف', 'Expenses')}</TableHead>
                  <TableHead className="text-end">{tr('ديون معدومة', 'Bad debts')}</TableHead>
                  <TableHead className="text-end">{tr('الصافي', 'Net')}</TableHead>
                  <TableHead className="text-end">{tr('معلّق', 'Pending')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {closures.map(c => (
                  <TableRow key={c.id}>
                    <TableCell className="whitespace-nowrap"><span dir="ltr" className="inline-block tabular-nums">{c.periodStart} → {c.periodEnd}</span></TableCell>
                    <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(c.revenue)}</span></TableCell>
                    <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{c.realizedProfit === null ? '—' : formatReportAmount(c.realizedProfit)}</span></TableCell>
                    <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(c.expenses)}</span></TableCell>
                    <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{c.badDebtLoss === null ? '—' : formatReportAmount(c.badDebtLoss)}</span></TableCell>
                    <TableCell className={`text-end font-bold ${c.netProfit >= 0 ? 'text-success' : 'text-destructive'}`}><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(c.netProfit)}</span></TableCell>
                    <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{c.pendingProfit === null ? '—' : formatReportAmount(c.pendingProfit)}</span></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader className="text-start">
            <AlertDialogTitle className="flex items-center gap-2 text-base font-bold">
              <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <Lock className="w-4 h-4" />
              </div>
              <span>{tr('تأكيد إقفال الفترة', 'Confirm closing the period')}</span>
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground pt-2 leading-relaxed">
              {tr(`سيتم إقفال الفترة من ${from} إلى ${to} وتثبيت أرقامها.`, `The period from ${from} to ${to} will be closed and its figures fixed.`)}
              <span className="text-destructive font-medium mt-1 block">
                {tr('هذا الإجراء لا يمكن التراجع عنه.', 'This cannot be undone.')}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('إلغاء', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={closeGuard.isRunning} onClick={runClose}>
              {closeGuard.isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : tr('إقفال الفترة', 'Close the period')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
