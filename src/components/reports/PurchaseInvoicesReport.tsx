import { useState, useEffect, useMemo } from 'react';
import { FileText, Download, Package, DollarSign, CheckCircle, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatReportAmount, formatNumber } from '@/lib/utils';
import { loadPurchaseInvoicesCloud, PurchaseInvoice } from '@/lib/cloud/purchase-invoices-cloud';
import { exportToExcel } from '@/lib/excel-export';
import { exportToPDF } from '@/lib/pdf-export';
import { toast } from '@/lib/sonner-bridge';
import { toLocalDateString, isDateInRange } from '@/lib/date-utils';
import { useLanguage } from '@/hooks/language-context';

interface Props {
  dateRange: { from: string; to: string };
  hideInternalExport?: boolean;
}

export function PurchaseInvoicesReport({ dateRange, hideInternalExport = false }: Props) {
  const { t } = useLanguage();
  const [invoices, setInvoices] = useState<PurchaseInvoice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPurchaseInvoicesCloud().then(data => {
      setInvoices(data);
      setLoading(false);
    });
  }, []);

  const filtered = useMemo(() => {
    return invoices.filter(inv => {
      const d = toLocalDateString(inv.invoice_date);
      return isDateInRange(d, dateRange.from, dateRange.to);
    });
  }, [invoices, dateRange]);

  const stats = useMemo(() => {
    const total = filtered.reduce((s, i) => s + (i.actual_grand_total || 0), 0);
    const expected = filtered.reduce((s, i) => s + i.expected_grand_total, 0);
    const finalized = filtered.filter(i => i.status === 'finalized').length;
    const draft = filtered.filter(i => i.status === 'draft').length;
    return { total, expected, finalized, draft, count: filtered.length };
  }, [filtered]);

  const handleExportExcel = async () => {
    if (filtered.length === 0) { toast.error('لا توجد بيانات للتصدير'); return; }
    await exportToExcel({
      amountsInUsd: true,
      sheetName: 'فواتير المشتريات',
      fileName: `فواتير_مشتريات_${dateRange.from}_${dateRange.to}.xlsx`,
      columns: [
        { header: 'رقم الفاتورة', key: 'invoice_number', width: 15 },
        { header: 'المورد', key: 'supplier_name', width: 20 },
        { header: 'الشركة', key: 'supplier_company', width: 20 },
        { header: 'التاريخ', key: 'invoice_date', width: 12 },
        { header: 'عدد الأصناف', key: 'actual_items_count', width: 12, kind: 'quantity' as const },
        { header: 'الكمية', key: 'actual_total_quantity', width: 12, kind: 'quantity' as const },
        { header: 'الإجمالي الفعلي', key: 'actual_grand_total', width: 15, kind: 'money' as const },
        { header: 'الإجمالي المتوقع', key: 'expected_grand_total', width: 15, kind: 'money' as const },
        { header: 'الحالة', key: 'status_label', width: 12 },
      ],
      data: filtered.map(inv => ({
        ...inv,
        supplier_company: inv.supplier_company || '-',
        status_label: inv.status === 'finalized' ? 'مؤكدة' : inv.status === 'reconciled' ? 'مراجعة' : 'مسودة',
      })),
      totals: { actual_grand_total: stats.total, expected_grand_total: stats.expected },
      title: 'تقرير فواتير المشتريات',
      reportType: 'تقرير المشتريات',
      subtitle: `من ${dateRange.from} إلى ${dateRange.to}`,
      summary: [
        { label: 'عدد الفواتير', value: stats.count },
        { label: 'الإجمالي الفعلي', value: formatReportAmount(stats.total) },
        { label: 'الإجمالي المتوقع', value: stats.expected },
        { label: 'فواتير مؤكدة', value: stats.finalized },
        { label: 'مسودات', value: stats.draft },
      ],
    });
    toast.success('تم تصدير Excel بنجاح');
  };

  const handleExportPDF = async () => {
    if (filtered.length === 0) { toast.error('لا توجد بيانات للتصدير'); return; }
    await exportToPDF({
      amountsInUsd: true,
      title: 'تقرير فواتير المشتريات',
      reportType: 'تقرير المشتريات',
      subtitle: `من ${dateRange.from} إلى ${dateRange.to}`,
      columns: [
        { header: 'رقم الفاتورة', key: 'invoice_number' },
        { header: 'المورد', key: 'supplier_name' },
        { header: 'التاريخ', key: 'invoice_date' },
        { header: 'الأصناف', key: 'actual_items_count', kind: 'quantity' as const },
        { header: 'الإجمالي', key: 'actual_grand_total', kind: 'money' as const },
        { header: 'الحالة', key: 'status_label' },
      ],
      data: filtered.map(inv => ({
        ...inv,
        status_label: inv.status === 'finalized' ? 'مؤكدة' : inv.status === 'reconciled' ? 'مراجعة' : 'مسودة',
      })),
      totals: { actual_grand_total: stats.total },
      summary: [
        { label: 'عدد الفواتير', value: stats.count },
        { label: 'الإجمالي الفعلي', value: formatReportAmount(stats.total) },
        { label: 'فواتير مؤكدة', value: stats.finalized },
      ],
      fileName: `فواتير_مشتريات_${dateRange.from}_${dateRange.to}.pdf`,
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
          <Package className="w-5 h-5 text-primary mb-2" />
          <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{stats.count}</span></p>
          <p className="text-xs text-muted-foreground">{t('reports.purchaseInvoicesCount') || 'عدد الفواتير'}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <DollarSign className="w-5 h-5 text-info mb-2" />
          <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(stats.total)}</span></p>
          <p className="text-xs text-muted-foreground">{t('invoices.total') || 'الإجمالي الفعلي'}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <CheckCircle className="w-5 h-5 text-success mb-2" />
          <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{stats.finalized}</span></p>
          <p className="text-xs text-muted-foreground">{t('invoices.confirmed') || 'فواتير مؤكدة'}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <Clock className="w-5 h-5 text-warning mb-2" />
          <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{stats.draft}</span></p>
          <p className="text-xs text-muted-foreground">{t('invoices.draft') || 'مسودات'}</p>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
          <Package className="w-12 h-12 text-muted-foreground/50 mb-3" />
          <p className="text-sm sm:text-base font-semibold text-foreground">{t('reports.noData') || 'لا توجد فواتير مشتريات في الفترة المحددة'}</p>
        </div>
      ) : (
        <div className="w-full max-w-full overflow-x-auto rounded-2xl border border-border bg-card">
          <Table className="min-w-[620px] text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">{t('invoices.invoiceNumber') || 'رقم الفاتورة'}</TableHead>
                <TableHead className="text-start">{t('purchaseInvoice.supplierName') || 'المورد'}</TableHead>
                <TableHead className="text-end">{t('invoices.date') || 'التاريخ'}</TableHead>
                <TableHead className="text-end">{t('reports.itemsInAudit') || 'الأصناف'}</TableHead>
                <TableHead className="text-end">{t('pos.qtyCol') || 'الكمية'}</TableHead>
                <TableHead className="text-end">{t('pos.totalLabel') || 'الإجمالي'}</TableHead>
                <TableHead className="text-center">{t('invoices.status') || 'الحالة'}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(inv => (
                <TableRow key={inv.id}>
                  <TableCell className="text-start font-mono text-xs"><span dir="ltr" className="inline-block tabular-nums">{inv.invoice_number}</span></TableCell>
                  <TableCell className="text-start font-medium">{inv.supplier_name}</TableCell>
                  <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{inv.invoice_date}</span></TableCell>
                  <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{inv.actual_items_count}</span></TableCell>
                  <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{inv.actual_total_quantity}</span></TableCell>
                  <TableCell className="text-end font-medium"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(inv.actual_grand_total || 0)}</span></TableCell>
                  <TableCell className="text-center">
                    <Badge variant="outline" className={
                      inv.status === 'finalized' ? 'bg-success/15 text-success border-success/30' :
                      inv.status === 'reconciled' ? 'bg-info/15 text-info border-info/30' :
                      'bg-warning/15 text-warning border-warning/30'
                    }>
                      {inv.status === 'finalized' ? 'مؤكدة' : inv.status === 'reconciled' ? 'مراجعة' : 'مسودة'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow className="font-bold">
                <TableCell colSpan={5}>الإجمالي</TableCell>
                <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(stats.total)}</span></TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </div>
  );
}
