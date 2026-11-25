import { useState, useEffect, useMemo } from 'react';
import { FileText, Download, AlertTriangle, CheckCircle, Clock, DollarSign } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatNumber, formatReportAmount } from '@/lib/utils';
import { loadDebtsCloud, Debt } from '@/lib/cloud/debts-cloud';
import { exportToExcel } from '@/lib/excel-export';
import { exportToPDF } from '@/lib/pdf-export';
import { toast } from '@/lib/sonner-bridge';
import { toLocalDateString, isDateInRange } from '@/lib/date-utils';
import { useLanguage } from '@/hooks/language-context';
import { useNavigate } from 'react-router-dom';
import { invoicesLink, clickableClass } from '@/lib/report-links';
import { useCurrency, formatInCurrency } from '@/hooks/use-currency';

interface Props {
  dateRange: { from: string; to: string };
  hideInternalExport?: boolean;
}

export function DebtsReport({ dateRange, hideInternalExport = false }: Props) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { currencyCode, exchangeRate } = useCurrency();
  const isNonUsd = currencyCode !== 'USD';
  const [debts, setDebts] = useState<Debt[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDebtsCloud().then(data => {
      setDebts(data);
      setLoading(false);
    });
  }, []);

  const filtered = useMemo(() => {
    return debts.filter(d => {
      const date = toLocalDateString(d.createdAt || '');
      return isDateInRange(date, dateRange.from, dateRange.to);
    });
  }, [debts, dateRange]);

  const stats = useMemo(() => {
    const totalDebt = filtered.reduce((s, d) => s + d.totalDebt, 0);
    const totalPaid = filtered.reduce((s, d) => s + d.totalPaid, 0);
    const totalRemaining = filtered.reduce((s, d) => s + d.remainingDebt, 0);
    const overdue = filtered.filter(d => d.status === 'overdue').length;
    // الدين المشطوب لا يُحسب «مسدداً»: له عدّاد ومبلغ مستقلان
    const writtenOff = filtered.filter(d => d.isWrittenOff).length;
    const writtenOffAmount = filtered.reduce((s, d) => s + (d.isWrittenOff ? (d.writtenOffAmount || 0) : 0), 0);
    const fullyPaid = filtered.filter(d => d.status === 'fully_paid' && !d.isWrittenOff).length;
    const partial = filtered.filter(d => d.status === 'partially_paid').length;
    const due = filtered.filter(d => d.status === 'due').length;
    return { totalDebt, totalPaid, totalRemaining, overdue, fullyPaid, partial, due, writtenOff, writtenOffAmount, count: filtered.length };
  }, [filtered]);

  const statusLabel = (s: string) => {
    switch (s) {
      case 'written_off': return 'مشطوب';
      case 'fully_paid': return 'مسدد';
      case 'partially_paid': return 'مسدد جزئياً';
      case 'overdue': return 'متأخر';
      default: return 'مستحق';
    }
  };

  const statusColor = (s: string) => {
    switch (s) {
      case 'written_off': return 'bg-muted text-muted-foreground border-border';
      case 'fully_paid': return 'bg-success/15 text-success border-success/30';
      case 'partially_paid': return 'bg-info/15 text-info border-info/30';
      case 'overdue': return 'bg-destructive/15 text-destructive border-destructive/30';
      default: return 'bg-warning/15 text-warning border-warning/30';
    }
  };

  const handleExportExcel = async () => {
    if (filtered.length === 0) { toast.error('لا توجد بيانات للتصدير'); return; }
    await exportToExcel({
      amountsInUsd: true,
      sheetName: 'البيع المؤجل',
      fileName: `تقرير_ديون_${dateRange.from}_${dateRange.to}.xlsx`,
      columns: [
        { header: 'العميل', key: 'customerName', width: 20 },
        { header: 'الهاتف', key: 'customerPhone', width: 15 },
        { header: 'إجمالي الدين', key: 'totalDebt', width: 14, kind: 'money' as const },
        { header: 'المدفوع', key: 'totalPaid', width: 14, kind: 'money' as const },
        { header: 'المتبقي', key: 'remainingDebt', width: 14, kind: 'money' as const },
        { header: 'تاريخ الاستحقاق', key: 'dueDate', width: 15 },
        { header: 'الحالة', key: 'status_label', width: 12 },
        { header: 'التاريخ', key: 'date', width: 12 },
      ],
      data: filtered.map(d => ({
        customerName: d.customerName || 'عميل',
        customerPhone: d.customerPhone || '-',
        totalDebt: d.totalDebt || 0,
        totalPaid: d.totalPaid || 0,
        remainingDebt: d.remainingDebt ?? Math.max(0, (d.totalDebt || 0) - (d.totalPaid || 0)),
        dueDate: d.dueDate || '-',
        status_label: statusLabel(d.isWrittenOff ? 'written_off' : d.status),
        date: toLocalDateString(d.createdAt || ''),
      })),
      totals: { totalDebt: stats.totalDebt, totalPaid: stats.totalPaid, remainingDebt: stats.totalRemaining },
      title: 'تقرير الديون - البيع المؤجل',
      reportType: 'تقرير الديون - البيع المؤجل',
      subtitle: `من ${dateRange.from} إلى ${dateRange.to}`,
      summary: [
        { label: 'عدد الديون', value: stats.count },
        { label: 'إجمالي الديون', value: formatReportAmount(stats.totalDebt) },
        { label: 'المدفوع', value: formatReportAmount(stats.totalPaid) },
        { label: 'المتبقي', value: formatReportAmount(stats.totalRemaining) },
      ],
    });
    toast.success('تم تصدير Excel بنجاح');
  };

  const handleExportPDF = async () => {
    if (filtered.length === 0) { toast.error('لا توجد بيانات للتصدير'); return; }
    await exportToPDF({
      amountsInUsd: true,
      title: 'تقرير الديون - البيع المؤجل',
      reportType: 'تقرير الديون - البيع المؤجل',
      subtitle: `من ${dateRange.from} إلى ${dateRange.to}`,
      columns: [
        { header: 'العميل', key: 'customerName' },
        { header: 'الهاتف', key: 'customerPhone' },
        { header: 'إجمالي الدين', key: 'totalDebt', kind: 'money' as const },
        { header: 'المدفوع', key: 'totalPaid', kind: 'money' as const },
        { header: 'المتبقي', key: 'remainingDebt', kind: 'money' as const },
        { header: 'تاريخ الاستحقاق', key: 'dueDate' },
        { header: 'الحالة', key: 'status_label' },
      ],
      data: filtered.map(d => ({
        customerName: d.customerName || 'عميل',
        customerPhone: d.customerPhone || '-',
        totalDebt: d.totalDebt || 0,
        totalPaid: d.totalPaid || 0,
        remainingDebt: d.remainingDebt ?? Math.max(0, (d.totalDebt || 0) - (d.totalPaid || 0)),
        dueDate: d.dueDate || '-',
        status_label: statusLabel(d.isWrittenOff ? 'written_off' : d.status),
      })),
      totals: { totalDebt: stats.totalDebt, totalPaid: stats.totalPaid, remainingDebt: stats.totalRemaining },
      summary: [
        { label: 'إجمالي الديون', value: formatReportAmount(stats.totalDebt) },
        { label: 'إجمالي المسدد', value: formatReportAmount(stats.totalPaid) },
        { label: 'المتبقي للتحصيل', value: formatReportAmount(stats.totalRemaining) },
        { label: 'عدد الديون', value: stats.count },
      ],
      fileName: `تقرير_ديون_${dateRange.from}_${dateRange.to}.pdf`,
      orientation: 'landscape',
    });
    toast.success('تم تصدير PDF بنجاح');
  };

  if (loading) return <div className="text-center py-8 text-muted-foreground">جاري التحميل...</div>;

  return (
    <div className="space-y-4">
      {!hideInternalExport && (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleExportPDF}><FileText className="w-3.5 h-3.5" />PDF</Button>
          <Button variant="outline" size="sm" onClick={handleExportExcel}><Download className="w-3.5 h-3.5" />Excel</Button>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-card rounded-xl border border-border p-4">
          <DollarSign className="w-5 h-5 text-destructive mb-2" />
          <div>
            <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{formatInCurrency(stats.totalRemaining, currencyCode, exchangeRate).formatted}</span></p>
            {isNonUsd && <p className="text-[11px] text-muted-foreground font-mono">{formatInCurrency(stats.totalRemaining, currencyCode, exchangeRate).usdEquivalent}</p>}
          </div>
          <p className="text-xs text-muted-foreground">{t('debts.remaining') || 'الديون المتبقية'}</p>
          {stats.writtenOff > 0 && (
            <p className="text-[11px] text-muted-foreground mt-1">مشطوب ({stats.writtenOff}): {formatInCurrency(stats.writtenOffAmount, currencyCode, exchangeRate).formatted}</p>
          )}
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <CheckCircle className="w-5 h-5 text-success mb-2" />
          <div>
            <p className="text-2xl font-bold text-success"><span dir="ltr" className="inline-block tabular-nums">{formatInCurrency(stats.totalPaid, currencyCode, exchangeRate).formatted}</span></p>
            {isNonUsd && <p className="text-[11px] text-muted-foreground font-mono">{formatInCurrency(stats.totalPaid, currencyCode, exchangeRate).usdEquivalent}</p>}
          </div>
          <p className="text-xs text-muted-foreground">{t('debts.paid') || 'المدفوع'}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <AlertTriangle className="w-5 h-5 text-destructive mb-2" />
          <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{stats.overdue}</span></p>
          <p className="text-xs text-muted-foreground">{t('debts.overdue') || 'متأخرة'}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <Clock className="w-5 h-5 text-warning mb-2" />
          <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{stats.count}</span></p>
          <p className="text-xs text-muted-foreground">{t('debts.totalDebt') || 'إجمالي الديون'}</p>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
          <DollarSign className="w-12 h-12 text-muted-foreground/50 mb-3" />
          <p className="text-sm sm:text-base font-semibold text-foreground">لا توجد ديون في الفترة المحددة</p>
        </div>
      ) : (
        <div className="w-full max-w-full overflow-x-auto rounded-2xl border border-border bg-card">
          <Table className="min-w-[620px] text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">{t('pos.customerLabel') || 'العميل'}</TableHead>
                <TableHead className="text-start">{t('customers.phone') || 'الهاتف'}</TableHead>
                <TableHead className="text-end">{t('reports.totalRecordedDebts') || 'إجمالي الدين'}</TableHead>
                <TableHead className="text-end">{t('pos.cashPaid') || 'المدفوع'}</TableHead>
                <TableHead className="text-end">{t('pos.remainingAsDebt') || 'المتبقي'}</TableHead>
                <TableHead className="text-center">{t('invoices.status') || 'الحالة'}</TableHead>
                <TableHead className="text-end">{t('invoices.date') || 'التاريخ'}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(d => (
                <TableRow key={d.id} className="cursor-pointer" onClick={() => navigate(invoicesLink({ payment: 'debt', q: d.customerName || undefined }))} title="عرض فواتير هذا العميل الآجلة">
                  <TableCell className="text-start font-medium">{d.customerName}</TableCell>
                  <TableCell className="text-start text-muted-foreground"><span dir="ltr" className="inline-block tabular-nums">{d.customerPhone || '-'}</span></TableCell>
                  <TableCell className="text-end">
                    <div><span dir="ltr" className="inline-block tabular-nums">{formatInCurrency(d.totalDebt, currencyCode, exchangeRate).formatted}</span></div>
                    {isNonUsd && <div className="text-xs text-muted-foreground font-mono"><span dir="ltr" className="inline-block tabular-nums">{formatInCurrency(d.totalDebt, currencyCode, exchangeRate).usdEquivalent}</span></div>}
                  </TableCell>
                  <TableCell className="text-end text-success">
                    <div><span dir="ltr" className="inline-block tabular-nums">{formatInCurrency(d.totalPaid, currencyCode, exchangeRate).formatted}</span></div>
                    {isNonUsd && <div className="text-xs text-muted-foreground font-mono"><span dir="ltr" className="inline-block tabular-nums">{formatInCurrency(d.totalPaid, currencyCode, exchangeRate).usdEquivalent}</span></div>}
                  </TableCell>
                  <TableCell className="text-end font-bold text-destructive">
                    <div><span dir="ltr" className="inline-block tabular-nums">{formatInCurrency(d.remainingDebt, currencyCode, exchangeRate).formatted}</span></div>
                    {isNonUsd && <div className="text-xs text-muted-foreground font-mono"><span dir="ltr" className="inline-block tabular-nums">{formatInCurrency(d.remainingDebt, currencyCode, exchangeRate).usdEquivalent}</span></div>}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant="outline" className={statusColor(d.isWrittenOff ? 'written_off' : d.status)}>
                      {statusLabel(d.isWrittenOff ? 'written_off' : d.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-end text-muted-foreground"><span dir="ltr" className="inline-block tabular-nums">{d.createdAt?.split('T')[0]}</span></TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow className="font-bold">
                <TableCell colSpan={2}>الإجمالي</TableCell>
                <TableCell className="text-end">
                  <div><span dir="ltr" className="inline-block tabular-nums">{formatInCurrency(stats.totalDebt, currencyCode, exchangeRate).formatted}</span></div>
                  {isNonUsd && <div className="text-xs text-muted-foreground font-mono"><span dir="ltr" className="inline-block tabular-nums">{formatInCurrency(stats.totalDebt, currencyCode, exchangeRate).usdEquivalent}</span></div>}
                </TableCell>
                <TableCell className="text-end text-success">
                  <div><span dir="ltr" className="inline-block tabular-nums">{formatInCurrency(stats.totalPaid, currencyCode, exchangeRate).formatted}</span></div>
                  {isNonUsd && <div className="text-xs text-muted-foreground font-mono"><span dir="ltr" className="inline-block tabular-nums">{formatInCurrency(stats.totalPaid, currencyCode, exchangeRate).usdEquivalent}</span></div>}
                </TableCell>
                <TableCell className="text-end text-destructive">
                  <div><span dir="ltr" className="inline-block tabular-nums">{formatInCurrency(stats.totalRemaining, currencyCode, exchangeRate).formatted}</span></div>
                  {isNonUsd && <div className="text-xs text-muted-foreground font-mono"><span dir="ltr" className="inline-block tabular-nums">{formatInCurrency(stats.totalRemaining, currencyCode, exchangeRate).usdEquivalent}</span></div>}
                </TableCell>
                <TableCell colSpan={2} />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </div>
  );
}
