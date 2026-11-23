import { cn } from '@/lib/utils';
import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { DashboardSkeleton } from '@/components/ui/page-skeleton';
import { formatNumber, formatCurrency } from '@/lib/utils';
import {
  DollarSign,
  TrendingUp,
  ShoppingCart,
  Users,
  CreditCard,
  Package,
  Wallet,
  Loader2,
  Banknote,
  TrendingDown,
  Calendar,
  BarChart3,
  RotateCcw,
  Receipt
} from 'lucide-react';
import { UnifiedReportsDashboard } from '@/components/dashboard/UnifiedReportsDashboard';
import { StatCard } from '@/components/dashboard/StatCard';
import { QuickActions } from '@/components/dashboard/QuickActions';
import { DebtAlerts } from '@/components/dashboard/DebtAlerts';
import { LowStockAlerts } from '@/components/dashboard/LowStockAlerts';
import { RecentInvoices } from '@/components/dashboard/RecentInvoices';
import { loadInvoicesCloud } from '@/lib/cloud/invoices-cloud';
import { loadProductsCloud } from '@/lib/cloud/products-cloud';
import { loadPartnersCloud } from '@/lib/cloud/partners-cloud';
import { loadExpensesCloud } from '@/lib/cloud/expenses-cloud';
import { loadDebtsCloud } from '@/lib/cloud/debts-cloud';
import { loadPurchaseInvoicesCloud } from '@/lib/cloud/purchase-invoices-cloud';
import { useLanguage } from '@/hooks/use-language';
import { EVENTS } from '@/lib/events';
import { isNoInventoryMode } from '@/lib/store-type-config';
import { toLocalDateString } from '@/lib/date-utils';
import { computeProfitSummary } from '@/lib/profit-engine';
import { loadProfitLedgerCloud } from '@/lib/cloud/profit-ledger-cloud';

const DASHBOARD_CACHE_KEY = 'posflow_dashboard_stats_cache_v1';

const getCapitalSettings = () => {
  try {
    const raw = localStorage.getItem('posflow_settings_v1');
    if (!raw) return { trackCapital: false, initialCapital: 0 };
    const parsed = JSON.parse(raw);
    const trackCapital = Boolean(
      parsed.trackCapital ?? 
      parsed.syncSettings?.trackCapital ?? 
      parsed.storeSettings?.trackCapital ?? 
      false
    );
    const initialCapital = Number(
      parsed.initialCapital ?? 
      parsed.syncSettings?.initialCapital ?? 
      parsed.storeSettings?.initialCapital ?? 
      0
    ) || 0;
    return { trackCapital, initialCapital };
  } catch {
    return { trackCapital: false, initialCapital: 0 };
  }
};

