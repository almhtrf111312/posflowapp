import { useMemo, useState } from 'react';
import { realizedProfitToDate } from '@/lib/profit-engine';
import { ShoppingCart, Receipt, TrendingUp, Users } from 'lucide-react';
import { ReportShell } from './ReportShell';
import { EntityPicker, PickableEntity } from './EntityPicker';
import { Invoice, isValidActiveInvoice } from '@/lib/cloud/invoices-cloud';
import { formatNumber, formatReportAmount } from '@/lib/utils';
import { ReportCurrencyBanner } from './ReportCurrencyBanner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toLocalDateString, isDateInRange } from '@/lib/date-utils';
import { exportGenericToPDF, exportGenericToExcel } from '@/lib/reports/dataset-builder';
import { toast } from '@/lib/sonner-bridge';
import { useLanguage } from '@/hooks/use-language';
import { useNavigate } from 'react-router-dom';
import { invoicesLink, clickableClass } from '@/lib/report-links';

interface Props {
  invoices: Invoice[];
  dateRange: { from: string; to: string };
  cashierFilter: string;
  paymentFilter: string;
  statusFilter: string;
  hideExportToolbar?: boolean;
  hideHeaderCard?: boolean;
}

type ScopeMode = 'all' | 'customer' | 'cashier' | 'invoice';

