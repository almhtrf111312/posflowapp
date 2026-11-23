import { useMemo } from 'react';
import { realizedProfitToDate } from '@/lib/profit-engine';
import { FileText, Download, Wrench, DollarSign, TrendingUp, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatReportAmount } from '@/lib/utils';
import { Invoice, isValidActiveInvoice } from '@/lib/cloud/invoices-cloud';
import { exportToExcel } from '@/lib/excel-export';
import { exportToPDF } from '@/lib/pdf-export';
import { toast } from '@/lib/sonner-bridge';
import { toLocalDateString, isDateInRange } from '@/lib/date-utils';
import { useLanguage } from '@/hooks/use-language';
import { useNavigate } from 'react-router-dom';
import { invoicesLink, clickableClass } from '@/lib/report-links';

interface Props {
  dateRange: { from: string; to: string };
  invoices: Invoice[];
  isLoading: boolean;
  hideInternalExport?: boolean;
}

export function MaintenanceReport({ dateRange, invoices, isLoading, hideInternalExport = false }: Props) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const go = (extra: { payment?: string; invoice?: string } = {}) =>
    navigate(invoicesLink({ type: 'maintenance', from: dateRange.from, to: dateRange.to, ...extra }));

  const data = useMemo(() => {
    return invoices.filter(inv => {
      const d = toLocalDateString(inv.createdAt);
      return isDateInRange(d, dateRange.from, dateRange.to) && inv.type === 'maintenance' && isValidActiveInvoice(inv);
    });
  }, [invoices, dateRange]);

  const stats = useMemo(() => {
    const totalRevenue = data.reduce((s, i) => s + i.total, 0);
    const totalProfit = data.reduce((s, i) => s + realizedProfitToDate(i), 0);
    const totalPartsCost = data.reduce((s, i) => s + (i.partsCost || 0), 0);
    const cashCount = data.filter(i => i.paymentType === 'cash').length;
    const debtCount = data.filter(i => i.paymentType === 'debt').length;
    return { totalRevenue, totalProfit, totalPartsCost, cashCount, debtCount, count: data.length };
  }, [data]);

  const handleExportExcel = async () => {
    if (data.length === 0) { toast.error('لا توجد بيانات'); return; }
    await exportToExcel({
      amountsInUsd: true,
      sheetName: 'خدمات الصيانة',
      fileName: `صيانة_${dateRange.from}_${dateRange.to}.xlsx`,
      columns: [
        { header: 'العميل', key: 'customerName', width: 20 },
        { header: 'الوصف', key: 'serviceDescription', width: 30 },
        { header: 'سعر الخدمة', key: 'total', width: 12, kind: 'money' as const },
        { header: 'تكلفة القطع', key: 'partsCost', width: 12, kind: 'money' as const },
        { header: 'الربح', key: 'profit', width: 12, kind: 'money' as const },
        { header: 'نوع الدفع', key: 'paymentLabel', width: 12 },
        { header: 'التاريخ', key: 'date', width: 12 },
      ],
      data: data.map(inv => ({
        customerName: inv.customerName,
        serviceDescription: inv.serviceDescription || '-',
        total: inv.total,
        partsCost: inv.partsCost || 0,
        profit: realizedProfitToDate(inv),
        paymentLabel: inv.paymentType === 'cash' ? 'نقدي' : 'آجل',
        date: toLocalDateString(inv.createdAt),
      })),
      totals: { total: stats.totalRevenue, partsCost: stats.totalPartsCost, profit: stats.totalProfit },
      title: 'تقرير خدمات الصيانة',
      reportType: 'تقرير الصيانة',
      subtitle: `من ${dateRange.from} إلى ${dateRange.to}`,
      summary: [
        { label: 'عدد الخدمات', value: stats.count },
        { label: 'إجمالي الإيرادات', value: formatReportAmount(stats.totalRevenue) },
        { label: 'تكلفة القطع', value: formatReportAmount(stats.totalPartsCost) },
        { label: 'الربح المحقق', value: formatReportAmount(stats.totalProfit) },
      ],
    });
    toast.success('تم تصدير Excel بنجاح');
  };

  const handleExportPDF = async () => {
    if (data.length === 0) { toast.error('لا توجد بيانات'); return; }
    await exportToPDF({
      amountsInUsd: true,
      title: 'تقرير خدمات الصيانة',
      reportType: 'تقرير الصيانة',
      subtitle: `من ${dateRange.from} إلى ${dateRange.to}`,
      columns: [
        { header: 'العميل', key: 'customerName' },
        { header: 'الوصف', key: 'serviceDescription' },
        { header: 'الإيراد', key: 'total', kind: 'money' as const },
        { header: 'التكلفة', key: 'partsCost', kind: 'money' as const },
        { header: 'الربح', key: 'profit', kind: 'money' as const },
        { header: 'الدفع', key: 'paymentLabel' },
      ],
      data: data.map(inv => ({
        customerName: inv.customerName,
        serviceDescription: inv.serviceDescription || '-',
        total: inv.total,
        partsCost: inv.partsCost || 0,
        profit: realizedProfitToDate(inv),
        paymentLabel: inv.paymentType === 'cash' ? 'نقدي' : 'آجل',
      })),
      totals: { total: stats.totalRevenue, profit: stats.totalProfit },
      summary: [
        { label: 'عدد الخدمات', value: stats.count },
        { label: 'إجمالي الإيرادات', value: formatReportAmount(stats.totalRevenue) },
        { label: 'الربح المحقق', value: formatReportAmount(stats.totalProfit) },
      ],
      fileName: `صيانة_${dateRange.from}_${dateRange.to}.pdf`,
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
        <div className={`bg-card rounded-xl border border-border p-4 ${clickableClass}`} onClick={() => go()} title="عرض فواتير الصيانة">
          <Wrench className="w-5 h-5 text-primary mb-2" />
          <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{stats.count}</span></p>
          <p className="text-xs text-muted-foreground">{t('reports.maintenanceInvoicesCount') || 'عدد الخدمات'}</p>
        </div>
        <div className={`bg-card rounded-xl border border-border p-4 ${clickableClass}`} onClick={() => go()} title="عرض فواتير الصيانة">
          <DollarSign className="w-5 h-5 text-info mb-2" />
          <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(stats.totalRevenue)}</span></p>
          <p className="text-xs text-muted-foreground">{t('reports.totalRevenue') || 'إجمالي الإيرادات'}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <TrendingUp className="w-5 h-5 text-success mb-2" />
          <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(stats.totalProfit)}</span></p>
          <p className="text-xs text-muted-foreground">{t('reports.netProfit') || 'صافي الربح'}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <CheckCircle className="w-5 h-5 text-warning mb-2" />
          <p className="text-2xl font-bold">
            <button type="button" className="hover:underline" onClick={() => go({ payment: 'cash' })}>{stats.cashCount}</button>
            {' / '}
            <button type="button" className="hover:underline" onClick={() => go({ payment: 'debt' })}>{stats.debtCount}</button>
          </p>
          <p className="text-xs text-muted-foreground">{t('reports.cashSales') || 'نقدي'} / {t('reports.creditSales') || 'آجل'}</p>
        </div>
      </div>

      {data.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
          <Wrench className="w-12 h-12 text-muted-foreground/50 mb-3" />
          <p className="text-sm sm:text-base font-semibold text-foreground">{t('reports.noData') || 'لا توجد خدمات صيانة في الفترة المحددة'}</p>
        </div>
      ) : (
        <div className="w-full max-w-full overflow-x-auto rounded-2xl border border-border bg-card">
          <Table className="min-w-[620px] text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="text-center">#</TableHead>
                <TableHead className="text-start">{t('pos.customerLabel') || 'العميل'}</TableHead>
                <TableHead className="text-start">{t('maintenance.description') || 'الوصف'}</TableHead>
                <TableHead className="text-end">{t('reports.revenueLabel') || 'الإيراد'}</TableHead>
                <TableHead className="text-end">{t('pos.cost') || 'التكلفة'}</TableHead>
                <TableHead className="text-end">{t('pos.profit') || 'الربح'}</TableHead>
                <TableHead className="text-center">{t('pos.paymentMethodLabel') || 'الدفع'}</TableHead>
                <TableHead className="text-end">{t('invoices.date') || 'التاريخ'}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((inv, i) => (
                <TableRow key={inv.id} className="cursor-pointer" onClick={() => go({ invoice: inv.id })}>
                  <TableCell className="text-center text-muted-foreground"><span dir="ltr" className="inline-block tabular-nums">{i + 1}</span></TableCell>
                  <TableCell className="text-start font-medium">{inv.customerName}</TableCell>
                  <TableCell className="text-start text-muted-foreground max-w-[14.3rem] truncate">{inv.serviceDescription || '-'}</TableCell>
                  <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(inv.total)}</span></TableCell>
                  <TableCell className="text-end text-destructive"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(inv.partsCost || 0)}</span></TableCell>
                  <TableCell className="text-end text-success font-medium"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(realizedProfitToDate(inv))}</span></TableCell>
                  <TableCell className="text-center">
                    <Badge variant="outline" className={inv.paymentType === 'cash' ? 'bg-success/15 text-success border-success/30' : 'bg-warning/15 text-warning border-warning/30'}>
                      {inv.paymentType === 'cash' ? 'نقدي' : 'آجل'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-end text-muted-foreground"><span dir="ltr" className="inline-block tabular-nums">{toLocalDateString(inv.createdAt)}</span></TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow className="font-bold">
                <TableCell colSpan={3}>الإجمالي</TableCell>
                <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(stats.totalRevenue)}</span></TableCell>
                <TableCell className="text-end text-destructive"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(stats.totalPartsCost)}</span></TableCell>
                <TableCell className="text-end text-success"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(stats.totalProfit)}</span></TableCell>
                <TableCell colSpan={2} />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </div>
  );
}