export default function Dashboard({ embedded }: { embedded?: boolean }) {
  const [dashboardDesign, setDashboardDesign] = useState<'classic' | 'unified_pro'>(() => {
    return (localStorage.getItem('posflow_dashboard_design_v1') as 'classic' | 'unified_pro') || 'classic';
  });

  useEffect(() => {
    const handler = () => {
      const current = (localStorage.getItem('posflow_dashboard_design_v1') as 'classic' | 'unified_pro') || 'classic';
      setDashboardDesign(current);
    };
    window.addEventListener('posflow:design-changed', handler);
    return () => window.removeEventListener('posflow:design-changed', handler);
  }, []);

  const { t, language, isRTL } = useLanguage();
  const [isLoading, setIsLoading] = useState(true);
  const [capitalConfig, setCapitalConfig] = useState(getCapitalSettings);
  const noInventory = isNoInventoryMode();
  // Display-only cache of last successful stats (never used for financial operations)
  const cached = (() => {
    try { const raw = localStorage.getItem(DASHBOARD_CACHE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
  })();
  const [hasData, setHasData] = useState<boolean>(!!cached);
  const [loadError, setLoadError] = useState(false);
  const [stats, setStats] = useState(cached?.stats ?? {
    todaySales: 0,
    weekSales: 0,
    monthSales: 0,
    todayCount: 0,
    todayProfit: 0,
    todayCOGS: 0,
    todayExpenses: 0,
    netProfit: 0,
    pendingProfit: 0,
    todayBadDebtLoss: 0,
    profitMargin: 0,
    totalDebtAmount: 0,
    debtCustomers: 0,
    uniqueCustomers: 0,
    inventoryValue: 0,
    totalCapital: 0,
    storeInitialCapital: 0,
    availableCapital: 0,
    cashboxBalance: 0,
    liquidCapital: 0,
    deficit: 0,
    deficitPercentage: 0,
    totalPurchases: 0,
    dailySales: [] as number[],
    todayRefundedCount: 0,
    monthRefundedAmount: 0,
    // Sparkline data arrays (7 days)
    dailyProfit: [] as number[],
    dailyDebts: [] as number[],
    dailyCustomers: [] as number[],
    dailyInventory: [] as number[],
    dailyCapital: [] as number[],
    dailyCashbox: [] as number[],
    dailyLiquid: [] as number[],
    dailyRefunds: [] as number[],
    weekDailySales: [] as number[],
    monthWeeklySales: [] as number[],
  });

  const today = new Date().toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Load stats from cloud
  const loadStats = useCallback(async () => {
    setIsLoading(true);
    try {
      const currentCap = getCapitalSettings();
      setCapitalConfig(currentCap);

      const [invoices, products, partners, expenses, debts, purchaseInvoices, profitLedger] = await Promise.all([
        loadInvoicesCloud(),
        loadProductsCloud(),
        loadPartnersCloud(),
        loadExpensesCloud(),
        loadDebtsCloud(),
        loadPurchaseInvoicesCloud(),
        loadProfitLedgerCloud()
      ]);

      const todayDate = new Date();
      const todayLocalYMD = toLocalDateString(todayDate);
      const thisMonthPrefix = todayLocalYMD.substring(0, 7);
      const isActiveInvoice = (inv: { status?: string }) => inv.status !== 'cancelled' && inv.status !== 'refunded';

      const invoiceDays = new Map<string, string>();
      const dayOfInvoice = (createdAt: string) => {
        const cached = invoiceDays.get(createdAt);
        if (cached !== undefined) return cached;
        const day = toLocalDateString(createdAt);
        invoiceDays.set(createdAt, day);
        return day;
      };

      const todayInvoices = invoices.filter(inv =>
        dayOfInvoice(inv.createdAt) === todayLocalYMD && isActiveInvoice(inv)
      );

      // 🎯 تعريف الربح الموحّد (profit-engine): نفس الأرقام في لوحة التحكم والتقارير وإقفال الفترة
      // المبيعات بدون الضريبة، والربح المحقق بحسب المبالغ المحصّلة فعلياً في يوم تحصيلها.
      const netOfTax = (inv: { total: number; taxAmount?: number }) => inv.total - (Number(inv.taxAmount) || 0);
      const profitInputs = {
        invoices,
        payments: profitLedger.payments,
        writeoffs: profitLedger.writeoffs,
        dayOf: dayOfInvoice,
      };
      const expenseInputs = expenses
        .filter(exp => !!exp.date)
        .map(exp => ({ amount: Number(exp.amount) || 0, date: String(exp.date) }));
      const todaySummary = computeProfitSummary({
        ...profitInputs,
        expenses: expenseInputs,
        range: { from: todayLocalYMD, to: todayLocalYMD },
      });

      const todaySales = todaySummary.sales;
      const todayFullProfit = todayInvoices.reduce((sum, inv) => sum + (inv.profit || 0), 0);
      const todayCOGS = todaySales - todayFullProfit;
      const todayExpenses = todaySummary.expenses;

      // الربح المحقق اليوم (نقدي + ما حُصّل اليوم من الآجل)، والصافي بعد المصاريف وخسارة الديون المعدومة
      const todayProfit = todaySummary.realizedProfit;
      const netProfit = todaySummary.netProfit;
      const pendingProfit = todaySummary.pendingProfit;
      const todayBadDebtLoss = todaySummary.badDebtLoss;

      const activeDebts = debts.filter(d => d.status !== 'fully_paid');
      const totalDebtAmount = activeDebts.reduce((sum, d) => sum + d.remainingDebt, 0);
      const debtCustomers = new Set(activeDebts.map(d => d.customerName)).size;

      const profitMargin = todaySales > 0 ? Math.round((todayProfit / todaySales) * 100) : 0;

      const monthInvoices = invoices.filter(inv => {
        return dayOfInvoice(inv.createdAt).substring(0, 7) === thisMonthPrefix && isActiveInvoice(inv);
      });

      const uniqueCustomers = new Set(monthInvoices.map(inv => inv.customerName)).size;
      const monthSales = monthInvoices.reduce((sum, inv) => sum + netOfTax(inv), 0);

      const oneWeekAgo = new Date();
      oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
      const oneWeekAgoYMD = toLocalDateString(oneWeekAgo);

      const weekInvoices = invoices.filter(inv =>
        dayOfInvoice(inv.createdAt) >= oneWeekAgoYMD && isActiveInvoice(inv)
      );
      const weekSales = weekInvoices.reduce((sum, inv) => sum + netOfTax(inv), 0);

      const inventoryValue = noInventory ? 0 : products.reduce((sum, p) => sum + (p.costPrice * p.quantity), 0);

      // Total purchases (sum of finalized purchase invoices)
      const totalPurchases = purchaseInvoices
        .filter(pi => pi.status === 'finalized')
        .reduce((sum, pi) => sum + (pi.actual_grand_total || 0), 0);

      // Helper: generate 7-day array for a metric
      const make7Days = (fn: (dayYmd: string) => number) =>
        Array.from({ length: 7 }, (_, i) => {
          const d = new Date(); d.setDate(d.getDate() - (6 - i));
          return fn(toLocalDateString(d));
        });

      // Daily sales for last 7 days (sparkline)
      const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 6);
      const last7Summary = computeProfitSummary({
        ...profitInputs,
        range: { from: toLocalDateString(weekStart), to: todayLocalYMD },
      });
      const last7ByDay = new Map(last7Summary.days.map(d => [d.date, d]));
      const dailySales = make7Days(dayYmd => last7ByDay.get(dayYmd)?.sales ?? 0);

      // الربح المحقق لكل يوم (يشمل ما حُصّل من الديون في ذلك اليوم)
      const dailyProfit = make7Days(dayYmd => last7ByDay.get(dayYmd)?.realizedProfit ?? 0);

      const dailyDebts = make7Days(dayYmd =>
        debts.filter(d => toLocalDateString(d.createdAt) === dayYmd && d.status !== 'fully_paid')
          .reduce((sum, d) => sum + d.remainingDebt, 0)
      );

      const dailyCustomers = make7Days(dayYmd =>
        new Set(invoices.filter(inv => dayOfInvoice(inv.createdAt) === dayYmd && isActiveInvoice(inv))
          .map(inv => inv.customerName)).size
      );

      const dailyRefunds = make7Days(dayYmd =>
        invoices.filter(inv => dayOfInvoice(inv.createdAt) === dayYmd && inv.status === 'refunded')
          .reduce((sum, inv) => sum + inv.total, 0)
      );

      // Week daily sales for "مبيعات الأسبوع" sparkline (same as dailySales)
      const weekDailySales = dailySales;

      // Monthly: 4-week breakdown
      const monthWeeklySales = Array.from({ length: 4 }, (_, i) => {
        const weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate() - (i * 7));
        const weekStart = new Date(weekEnd); weekStart.setDate(weekStart.getDate() - 6);
        const startYmd = toLocalDateString(weekStart);
        const endYmd = toLocalDateString(weekEnd);
        return invoices.filter(inv => {
          const dStr = dayOfInvoice(inv.createdAt);
          return dStr >= startYmd && dStr <= endYmd && isActiveInvoice(inv);
        }).reduce((sum, inv) => sum + inv.total, 0);
      }).reverse();

      // المحاسبة الدقيقة:
      // 1. إجمالي رأس المال التأسيسي = رأس مال المحل التأسيسي + مجموع رؤوس أموال الشركاء
      const partnersCapital = partners.reduce((sum, p) => sum + (p.currentCapital || 0), 0);
      const storeInitialCapital = currentCap.trackCapital ? (currentCap.initialCapital || 0) : 0;
      const totalCapital = storeInitialCapital + partnersCapital;

      // 2. المبيعات النقدية المقبوضة كاش فقط
      const totalSalesCash = invoices
        .filter(inv => isActiveInvoice(inv))
        .reduce((sum, inv) => {
          if (inv.paymentType === 'cash') return sum + inv.total;
          if ((inv.paymentType as string) === 'split' && (inv as any).downPayment) return sum + Number((inv as any).downPayment);
          return sum;
        }, 0);

      // 3. الديون المحصلة نقداً
      const debtPaidInvoices = invoices
        .filter(inv => isActiveInvoice(inv))
        .reduce((sum, inv) => sum + (inv.debtPaid || 0), 0);
      const debtPaidTable = debts.reduce((sum, d) => sum + (d.totalPaid || 0), 0);
      const totalDebtPaid = Math.max(debtPaidInvoices, debtPaidTable);

      // 4. فواتير الشراء المسددة نقداً فقط (فواتير الآجل لا تُخصم من السيولة النقدية حتى تُسدد)
      const isCashPurchase = (pi: any) => {
        const pType = pi.paymentType || pi.payment_type;
        if (pType === 'debt' || pType === 'credit') return false;
        if (typeof pi.notes === 'string' && (pi.notes.includes('آجل') || pi.notes.includes('دين'))) return false;
        return true;
      };

      const cashPurchasesPaid = purchaseInvoices
        .filter(pi => pi.status === 'finalized' && isCashPurchase(pi))
        .reduce((sum, pi) => sum + (pi.actual_grand_total || pi.expected_grand_total || 0), 0);

      // 5. المصاريف
      const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);

      // 6. مسحوبات الشركاء / المالك
      const totalWithdrawals = partners.reduce((sum, p) => sum + (p.totalWithdrawn || 0), 0);

      // 7. رأس المال السائل / السيولة المتوفرة بالصندوق:
      // Liquid Capital = (Total Capital + المبيعات النقدية + الديون المحصلة) - (فواتير الشراء المسددة نقداً + المصاريف)
      const globalCashBalance = (totalCapital + totalSalesCash + totalDebtPaid) - (cashPurchasesPaid + totalExpenses);
      const liquidCapital = globalCashBalance;

      const deficit = liquidCapital < 0 ? Math.abs(liquidCapital) : 0;
      const deficitPercentage = totalCapital > 0 ? (deficit / totalCapital) * 100 : 0;

      // ✅ إحصائيات الفواتير المستردة
      const todayRefundedInvoices = invoices.filter(inv =>
        dayOfInvoice(inv.createdAt) === todayLocalYMD && inv.status === 'refunded'
      );
      const todayRefundedCount = todayRefundedInvoices.length;

      const monthRefundedAmount = invoices
        .filter(inv => {
          return dayOfInvoice(inv.createdAt).substring(0, 7) === thisMonthPrefix && inv.status === 'refunded';
        })
        .reduce((sum, inv) => sum + inv.total, 0);

      const nextStats = {
        todaySales,
        weekSales,
        monthSales,
        todayCount: todayInvoices.length,
        todayProfit,
        todayCOGS,
        todayExpenses,
        netProfit,
        pendingProfit,
        todayBadDebtLoss,
        profitMargin,
        totalDebtAmount,
        debtCustomers,
        uniqueCustomers,
        inventoryValue,
        totalCapital,
        storeInitialCapital,
        availableCapital: globalCashBalance,
        cashboxBalance: globalCashBalance,
        liquidCapital,
        deficit,
        deficitPercentage,
        totalPurchases,
        dailySales,
        todayRefundedCount,
        monthRefundedAmount,
        dailyProfit,
        dailyDebts,
        dailyCustomers,
        dailyInventory: dailySales, // reuse sales trend for inventory visualization
        dailyCapital: dailyProfit,
        dailyCashbox: dailySales,
        dailyLiquid: dailyProfit,
        dailyRefunds,
        weekDailySales,
        monthWeeklySales,
      };
      setStats(nextStats);
      setHasData(true);
      setLoadError(false);
      const now = Date.now();
      try { localStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify({ stats: nextStats, at: now })); } catch { /* quota */ }
    } catch (error) {
      console.error('Error loading dashboard stats:', error);
      setLoadError(true);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();

    // Debounce bursts of update events (realtime/sync) into a single reload
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handleUpdate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => loadStats(), 800);
    };
    const evts = [
      EVENTS.INVOICES_UPDATED,
      EVENTS.PRODUCTS_UPDATED,
      EVENTS.PARTNERS_UPDATED,
      EVENTS.EXPENSES_UPDATED,
      EVENTS.RECURRING_EXPENSES_UPDATED,
      EVENTS.CASHBOX_UPDATED,
      EVENTS.CAPITAL_UPDATED,
      EVENTS.SETTINGS_UPDATED,
      EVENTS.PURCHASES_UPDATED,
      EVENTS.DEBTS_UPDATED,
    ];
    evts.forEach(e => window.addEventListener(e, handleUpdate));

    return () => {
      if (timer) clearTimeout(timer);
      evts.forEach(e => window.removeEventListener(e, handleUpdate));
    };
  }, [loadStats]);

    if (dashboardDesign === 'unified_pro') {
    return (
      <div className="p-3 sm:p-4 md:p-6 max-w-7xl mx-auto space-y-4 md:space-y-6">
        <UnifiedReportsDashboard
          stats={stats}
          isLoading={isLoading}
          onRefresh={loadStats}
        />
      </div>
    );
  }

  if (isLoading && !hasData && !loadError) {
    return <DashboardSkeleton embedded={embedded} />;
  }

  return (
    <div className={cn("space-y-4 md:space-y-6", !embedded && "p-3 sm:p-4 md:p-6")}>
      {/* Header */}
      {!embedded && (
        <PageHeader
          title={t('nav.dashboard')}
          actions={
            loadError ? (
              <Button variant="outline" size="sm" onClick={() => loadStats()} className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive">
                {t('common.retry') || (isRTL ? 'إعادة المحاولة' : 'Retry')}
              </Button>
            ) : isLoading ? (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-muted border border-border">
                <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                <span className="text-xs font-medium text-muted-foreground">{hasData ? t('common.updating') : t('common.loading')}</span>
              </div>
            ) : undefined
          }
        />
      )}

      {/* Quick Actions - Compact Toolbar */}
      <QuickActions />

      {/* Sales Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <StatCard
          title={t('dashboard.todaySales')}
          value={formatCurrency(stats.todaySales)}
          subtitle={`${stats.todayCount} ${t('dashboard.invoice')}`}
          icon={<DollarSign />}
          variant="primary"
          linkTo="/pos"
          sparklineData={stats.dailySales}
        />
        <StatCard
          title={t('dashboard.weekSales')}
          value={formatCurrency(stats.weekSales)}
          icon={<Calendar />}
          variant="info"
          linkTo="/invoices"
          sparklineData={stats.weekDailySales}
        />
        <StatCard
          title={t('dashboard.monthSales')}
          value={formatCurrency(stats.monthSales)}
          icon={<BarChart3 />}
          variant="purple"
          linkTo="/reports"
          sparklineData={stats.monthWeeklySales}
        />
      </div>

      {/* Financial Performance Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <StatCard
          title={t('dashboard.netProfit')}
          value={formatCurrency(stats.netProfit)}
          subtitle={`${t('dashboard.profitMargin')} ${stats.profitMargin}%`}
          icon={<TrendingUp />}
          variant="success"
          linkTo="/reports"
          sparklineData={stats.dailyProfit}
        />
        <StatCard
          title={t('dashboard.dueDebts')}
          value={formatCurrency(stats.totalDebtAmount)}
          subtitle={`${stats.debtCustomers} ${t('dashboard.client')}`}
          icon={<CreditCard />}
          variant="danger"
          linkTo="/debts"
          sparklineData={stats.dailyDebts}
        />
        <StatCard
          title={t('dashboard.customersThisMonth')}
          value={stats.uniqueCustomers.toString()}
          subtitle={t('dashboard.uniqueCustomers')}
          icon={<Users />}
          variant="info"
          linkTo="/customers"
          sparklineData={stats.dailyCustomers}
        />
      </div>

      {/* أرباح معلّقة وخسارة ديون معدومة: سطران منفصلان لا يدخلان في الربح المحقق */}
      {((stats.pendingProfit ?? 0) !== 0 || (stats.todayBadDebtLoss ?? 0) !== 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          {(stats.pendingProfit ?? 0) !== 0 && (
            <div className="flex items-center justify-between rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-sm">
              <span className="text-muted-foreground">{t('dashboard.pendingProfit')}</span>
              <span dir="ltr" className="inline-block tabular-nums font-semibold text-warning">{formatCurrency(stats.pendingProfit ?? 0)}</span>
            </div>
          )}
          {(stats.todayBadDebtLoss ?? 0) !== 0 && (
            <div className="flex items-center justify-between rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
              <span className="text-muted-foreground">{t('dashboard.badDebtLossToday')}</span>
              <span dir="ltr" className="inline-block tabular-nums font-semibold text-destructive">{formatCurrency(stats.todayBadDebtLoss ?? 0)}</span>
            </div>
          )}
        </div>
      )}

      {/* Capital / Financial Overview Row */}
      {capitalConfig.trackCapital ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
          {noInventory ? (
            <StatCard
              title={t('dashboard.totalPurchases')}
              value={formatCurrency(stats.totalPurchases)}
              icon={<ShoppingCart />}
              variant="purple"
              linkTo="/products"
              sparklineData={stats.dailySales}
            />
          ) : (
            <StatCard
              title={t('dashboard.inventoryValue')}
              value={formatCurrency(stats.inventoryValue)}
              subtitle={t('dashboard.atCostPrice')}
              icon={<Package />}
              variant="purple"
              linkTo="/products"
              sparklineData={stats.dailySales}
            />
          )}
          <StatCard
            title={t('dashboard.totalCapital')}
            value={formatCurrency(stats.totalCapital)}
            subtitle={stats.storeInitialCapital > 0 ? `${t('dashboard.storeCapital')} ${formatCurrency(stats.storeInitialCapital)}` : undefined}
            icon={<Wallet />}
            variant="success"
            linkTo="/partners"
            sparklineData={stats.dailyProfit}
          />
          <StatCard
            title={t('dashboard.liquidCapital')}
            value={formatCurrency(stats.liquidCapital)}
            subtitle={
              stats.deficit > 0
                ? `${t('dashboard.liquidityDeficit')} ${formatCurrency(stats.deficit)} (${stats.deficitPercentage.toFixed(1)}%)`
                : t('dashboard.treasuryAndCash')
            }
            icon={<Banknote />}
            variant={stats.liquidCapital < 0 ? 'danger' : 'info'}
            linkTo="/reports"
            sparklineData={stats.dailyProfit}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-4">
          {noInventory ? (
            <StatCard
              title={t('dashboard.totalPurchases')}
              value={formatCurrency(stats.totalPurchases)}
              icon={<ShoppingCart />}
              variant="purple"
              linkTo="/products"
              sparklineData={stats.dailySales}
            />
          ) : (
            <StatCard
              title={t('dashboard.inventoryValue')}
              value={formatCurrency(stats.inventoryValue)}
              subtitle={t('dashboard.atCostPrice')}
              icon={<Package />}
              variant="purple"
              linkTo="/products"
              sparklineData={stats.dailySales}
            />
          )}
          <StatCard
            title={t('dashboard.todayExpenses')}
            value={formatCurrency(stats.todayExpenses)}
            subtitle={t('dashboard.operatingExpensesDaily')}
            icon={<Receipt />}
            variant="warning"
            linkTo="/expenses"
            sparklineData={stats.dailyProfit}
          />
        </div>
      )}

      {/* Refund Stats Row */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        <StatCard
          title={t('dashboard.refundedToday')}
          value={stats.todayRefundedCount.toString()}
          subtitle={t('dashboard.refundedInvoice')}
          icon={<RotateCcw />}
          variant="warning"
          linkTo="/invoices"
          sparklineData={stats.dailyRefunds}
        />
        <StatCard
          title={t('dashboard.monthRefundedTotal')}
          value={formatCurrency(stats.monthRefundedAmount)}
          subtitle={t('dashboard.refundedThisMonth')}
          icon={<TrendingDown />}
          variant="warning"
          linkTo="/invoices"
          sparklineData={stats.dailyRefunds}
        />
      </div>

      {/* Recent Invoices */}
      <RecentInvoices />

      {/* Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {!noInventory && <LowStockAlerts />}
        <DebtAlerts />
      </div>
    </div>
  );
}
