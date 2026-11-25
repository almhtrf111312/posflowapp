import { useMemo } from 'react';
import { realizedProfitToDate } from '@/lib/profit-engine';
import { FileText, Download, Users, DollarSign, TrendingUp, ShoppingCart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatReportAmount, formatNumber } from '@/lib/utils';
import { Invoice } from '@/lib/cloud/invoices-cloud';
import { isSalesInvoice, invoiceNetSales } from '@/lib/report-metrics';
import { exportToExcel } from '@/lib/excel-export';
import { exportToPDF } from '@/lib/pdf-export';
import { toast } from '@/lib/sonner-bridge';
import { toLocalDateString, isDateInRange } from '@/lib/date-utils';
import { useLanguage } from '@/hooks/language-context';

interface Props {
  dateRange: { from: string; to: string };
  invoices: Invoice[];
  isLoading: boolean;
  hideInternalExport?: boolean;
  displayMode?: 'smart' | 'professional';
}

export function CashierPerformanceReport({
  dateRange,
  invoices,
  isLoading,
  hideInternalExport = false,
  displayMode = 'smart',
}: Props) {
  const { t } = useLanguage();

  const data = useMemo(() => {
    const filtered = invoices.filter(inv => {
      const d = toLocalDateString(inv.createdAt);
      if (!isDateInRange(d, dateRange.from, dateRange.to)) return false;
      // نفس قاعدة المبيعات الموحّدة: المعدومة ضمن المبيعات، المستردة والملغاة لا
      if (!isSalesInvoice(inv)) return false;
      return true;
    });

    const cashierMap: Record<string, {
      name: string;
      invoiceCount: number;
      totalSales: number;
      totalProfit: number;
      cashSales: number;
      debtSales: number;
    }> = {};

    filtered.forEach(inv => {
      const name = inv.cashierName || 'غير محدد';
      if (!cashierMap[name]) {
        cashierMap[name] = { name, invoiceCount: 0, totalSales: 0, totalProfit: 0, cashSales: 0, debtSales: 0 };
      }
      cashierMap[name].invoiceCount += 1;
      const net = invoiceNetSales(inv);
      cashierMap[name].totalSales += net;
      cashierMap[name].totalProfit += realizedProfitToDate(inv);
      if (inv.paymentType === 'cash') cashierMap[name].cashSales += net;
      else cashierMap[name].debtSales += net;
    });

    return Object.values(cashierMap).sort((a, b) => b.totalSales - a.totalSales);
  }, [invoices, dateRange]);

  const totalSales = data.reduce((s, c) => s + c.totalSales, 0);
  const totalProfit = data.reduce((s, c) => s + c.totalProfit, 0);
  const totalInvoices = data.reduce((s, c) => s + c.invoiceCount, 0);

  const handleExportExcel = async () => {
    if (data.length === 0) { toast.error('لا توجد بيانات'); return; }
    await exportToExcel({
      amountsInUsd: true,
      sheetName: 'أداء الكاشير',
      fileName: `أداء_الكاشير_${dateRange.from}_${dateRange.to}.xlsx`,
      columns: [
        { header: 'الكاشير', key: 'name', width: 20 },
        { header: 'عدد الفواتير', key: 'invoiceCount', width: 12, kind: 'quantity' as const },
        { header: 'إجمالي المبيعات', key: 'totalSales', width: 15, kind: 'money' as const },
        { header: 'الربح المحقق', key: 'totalProfit', width: 15, kind: 'money' as const },
        { header: 'متوسط الفاتورة', key: 'avgInvoice', width: 15, kind: 'money' as const },
        { header: 'مبيعات نقدية', key: 'cashSales', width: 15, kind: 'money' as const },
        { header: 'مبيعات آجلة', key: 'debtSales', width: 15, kind: 'money' as const },
      ],
      data: data.map(c => ({
        ...c,
        avgInvoice: c.invoiceCount > 0 ? Math.round(c.totalSales / c.invoiceCount) : 0,
      })),
      totals: { totalSales, totalProfit, invoiceCount: totalInvoices },
      title: 'تقرير أداء الكاشير',
      reportType: 'تقرير الأداء',
      subtitle: `من ${dateRange.from} إلى ${dateRange.to}`,
      summary: [
        { label: 'عدد الكاشيرات', value: data.length },
        { label: 'إجمالي المبيعات', value: formatReportAmount(totalSales) },
        { label: 'الأرباح المحققة', value: formatReportAmount(totalProfit) },
        { label: 'إجمالي الفواتير', value: totalInvoices },
      ],
    });
    toast.success('تم تصدير Excel بنجاح');
  };

  const handleExportPDF = async () => {
    if (data.length === 0) { toast.error('لا توجد بيانات'); return; }
    await exportToPDF({
      amountsInUsd: true,
      title: 'تقرير أداء الكاشير',
      reportType: 'تقرير الأداء',
      subtitle: `من ${dateRange.from} إلى ${dateRange.to}`,
      columns: [
        { header: 'الكاشير', key: 'name' },
        { header: 'الفواتير', key: 'invoiceCount', kind: 'quantity' as const },
        { header: 'المبيعات', key: 'totalSales', kind: 'money' as const },
        { header: 'الربح', key: 'totalProfit', kind: 'money' as const },
        { header: 'متوسط الفاتورة', key: 'avgInvoice', kind: 'money' as const },
      ],
      data: data.map(c => ({
        ...c,
        avgInvoice: c.invoiceCount > 0 ? Math.round(c.totalSales / c.invoiceCount) : 0,
      })),
      totals: { totalSales, totalProfit, invoiceCount: totalInvoices },
      summary: [
        { label: 'عدد الكاشيرات', value: data.length },
        { label: 'إجمالي المبيعات', value: formatReportAmount(totalSales) },
        { label: 'الأرباح المحققة', value: formatReportAmount(totalProfit) },
      ],
      fileName: `أداء_الكاشير_${dateRange.from}_${dateRange.to}.pdf`,
      orientation: 'landscape',
    });
    toast.success('تم تصدير PDF بنجاح');
  };

  if (isLoading) return <div className="text-center py-8 text-muted-foreground">جاري التحميل...</div>;

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
          <Users className="w-5 h-5 text-primary mb-2" />
          <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{data.length}</span></p>
          <p className="text-xs text-muted-foreground">{t('reports.totalActiveCashiers') || 'عدد الكاشيرات'}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <ShoppingCart className="w-5 h-5 text-info mb-2" />
          <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{totalInvoices}</span></p>
          <p className="text-xs text-muted-foreground">{t('reports.totalInvoices') || 'إجمالي الفواتير'}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <DollarSign className="w-5 h-5 text-success mb-2" />
          <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(totalSales)}</span></p>
          <p className="text-xs text-muted-foreground">{t('reports.totalSales') || 'إجمالي المبيعات'}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <TrendingUp className="w-5 h-5 text-success mb-2" />
          <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(totalProfit)}</span></p>
          <p className="text-xs text-muted-foreground">{t('reports.totalProfit') || 'إجمالي الأرباح'}</p>
        </div>
      </div>

      {data.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
          <Users className="w-12 h-12 text-muted-foreground/50 mb-3" />
          <p className="text-sm sm:text-base font-semibold text-foreground">{t('reports.noData') || 'لا توجد بيانات في الفترة المحددة'}</p>
        </div>
      ) : (
        <div className="w-full max-w-full overflow-x-auto rounded-2xl border border-border bg-card">
          <Table className="min-w-[620px] text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="text-center">#</TableHead>
                <TableHead className="text-start">{t('reports.cashiersUnit') || 'الكاشير'}</TableHead>
                <TableHead className="text-end">{t('reports.invoicesUnit') || 'الفواتير'}</TableHead>
                <TableHead className="text-end">{t('reports.sales') || 'المبيعات'}</TableHead>
                <TableHead className="text-end">{t('reports.profitLabel') || 'الربح'}</TableHead>
                <TableHead className="text-end">{t('reports.avgInvoice') || 'متوسط الفاتورة'}</TableHead>
                <TableHead className="text-end">{t('reports.cashSales') || 'نقدي'}</TableHead>
                <TableHead className="text-end">{t('reports.creditSales') || 'آجل'}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((c, i) => (
                <TableRow key={c.name}>
                  <TableCell className="text-center text-muted-foreground"><span dir="ltr" className="inline-block tabular-nums">{i + 1}</span></TableCell>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{c.invoiceCount}</span></TableCell>
                  <TableCell className="text-end font-medium"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(c.totalSales)}</span></TableCell>
                  <TableCell className="text-end text-success"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(c.totalProfit)}</span></TableCell>
                  <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(c.invoiceCount > 0 ? c.totalSales / c.invoiceCount : 0)}</span></TableCell>
                  <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(c.cashSales)}</span></TableCell>
                  <TableCell className="text-end text-warning"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(c.debtSales)}</span></TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow className="font-bold">
                <TableCell colSpan={2}>{t('invoices.total') || 'الإجمالي'}</TableCell>
                <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{totalInvoices}</span></TableCell>
                <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(totalSales)}</span></TableCell>
                <TableCell className="text-end text-success"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(totalProfit)}</span></TableCell>
                <TableCell colSpan={3} />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}

      {/* Bar chart visualization - Smart mode only */}
      {displayMode === 'smart' && data.length > 0 && (
        <div className="bg-card rounded-2xl border border-border p-4 sm:p-6">
          <h3 className="text-base font-semibold mb-4">مقارنة المبيعات</h3>
          <div className="space-y-3">
            {data.map((c, i) => {
              const maxSales = Math.max(...data.map(d => d.totalSales), 1);
              return (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-sm w-24 truncate font-medium">{c.name}</span>
                  <div className="flex-1 h-7 bg-muted/60 rounded-lg overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-l from-primary to-primary/70 rounded-lg transition-all"
                      style={{ width: `${(c.totalSales / maxSales) * 100}%` }}
                    />
                  </div>
                  <span dir="ltr" className="inline-block tabular-nums text-xs font-semibold w-20 text-end">{formatReportAmount(c.totalSales)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
