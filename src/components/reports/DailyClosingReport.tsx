import { useMemo, useState, useEffect } from 'react';
import { computeProfitSummary, expenseIsCounted } from '@/lib/profit-engine';
import { withProfitSnapshots, type ProfitLedger } from '@/lib/cloud/profit-ledger-cloud';
import { FileText, Download, Calendar, DollarSign, TrendingUp, TrendingDown, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatReportAmount } from '@/lib/utils';
import { ReportCurrencyBanner } from './ReportCurrencyBanner';
import { Invoice, isValidActiveInvoice } from '@/lib/cloud/invoices-cloud';
import { Expense } from '@/lib/cloud/expenses-cloud';
import { Debt, loadDebtPaymentsForDate } from '@/lib/cloud/debts-cloud';
import { exportToExcel } from '@/lib/excel-export';
import { exportToPDF } from '@/lib/pdf-export';
import { toast } from '@/lib/sonner-bridge';
import { Input } from '@/components/ui/input';
import { toLocalDateString } from '@/lib/date-utils';
import { useLanguage } from '@/hooks/language-context';

interface Props {
  invoices: Invoice[];
  expenses: Expense[];
  debts: Debt[];
  isLoading: boolean;
  dateRange: { from: string; to: string };
  hideInternalExport?: boolean;
  /** دفعات الديون المؤرخة والديون المعدومة لتعريف الربح الموحّد */
  profitLedger?: ProfitLedger;
}

