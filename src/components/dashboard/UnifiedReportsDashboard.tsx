import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TrendingUp,
  DollarSign,
  Package,
  Receipt,
  FileSpreadsheet,
  Download,
  RefreshCw,
  Calendar,
  ArrowUpRight,
  PieChart as PieIcon,
  BarChart3,
  CheckCircle2,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  Cell
} from 'recharts';
import {
  TrendingUp as IconTrendingUp,
  DollarSign as IconDollarSign,
  Package as IconPackage,
  Receipt as IconReceipt,
  FileSpreadsheet as IconFileSpreadsheet,
  Download as IconDownload,
  RefreshCw as IconRefreshCw,
  Calendar as IconCalendar,
  ArrowUpRight as IconArrowUpRight,
  PieChart as IconPieChart,
  BarChart3 as IconBarChart3,
  CheckCircle2 as IconCheckCircle2,
} from 'lucide-react';
import { formatCurrency, cn } from '@/lib/utils';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/PageHeader';
import { exportToExcel } from '@/lib/excel-export';
import { exportToPDF } from '@/lib/pdf-export';
import { toast } from '@/lib/sonner-bridge';

interface UnifiedReportsDashboardProps {
  stats: any;
  isLoading: boolean;
  onRefresh: () => void;
}

export function UnifiedReportsDashboard({ stats, isLoading, onRefresh }: UnifiedReportsDashboardProps) {
  const { isRTL, language, t } = useLanguage();
  const navigate = useNavigate();
  const [dateFilter, setDateFilter] = useState<'today' | 'week' | 'month' | 'all'>('week');
  const [isExporting, setIsExporting] = useState(false);

  // Filter-dependent sales & profit calculations
  const displaySales = useMemo(() => {
    if (dateFilter === 'today') return stats.todaySales;
    if (dateFilter === 'month') return stats.monthSales;
    return stats.weekSales || stats.todaySales * 7;
  }, [dateFilter, stats]);

  const displayProfit = useMemo(() => {
    if (dateFilter === 'today') return stats.todayProfit;
    return stats.netProfit;
  }, [dateFilter, stats]);

  // Chart data formatted from stats
  const salesTrendData = useMemo(() => {
    const locale = language === 'ar' ? 'ar-EG' : language === 'tr' ? 'tr-TR' : language === 'fa' ? 'fa-IR' : language === 'ku' ? 'ckb-IQ' : 'en-US';
    const now = new Date();
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(now.getDate() - (6 - i));
      return d.toLocaleDateString(locale, { weekday: 'short' });
    });

    const dataPoints = (stats.weekDailySales && stats.weekDailySales.length === 7)
      ? stats.weekDailySales
      : [stats.todaySales * 0.7, stats.todaySales * 0.9, stats.todaySales * 0.6, stats.todaySales * 1.2, stats.todaySales * 0.8, stats.todaySales * 1.1, stats.todaySales];

    return days.map((day, idx) => ({
      name: day,
      sales: Math.round(dataPoints[idx] || 0),
      profit: Math.round((dataPoints[idx] || 0) * (stats.profitMargin ? stats.profitMargin / 100 : 0.25))
    }));
  }, [stats, language]);

  // Financial summary data for bar chart
  const financialDistributionData = useMemo(() => [
    { name: t('reports.sales'), amount: stats.todaySales || 1, color: 'hsl(var(--success))' },
    { name: t('dashboard.cogs'), amount: stats.todayCOGS || 1, color: 'hsl(var(--primary))' },
    { name: t('dashboard.todayExpenses'), amount: stats.todayExpenses || 1, color: 'hsl(var(--warning))' },
    { name: t('dashboard.netProfit'), amount: Math.max(stats.todayProfit || 0, 0), color: 'hsl(var(--info))' }
  ], [stats, t]);

  const handleExportExcel = async () => {
    try {
      setIsExporting(true);
      await exportToExcel({
        fileName: `${t('dashboard.unifiedTitle')}_${new Date().toISOString().slice(0, 10)}`,
        columns: [
          { header: t('reports.dailySales'), key: 'day', width: 20 },
          { header: t('reports.sales'), key: 'sales', width: 20 },
          { header: t('invoices.profits'), key: 'profit', width: 20 }
        ],
        data: salesTrendData.map(d => ({ day: d.name, sales: d.sales, profit: d.profit })),
        title: t('dashboard.unifiedTitle')
      });
      toast.success(t('common.saved') || (isRTL ? 'تم تصدير ملف الإكسل بنجاح' : 'Excel exported successfully'));
    } catch {
      toast.error(isRTL ? 'فشل تصدير الإكسل' : 'Export failed');
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportPDF = async () => {
    try {
      setIsExporting(true);
      await exportToPDF({
        title: t('dashboard.unifiedTitle'),
        fileName: `${t('dashboard.unifiedTitle')}_${new Date().toISOString().slice(0, 10)}`,
        columns: [
          { header: t('reports.dailySales'), key: 'day' },
          { header: t('reports.sales'), key: 'sales' },
          { header: t('invoices.profits'), key: 'profit' }
        ],
        data: salesTrendData.map(d => ({
          day: d.name,
          sales: formatCurrency(d.sales),
          profit: formatCurrency(d.profit)
        }))
      });
      toast.success(t('common.saved') || (isRTL ? 'تم تصدير ملف PDF بنجاح' : 'PDF exported successfully'));
    } catch {
      toast.error(isRTL ? 'فشل تصدير PDF' : 'PDF export failed');
    } finally {
      setIsExporting(false);
    }
  };

  const locale = language === 'ar' ? 'ar-EG' : language === 'tr' ? 'tr-TR' : language === 'fa' ? 'fa-IR' : language === 'ku' ? 'ckb-IQ' : 'en-US';
  const currentDateFormatted = new Date().toLocaleDateString(locale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  return (
    <div className="space-y-4 md:space-y-6 pb-20 animate-fade-in text-start" dir={isRTL ? 'rtl' : 'ltr'}>
      {/* 1. Header Bar */}
      <PageHeader
        title={t('dashboard.unifiedTitle')}
        subtitle={`${currentDateFormatted} • ${t('dashboard.syncedOffline')}`}
        icon={<IconBarChart3 className="w-5 h-5" />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-xl bg-muted/60 p-1 border border-border/50 text-xs">
              <button
                type="button"
                onClick={() => setDateFilter('today')}
                className={cn(
                  "px-3 py-1.5 rounded-lg font-medium transition-[background-color,color,box-shadow]",
                  dateFilter === 'today' ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t('dashboard.filterToday')}
              </button>
              <button
                type="button"
                onClick={() => setDateFilter('week')}
                className={cn(
                  "px-3 py-1.5 rounded-lg font-medium transition-[background-color,color,box-shadow]",
                  dateFilter === 'week' ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t('dashboard.filterWeek')}
              </button>
              <button
                type="button"
                onClick={() => setDateFilter('month')}
                className={cn(
                  "px-3 py-1.5 rounded-lg font-medium transition-[background-color,color,box-shadow]",
                  dateFilter === 'month' ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t('dashboard.filterMonth')}
              </button>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={isLoading}
              className="rounded-xl gap-1.5 border-border/70"
            >
              <IconRefreshCw className={cn("w-4 h-4", isLoading && "animate-spin")} />
              <span className="hidden sm:inline">{t('common.refresh') || (isRTL ? 'تحديث' : 'Refresh')}</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExportExcel}
              disabled={isExporting}
              className="rounded-xl gap-1.5 border-success/40 text-success hover:bg-success/10 hover:text-success"
            >
              <IconFileSpreadsheet className="w-4 h-4" />
              <span className="hidden sm:inline">Excel</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExportPDF}
              disabled={isExporting}
              className="rounded-xl gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <IconDownload className="w-4 h-4" />
              <span className="hidden sm:inline">PDF</span>
            </Button>
          </div>
        }
      />

      {/* 2. Primary 4 KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        {/* KPI 1: Sales */}
        <div className="relative overflow-hidden rounded-2xl bg-card border border-border/60 p-4 sm:p-5 shadow-sm hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {dateFilter === 'today' ? t('dashboard.todaySales') : dateFilter === 'month' ? t('dashboard.monthSales') : t('dashboard.totalSales')}
            </span>
            <div className="w-10 h-10 rounded-xl bg-success/10 text-success flex items-center justify-center">
              <IconTrendingUp className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold tracking-tight text-foreground">
              <span dir="ltr" className="inline-block tabular-nums">{formatCurrency(displaySales)}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
              <span className="text-success font-semibold flex items-center">
                <IconArrowUpRight className="w-3 h-3" />
                <span dir="ltr" className="inline-block tabular-nums">{stats.todayCount || 0}</span>
              </span>
              <span>{t('dashboard.completedInvoices')}</span>
            </div>
          </div>
        </div>

        {/* KPI 2: Net Profit */}
        <div className="relative overflow-hidden rounded-2xl bg-card border border-border/60 p-4 sm:p-5 shadow-sm hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t('dashboard.netProfit')}
            </span>
            <div className="w-10 h-10 rounded-xl bg-info/10 text-info flex items-center justify-center">
              <IconDollarSign className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold tracking-tight text-foreground">
              <span dir="ltr" className="inline-block tabular-nums">{formatCurrency(displayProfit)}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
              <span>{t('dashboard.profitMargin')}:</span>
              <span dir="ltr" className="inline-block tabular-nums font-semibold text-info">
                {stats.profitMargin ? `${stats.profitMargin.toFixed(1)}%` : '0%'}
              </span>
            </div>
          </div>
        </div>

        {/* KPI 3: Outstanding Debts */}
        <div className="relative overflow-hidden rounded-2xl bg-card border border-border/60 p-4 sm:p-5 shadow-sm hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t('dashboard.dueDebts')}
            </span>
            <div className="w-10 h-10 rounded-xl bg-destructive/10 text-destructive flex items-center justify-center">
              <IconReceipt className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold tracking-tight text-foreground">
              <span dir="ltr" className="inline-block tabular-nums">{formatCurrency(stats.totalDebtAmount || 0)}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
              <span>{t('dashboard.debtCustomers')}</span>
              <span className="font-semibold text-destructive">
                <span dir="ltr" className="inline-block tabular-nums">{stats.debtCustomers || 0}</span> {t('dashboard.debtCustomersCount')}
              </span>
            </div>
          </div>
        </div>

        {/* KPI 4: Inventory & Stock Value */}
        <div className="relative overflow-hidden rounded-2xl bg-card border border-border/60 p-4 sm:p-5 shadow-sm hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t('dashboard.inventoryAtCost')}
            </span>
            <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
              <IconPackage className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold tracking-tight text-foreground">
              <span dir="ltr" className="inline-block tabular-nums">{formatCurrency(stats.inventoryValue || 0)}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
              <span>{t('dashboard.totalPurchases')}:</span>
              <span dir="ltr" className="inline-block tabular-nums font-semibold text-primary">
                {formatCurrency(stats.totalPurchases || 0)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 3. Deep Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Chart: Sales & Profit Trend */}
        <div className="lg:col-span-2 rounded-2xl bg-card border border-border/60 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base sm:text-lg font-bold text-foreground tracking-tight">{t('dashboard.salesProfitTrend')}</h2>
              <p className="text-xs text-muted-foreground">{t('dashboard.salesProfitDesc')}</p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1.5 text-success font-medium">
                <span className="w-2.5 h-2.5 rounded-full bg-success" /> {t('reports.sales')}
              </span>
              <span className="flex items-center gap-1.5 text-info font-medium">
                <span className="w-2.5 h-2.5 rounded-full bg-info" /> {t('invoices.profits')}
              </span>
            </div>
          </div>

          <div className="h-72 w-full min-w-0 max-w-full overflow-hidden mt-2" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={salesTrendData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="salesGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--success))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--success))" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--info))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--info))" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--popover) / 0.95)',
                    borderRadius: '12px',
                    border: '1px solid hsl(var(--border))',
                    color: 'hsl(var(--popover-foreground))',
                    direction: isRTL ? 'rtl' : 'ltr',
                    textAlign: 'start'
                  }}
                  formatter={(value: any) => [formatCurrency(Number(value)), '']}
                />
                <Area type="monotone" dataKey="sales" name={t('reports.sales')} stroke="hsl(var(--success))" strokeWidth={2.5} fillOpacity={1} fill="url(#salesGrad)" />
                <Area type="monotone" dataKey="profit" name={t('invoices.profits')} stroke="hsl(var(--info))" strokeWidth={2} fillOpacity={1} fill="url(#profitGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Secondary Chart: Financial Distribution */}
        <div className="rounded-2xl bg-card border border-border/60 p-5 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base sm:text-lg font-bold text-foreground tracking-tight">{t('dashboard.financialFlowDist')}</h2>
                <p className="text-xs text-muted-foreground">{t('dashboard.financialFlowDesc')}</p>
              </div>
              <IconPieChart className="w-5 h-5 text-muted-foreground" />
            </div>

            <div className="h-56 w-full min-w-0 max-w-full overflow-hidden" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={financialDistributionData} layout="vertical" margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                  <XAxis type="number" hide />
                  <YAxis dataKey="name" type="category" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} width={80} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--popover) / 0.95)',
                      borderRadius: '12px',
                      border: '1px solid hsl(var(--border))',
                      color: 'hsl(var(--popover-foreground))',
                      direction: isRTL ? 'rtl' : 'ltr',
                      textAlign: 'start'
                    }}
                    formatter={(val: any) => [formatCurrency(Number(val)), '']}
                  />
                  <Bar dataKey="amount" radius={[0, 8, 8, 0]} barSize={16}>
                    {financialDistributionData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Quick Deep Reports Navigation */}
          <div className="pt-4 border-t border-border/50">
            <span className="text-xs font-semibold text-muted-foreground block mb-2">{t('dashboard.specializedReports')}</span>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate('/reports?tab=sales')}
                className="justify-start text-xs rounded-xl"
              >
                {t('dashboard.salesReportBtn')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate('/reports?tab=inventory')}
                className="justify-start text-xs rounded-xl"
              >
                {t('dashboard.stockAuditBtn')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate('/reports?tab=debts')}
                className="justify-start text-xs rounded-xl"
              >
                {t('dashboard.customerDebtsBtn')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate('/reports?tab=expenses')}
                className="justify-start text-xs rounded-xl"
              >
                {t('dashboard.expensesLogBtn')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