export function SalesDetailedReport({ 
  invoices, 
  dateRange, 
  cashierFilter, 
  paymentFilter, 
  statusFilter,
  hideExportToolbar = false,
  hideHeaderCard = false
}: Props) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [scope, setScope] = useState<ScopeMode>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const baseFiltered = useMemo(() => {
    return invoices.filter(inv => {
      const d = toLocalDateString(inv.createdAt);
      if (!isDateInRange(d, dateRange.from, dateRange.to)) return false;
      if (inv.type !== 'sale') return false;
      if (!isValidActiveInvoice(inv)) return false;
      if (statusFilter !== 'all' && inv.status !== statusFilter) return false;
      if (cashierFilter !== 'all' && (inv.cashierName || 'غير محدد') !== cashierFilter) return false;
      if (paymentFilter !== 'all' && inv.paymentType !== paymentFilter) return false;
      return true;
    });
  }, [invoices, dateRange, statusFilter, cashierFilter, paymentFilter]);

  const customers: PickableEntity[] = useMemo(() => {
    const m = new Map<string, { name: string; total: number; count: number }>();
    baseFiltered.forEach(inv => {
      const name = inv.customerName || 'زبون نقدي';
      const cur = m.get(name) || { name, total: 0, count: 0 };
      cur.total += inv.total;
      cur.count += 1;
      m.set(name, cur);
    });
    return Array.from(m.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .map(([id, v]) => ({ id, name: v.name, subtitle: `${v.count} فاتورة • ${formatReportAmount(v.total)}` }));
  }, [baseFiltered]);

  const cashiers: PickableEntity[] = useMemo(() => {
    const m = new Map<string, { name: string; total: number; count: number }>();
    baseFiltered.forEach(inv => {
      const name = inv.cashierName || 'غير محدد';
      const cur = m.get(name) || { name, total: 0, count: 0 };
      cur.total += inv.total;
      cur.count += 1;
      m.set(name, cur);
    });
    return Array.from(m.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .map(([id, v]) => ({ id, name: v.name, subtitle: `${v.count} فاتورة • ${formatReportAmount(v.total)}` }));
  }, [baseFiltered]);

  const invoicePicks: PickableEntity[] = useMemo(() => {
    return baseFiltered
      .slice()
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .map(inv => ({
        id: inv.id,
        name: `فاتورة #${inv.id}`,
        subtitle: `${inv.customerName || 'نقدي'} • ${formatReportAmount(inv.total)} • ${toLocalDateString(inv.createdAt)}`,
      }));
  }, [baseFiltered]);

  // Apply scope filtering
  const scoped = useMemo(() => {
    if (scope === 'all' || !selectedId) return baseFiltered;
    if (scope === 'customer') return baseFiltered.filter(i => (i.customerName || 'زبون نقدي') === selectedId);
    if (scope === 'cashier') return baseFiltered.filter(i => (i.cashierName || 'غير محدد') === selectedId);
    if (scope === 'invoice') return baseFiltered.filter(i => i.id === selectedId);
    return baseFiltered;
  }, [baseFiltered, scope, selectedId]);

  const stats = useMemo(() => {
    const totalSales = scoped.reduce((s, i) => s + i.total, 0);
    const totalProfit = scoped.reduce((s, i) => s + realizedProfitToDate(i), 0);
    const totalDiscount = scoped.reduce((s, i) => s + (i.discount || 0), 0);
    const cashTotal = scoped.filter(i => i.paymentType === 'cash').reduce((s, i) => s + i.total, 0);
    const debtTotal = scoped.filter(i => i.paymentType === 'debt').reduce((s, i) => s + i.total, 0);
    const avg = scoped.length > 0 ? totalSales / scoped.length : 0;
    return { count: scoped.length, totalSales, totalProfit, totalDiscount, cashTotal, debtTotal, avg };
  }, [scoped]);

  const rows = useMemo(() => scoped
    .slice()
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .map(inv => ({
      number: inv.id,
      date: toLocalDateString(inv.createdAt),
      customer: inv.customerName || 'زبون نقدي',
      cashier: inv.cashierName || 'غير محدد',
      payment: inv.paymentType === 'cash' ? 'نقدي' : 'آجل',
      items: inv.items?.length || 0,
      discount: inv.discount || 0,
      profit: realizedProfitToDate(inv),
      total: inv.total,
    })), [scoped]);

  const handleExport = async (kind: 'pdf' | 'excel') => {
    if (rows.length === 0) { toast.error('لا توجد بيانات للتصدير'); return; }
    const scopeLabel = scope === 'all' ? (t('reports.category.all') || 'الكل') : selectedId || '';
    const opts = {
      title: t('reports.salesDetailedTitle') || 'تقرير المبيعات التفصيلي',
      subtitle: `${dateRange.from} → ${dateRange.to} • ${scopeLabel}`,
      sheetName: t('reports.sales') || 'مبيعات',
      columns: [
        { key: 'number', label: t('invoices.invoiceNumber') || 'رقم الفاتورة' },
        { key: 'date', label: t('common.date') || 'التاريخ' },
        { key: 'customer', label: t('reports.customers') || 'العميل' },
        { key: 'cashier', label: t('reports.cashiersUnit') || 'الكاشير' },
        { key: 'payment', label: t('invoices.paymentMethod') || 'الدفع' },
        { key: 'items', label: t('reports.itemsUnit') || 'الأصناف', kind: 'quantity' as const },
        { key: 'discount', label: t('invoices.discount') || 'الخصم', kind: 'money' as const },
        { key: 'profit', label: t('reports.profitLabel') || 'الربح', kind: 'money' as const },
        { key: 'total', label: t('invoices.total') || 'الإجمالي', kind: 'money' as const },
      ],
      rows,
      totals: { discount: stats.totalDiscount, profit: stats.totalProfit, total: stats.totalSales },
      summary: [
        { label: t('reports.totalInvoices') || 'عدد الفواتير', value: stats.count },
        { label: t('reports.totalSales') || 'إجمالي المبيعات', value: formatReportAmount(stats.totalSales) },
        { label: t('reports.totalProfit') || 'إجمالي الأرباح', value: formatReportAmount(stats.totalProfit) },
        { label: t('reports.avgInvoice') || 'متوسط الفاتورة', value: formatReportAmount(stats.avg) },
      ],
      fileName: `sales_detailed_${dateRange.from}_${dateRange.to}.${kind === 'pdf' ? 'pdf' : 'xlsx'}`,
    };
    if (kind === 'pdf') await exportGenericToPDF(opts); else await exportGenericToExcel(opts);
    toast.success(`تم تصدير ${kind === 'pdf' ? 'PDF' : 'Excel'} بنجاح`);
  };

  const pickerItems = scope === 'customer' ? customers : scope === 'cashier' ? cashiers : scope === 'invoice' ? invoicePicks : [];

  return (
    <ReportShell
      icon={<ShoppingCart className="w-5 h-5" />}
      title={t('reports.salesDetailedTitle') || 'تقرير المبيعات التفصيلي'}
      subtitle={`${t('reports.from') || 'من'} ${dateRange.from} ${t('reports.to') || 'إلى'} ${dateRange.to}`}
      onExportPDF={() => handleExport('pdf')}
      onExportExcel={() => handleExport('excel')}
      exportDisabled={rows.length === 0}
      hideExportToolbar={hideExportToolbar}
      hideHeaderCard={hideHeaderCard}
      filters={
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {([
              { id: 'all', label: 'الكل' },
              { id: 'customer', label: 'حسب العميل' },
              { id: 'cashier', label: 'حسب الكاشير' },
              { id: 'invoice', label: 'فاتورة محددة' },
            ] as { id: ScopeMode; label: string }[]).map(opt => (
              <Button
                key={opt.id}
                type="button"
                size="sm"
                variant={scope === opt.id ? 'default' : 'outline'}
                onClick={() => { setScope(opt.id); setSelectedId(null); }}
                className="rounded-xl text-xs"
              >{opt.label}</Button>
            ))}
          </div>
          {scope !== 'all' && (
            <EntityPicker
              label={scope === 'customer' ? 'اختر العميل' : scope === 'cashier' ? 'اختر الكاشير' : 'اختر الفاتورة'}
              placeholder="اضغط للاختيار..."
              items={pickerItems}
              value={selectedId}
              onChange={setSelectedId}
            />
          )}
        </div>
      }
    >
      {!hideExportToolbar && <ReportCurrencyBanner />}

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <Kpi icon={<Receipt className="w-4 h-4" />} label="الفواتير" value={formatNumber(stats.count)} color="text-info" />
        <Kpi icon={<TrendingUp className="w-4 h-4" />} label="المبيعات" value={formatReportAmount(stats.totalSales)} color="text-success" />
        <Kpi icon={<TrendingUp className="w-4 h-4" />} label="الأرباح المحققة" value={formatReportAmount(stats.totalProfit)} color="text-success" />
        <Kpi icon={<Users className="w-4 h-4" />} label="متوسط الفاتورة" value={formatReportAmount(stats.avg)} color="text-primary" />
      </div>

      {/* Cash vs Debt */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        <div className="rounded-xl border border-border/40 bg-card p-3">
          <p className="text-xs text-muted-foreground">نقدي</p>
          <p className="text-sm font-bold text-success"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(stats.cashTotal)}</span></p>
        </div>
        <div className="rounded-xl border border-border/40 bg-card p-3">
          <p className="text-xs text-muted-foreground">آجل</p>
          <p className="text-sm font-bold text-warning"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(stats.debtTotal)}</span></p>
        </div>
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
          <Receipt className="w-12 h-12 text-muted-foreground/50 mb-3" />
          <p className="text-sm sm:text-base font-semibold text-foreground">لا توجد فواتير ضمن الفلاتر الحالية</p>
        </div>
      ) : (
        <div className="w-full max-w-full overflow-x-auto rounded-2xl border border-border bg-card">
          <Table className="min-w-[620px] text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">{t('pos.invoiceTitle') || 'الفاتورة'}</TableHead>
                <TableHead className="text-start">{t('invoices.date') || 'التاريخ'}</TableHead>
                <TableHead className="text-start">{t('pos.customerLabel') || 'العميل'}</TableHead>
                <TableHead className="text-start">{t('cashShifts.cashier') || 'الكاشير'}</TableHead>
                <TableHead className="text-center">{t('pos.paymentMethodLabel') || 'الدفع'}</TableHead>
                <TableHead className="text-end">{t('reports.itemsInAudit') || 'الأصناف'}</TableHead>
                <TableHead className="text-end">{t('pos.profit') || 'الربح'}</TableHead>
                <TableHead className="text-end">{t('pos.totalLabel') || 'الإجمالي'}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, 200).map((r, i) => (
                <TableRow key={i} className="cursor-pointer" onClick={() => navigate(invoicesLink({ invoice: r.number }))}>
                  <TableCell className="text-start font-mono"><span dir="ltr" className="inline-block tabular-nums">#{r.number}</span></TableCell>
                  <TableCell className="text-start text-muted-foreground"><span dir="ltr" className="inline-block tabular-nums">{r.date}</span></TableCell>
                  <TableCell className="text-start">{r.customer}</TableCell>
                  <TableCell className="text-start text-muted-foreground">{r.cashier}</TableCell>
                  <TableCell className="text-center">
                    <Badge variant="outline" className={r.payment === 'نقدي' ? 'bg-success/15 text-success border-success/30' : 'bg-warning/15 text-warning border-warning/30'}>{r.payment}</Badge>
                  </TableCell>
                  <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{r.items}</span></TableCell>
                  <TableCell className="text-end text-success"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(r.profit)}</span></TableCell>
                  <TableCell className="text-end font-bold"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(r.total)}</span></TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow className="font-bold">
                <TableCell colSpan={6}>الإجمالي (<span dir="ltr" className="inline-block tabular-nums">{stats.count}</span> فاتورة)</TableCell>
                <TableCell className="text-end text-success"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(stats.totalProfit)}</span></TableCell>
                <TableCell className="text-end"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(stats.totalSales)}</span></TableCell>
              </TableRow>
            </TableFooter>
          </Table>
          {rows.length > 200 && (
            <p className="text-center text-[10px] text-muted-foreground py-2 border-t border-border/40">
              يعرض أول 200 من {rows.length} • قم بالتصدير لرؤية الكامل
            </p>
          )}
        </div>
      )}
    </ReportShell>
  );
}

function Kpi({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div className="rounded-xl border border-border/40 bg-card p-2.5">
      <div className={`flex items-center gap-1 ${color}`}>{icon}<span className="text-xs text-muted-foreground">{label}</span></div>
      <p className="text-sm font-bold mt-1 truncate"><span dir="ltr" className="inline-block tabular-nums">{value}</span></p>
    </div>
  );
}