export function DailyClosingReport({ invoices, expenses, debts, isLoading, dateRange, hideInternalExport = false, profitLedger }: Props) {
  const { t } = useLanguage();
  const [selectedDate, setSelectedDate] = useState('');

  // keep selectedDate in sync with the global range. The daily close opens on the LAST day of the range
  // (today for the usual ranges): opening on the first day of a month-long range showed an empty day.
  useEffect(() => {
    const day = dateRange.to || dateRange.from;
    if (day) {
      setSelectedDate(day);
    }
  }, [dateRange.from, dateRange.to]);

  const [debtPaymentsTotal, setDebtPaymentsTotal] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    if (!selectedDate) {
      setDebtPaymentsTotal(0);
      return;
    }

    const loadPayments = async () => {
      try {
        const total = await loadDebtPaymentsForDate(selectedDate);
        if (!cancelled) setDebtPaymentsTotal(total);
      } catch (e) {
        console.warn('Failed to load debt payments for date:', e);
      }
    };

    loadPayments();
    return () => { cancelled = true; };
  }, [selectedDate]);

  const data = useMemo(() => {
    const dayInvoices = invoices.filter(inv => {
      // ✅ استبعاد الفواتير المستردة والملغاة والمشطوبة محاسبياً لمنع تضخيم الإقفال اليومي
      if (!isValidActiveInvoice(inv)) return false;
      const d = toLocalDateString(inv.createdAt);
      return d === selectedDate;
    });

    const dayExpenses = expenses.filter(exp => toLocalDateString(exp.date) === selectedDate && expenseIsCounted({ isReversed: exp.is_reversed, reversedAt: exp.reversedAt ?? null }, selectedDate, toLocalDateString));

    const dayDebts = debts.filter(d => {
      const date = d.createdAt ? toLocalDateString(d.createdAt) : '';
      return date === selectedDate;
    });

    const salesInvoices = dayInvoices.filter(i => i.type === 'sale');
    const maintenanceInvoices = dayInvoices.filter(i => i.type === 'maintenance');

    const totalSales = salesInvoices.reduce((s, i) => s + i.total, 0);
    const totalMaintenance = maintenanceInvoices.reduce((s, i) => s + i.total, 0);
    // 🎯 تعريف الربح الموحّد: الربح المحقق في هذا اليوم (نقدي + رقمي + ما حُصّل اليوم من الآجل)
    const daySummary = computeProfitSummary({
      invoices: withProfitSnapshots(invoices, profitLedger),
      payments: profitLedger?.payments,
      writeoffs: profitLedger?.writeoffs,
      expenses: expenses.map(exp => ({ amount: Number(exp.amount) || 0, date: String(exp.date), isReversed: exp.is_reversed, reversedAt: exp.reversedAt ?? null })),
      range: selectedDate ? { from: selectedDate, to: selectedDate } : undefined,
      dayOf: toLocalDateString,
    });
    const totalProfit = selectedDate ? daySummary.realizedProfit : 0;
    const totalExpenses = dayExpenses.reduce((s, e) => s + e.amount, 0);
    // فصل صريح: نقدي + رقمي + آجل = إجمالي الإيرادات
    const cashSales = dayInvoices.filter(i => i.paymentType === 'cash' && i.paymentMethod !== 'digital').reduce((s, i) => s + i.total, 0);
    const digitalSales = dayInvoices.filter(i => i.paymentType === 'cash' && i.paymentMethod === 'digital').reduce((s, i) => s + i.total, 0);
    const debtSales = dayInvoices.filter(i => i.paymentType === 'debt').reduce((s, i) => s + i.total, 0);
    const newDebts = dayDebts.reduce((s, d) => s + d.totalDebt, 0);
    const debtPayments = debtPaymentsTotal;
    // الصافي = الربح المحقق − المصاريف − خسارة الديون المعدومة في هذا اليوم
    // F4 (audit 2026-11-24): the FX difference of this day's debt collections, below the net result
    const dayFxDifference = selectedDate
      ? (profitLedger?.fxDifferences || []).filter(f => toLocalDateString(f.date) === selectedDate).reduce((sum, f) => sum + f.amountUsd, 0)
      : 0;
    const netProfit = selectedDate ? daySummary.netProfit + dayFxDifference : 0;

    return {
      salesInvoices,
      maintenanceInvoices,
      dayExpenses,
      dayDebts,
      totalSales,
      totalMaintenance,
      totalRevenue: totalSales + totalMaintenance,
      totalProfit,
      totalExpenses,
      cashSales,
      digitalSales,
      debtSales,
      newDebts,
      debtPayments,
      netProfit,
      invoiceCount: dayInvoices.length,
      expenseCount: dayExpenses.length,
    };
  }, [invoices, expenses, debts, selectedDate, debtPaymentsTotal, profitLedger]);

  const handleExportExcel = async () => {
    const items = [
      { item: t('reports.totalSales') || 'إجمالي المبيعات', amount: data.totalSales },
      { item: t('reports.maintenanceRevenue') || 'إيرادات الصيانة', amount: data.totalMaintenance },
      { item: t('reports.totalRevenue') || 'إجمالي الإيرادات', amount: data.totalRevenue },
      { item: t('reports.cashSales') || 'المبيعات النقدية', amount: data.cashSales },
      { item: t('reports.digitalSales' as never) || 'المبيعات الرقمية', amount: data.digitalSales },
      { item: t('reports.debtSales') || 'المبيعات الآجلة', amount: data.debtSales },
      { item: t('reports.totalProfit') || 'إجمالي الأرباح', amount: data.totalProfit },
      { item: t('reports.totalExpenses') || 'إجمالي المصاريف', amount: data.totalExpenses },
      { item: t('reports.netProfit') || 'صافي الربح', amount: data.netProfit },
      { item: t('reports.newDebts') || 'ديون جديدة', amount: data.newDebts },
      { item: t('reports.debtPayments') || 'تسديدات ديون', amount: data.debtPayments },
    ];

    await exportToExcel({
      amountsInUsd: true,
      sheetName: t('reports.dailyClosing') || 'الإغلاق اليومي',
      fileName: `daily_closing_${selectedDate}.xlsx`,
      columns: [
        { header: t('reports.itemLabel') || 'البند', key: 'item', width: 25 },
        { header: t('reports.amountLabel') || 'المبلغ', key: 'amount', width: 15, kind: 'money' as const },
      ],
      data: items,
      title: t('reports.dailyClosingReport') || 'تقرير الإغلاق اليومي',
      reportType: t('reports.dailyReport') || 'تقرير يومي',
      subtitle: `${t('common.date') || 'التاريخ'}: ${selectedDate}`,
      summary: [
        { label: t('reports.totalInvoices') || 'عدد الفواتير', value: data.invoiceCount },
        { label: t('reports.expensesCount') || 'عدد المصاريف', value: data.expenseCount },
        { label: t('reports.netProfit') || 'صافي الربح', value: formatReportAmount(data.netProfit) },
      ],
    });
    toast.success(t('reports.exportSuccessExcel') || 'تم تصدير Excel بنجاح');
  };

  const handleExportPDF = async () => {
    const items = [
      { item: t('reports.totalSales') || 'إجمالي المبيعات', amount: data.totalSales },
      { item: t('reports.maintenanceRevenue') || 'إيرادات الصيانة', amount: data.totalMaintenance },
      { item: t('reports.totalRevenue') || 'إجمالي الإيرادات', amount: data.totalRevenue },
      { item: t('reports.cashSales') || 'المبيعات النقدية', amount: data.cashSales },
      { item: t('reports.digitalSales' as never) || 'المبيعات الرقمية', amount: data.digitalSales },
      { item: t('reports.debtSales') || 'المبيعات الآجلة', amount: data.debtSales },
      { item: t('reports.totalProfit') || 'إجمالي الأرباح', amount: data.totalProfit },
      { item: t('reports.totalExpenses') || 'إجمالي المصاريف', amount: data.totalExpenses },
      { item: t('reports.netProfit') || 'صافي الربح', amount: data.netProfit },
      { item: t('reports.newDebts') || 'ديون جديدة', amount: data.newDebts },
      { item: t('reports.debtPayments') || 'تسديدات ديون مستلمة', amount: data.debtPayments },
    ];

    await exportToPDF({
      amountsInUsd: true,
      title: t('reports.dailyClosingReport') || 'تقرير الإغلاق اليومي',
      reportType: t('reports.dailyReport') || 'تقرير يومي',
      subtitle: `${t('common.date') || 'التاريخ'}: ${selectedDate}`,
      columns: [
        { header: t('reports.itemLabel') || 'البند', key: 'item' },
        { header: t('reports.amountLabel') || 'المبلغ', key: 'amount', kind: 'money' as const },
      ],
      data: items,
      summary: [
        { label: t('reports.totalInvoices') || 'عدد الفواتير', value: data.invoiceCount },
        { label: t('reports.netProfit') || 'صافي الربح', value: formatReportAmount(data.netProfit) },
      ],
      fileName: `daily_closing_${selectedDate}.pdf`,
    });
    toast.success(t('reports.exportSuccessPDF') || 'تم تصدير PDF بنجاح');
  };

  if (isLoading) return <div className="text-center py-8 text-muted-foreground">{t('common.loading') || 'جاري التحميل...'}</div>;

  return (
    <div className="space-y-4">
      {!hideInternalExport && <ReportCurrencyBanner />}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 bg-card rounded-lg border border-border px-3 py-1.5">
          <Calendar className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{t('reports.selectDay') || 'اختر اليوم:'}</span>
          <Input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="w-36 min-h-10 text-xs border-0 bg-transparent p-0 focus-visible:ring-0"
          />
        </div>
        {!hideInternalExport && (
          <>
            <Button variant="outline" size="sm" onClick={handleExportPDF}><FileText className="w-3.5 h-3.5" />{t('reports.exportPDF') || 'PDF'}</Button>
            <Button variant="outline" size="sm" onClick={handleExportExcel}><Download className="w-3.5 h-3.5" />{t('reports.exportExcel') || 'Excel'}</Button>
          </>
        )}
      </div>

      {/* Main stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-card rounded-xl border border-border p-4">
          <DollarSign className="w-5 h-5 text-primary mb-2" />
          <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(data.totalRevenue)}</span></p>
          <p className="text-xs text-muted-foreground">{t('reports.totalRevenue') || 'إجمالي الإيرادات'}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <TrendingUp className="w-5 h-5 text-success mb-2" />
          <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(data.totalProfit)}</span></p>
          <p className="text-xs text-muted-foreground">{t('reports.totalProfit') || 'إجمالي الأرباح'}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <TrendingDown className="w-5 h-5 text-destructive mb-2" />
          <p className="text-2xl font-bold"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(data.totalExpenses)}</span></p>
          <p className="text-xs text-muted-foreground">{t('reports.expenses') || 'المصاريف'}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <Wallet className="w-5 h-5 text-success mb-2" />
          <p className={`text-2xl font-bold ${data.netProfit >= 0 ? 'text-success' : 'text-destructive'}`}>
            <span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(data.netProfit)}</span>
          </p>
          <p className="text-xs text-muted-foreground">{t('reports.netProfit') || 'صافي الربح'}</p>
        </div>
      </div>

      {/* Detailed breakdown */}
      <div className="bg-card rounded-2xl border border-border p-4 sm:p-6">
        <h3 className="text-base font-semibold mb-4 flex items-center gap-2">
          <Calendar className="w-4 h-4 text-primary" />
          {t('reports.daySummary') || 'ملخص يوم'} {selectedDate}
        </h3>
        <div className="space-y-3">
          {[
            { label: t('reports.productSales') || 'مبيعات المنتجات', value: data.totalSales, color: 'text-foreground', count: `${data.salesInvoices.length} ${t('reports.invoicesUnit') || 'فاتورة'}` },
            { label: t('reports.maintenanceRevenue') || 'إيرادات الصيانة', value: data.totalMaintenance, color: 'text-foreground', count: `${data.maintenanceInvoices.length} ${t('reports.ordersUnit') || 'خدمة'}` },
            { label: t('reports.cashSales') || 'المبيعات النقدية', value: data.cashSales, color: 'text-success' },
            { label: t('reports.digitalSales' as never) || 'المبيعات الرقمية', value: data.digitalSales, color: 'text-info' },
            { label: t('reports.debtSales') || 'المبيعات الآجلة', value: data.debtSales, color: 'text-warning' },
            { label: t('reports.totalProfit') || 'إجمالي الأرباح', value: data.totalProfit, color: 'text-success' },
            { label: t('reports.expenses') || 'المصاريف', value: data.totalExpenses, color: 'text-destructive', count: `${data.expenseCount} ${t('reports.vouchersUnit') || 'مصروف'}` },
            { label: t('reports.newDebts') || 'ديون جديدة', value: data.newDebts, color: 'text-destructive', count: `${data.dayDebts.length} ${t('debts.title') || 'دين'}` },
            { label: t('reports.debtPayments') || 'تسديدات ديون مستلمة', value: data.debtPayments, color: 'text-success' },
          ].map((item, i) => (
            <div key={i} className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
              <div className="flex items-center gap-2">
                <span className="text-sm">{item.label}</span>
                {item.count && <span className="text-xs text-muted-foreground">({item.count})</span>}
              </div>
              <span dir="ltr" className={`inline-block tabular-nums font-bold ${item.color}`}>{formatReportAmount(item.value)}</span>
            </div>
          ))}

          <div className="flex items-center justify-between py-3 border-t-2 border-primary/20 mt-2">
            <span className="text-base font-bold">{t('reports.netProfit') || 'صافي الربح'}</span>
            <span dir="ltr" className={`inline-block tabular-nums text-xl font-bold ${data.netProfit >= 0 ? 'text-success' : 'text-destructive'}`}>
              {formatReportAmount(data.netProfit)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
