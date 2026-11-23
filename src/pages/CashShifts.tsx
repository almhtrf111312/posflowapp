import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { ListPageSkeleton } from '@/components/ui/page-skeleton';
import {
  loadShifts,
  getActiveShift,
  openShift as openShiftFn,
  closeShift as closeShiftFn,
  calculateShiftStatus,
  Shift
} from '@/lib/cashbox-store';
import { EVENTS } from '@/lib/events';
import { loadQueue } from '@/lib/sync-queue';
import { ShiftFxDialog } from '@/components/cashbox/ShiftFxDialog';
import { loadShiftSupplierMoney, ShiftSupplierMoney } from '@/lib/cloud/suppliers-cloud';
import { useActionGuard } from '@/hooks/use-action-guard';
import { cn, formatCurrency, formatMoney, formatDateTime, formatNumber } from '@/lib/utils';
import { getCurrencyDisplayLabel } from '@/lib/currencies';
import { getEnabledCurrencies, toUsd, fromUsd, round8, roundForCurrency } from '@/lib/money-engine';
import { openShiftCloud, closeShiftCloud, loadCloudShifts, loadShiftVarianceTolerance, loadDeferredShiftVariances, resolveShiftVarianceCloud, DeferredShiftVariance } from '@/lib/cloud/cashbox-cloud';
import { useUserRole } from '@/hooks/use-user-role';
import { addActivityLog } from '@/lib/activity-log';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  PlayCircle,
  StopCircle,
  RefreshCw,
  Wallet,
  TrendingUp,
  TrendingDown,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Banknote
} from 'lucide-react';
import { toast } from '@/lib/sonner-bridge';
import { PageHeader } from '@/components/layout/PageHeader';

export default function CashShifts() {
  const { user, profile } = useAuth();
  const {t, isRTL, language } = useLanguage();
  const isEn = language === 'en';

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [openShift, setOpenShift] = useState<Shift | null>(null);
  const [showFx, setShowFx] = useState(false);
  const [supplierMoney, setSupplierMoney] = useState<ShiftSupplierMoney | null>(null);
  useEffect(() => {
    if (!openShift) { setSupplierMoney(null); return; }
    loadShiftSupplierMoney(openShift.id, openShift.openedAt).then(setSupplierMoney).catch(() => setSupplierMoney(null));
  }, [openShift]);
  const [shiftStatus, setShiftStatus] = useState({ cashSales: 0, cashExpenses: 0, expectedCash: 0 });

  // Dialog states
  const [isLoadingCloud, setIsLoadingCloud] = useState(true);
  const [showStartDialog, setShowStartDialog] = useState(false);
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [activeShiftCurrency, setActiveShiftCurrency] = useState<string>('USD');
  const [openings, setOpenings] = useState<Record<string, string>>({});
  const [closings, setClosings] = useState<Record<string, string>>({});
  const [dismissTarget, setDismissTarget] = useState<string | null>(null);
  const [dismissNote, setDismissNote] = useState('');
  const [varianceDecision, setVarianceDecision] = useState<'accept' | 'defer'>('accept');
  const [toleranceUsd, setToleranceUsd] = useState(1);
  const [deferred, setDeferred] = useState<DeferredShiftVariance[]>([]);
  const { isOwner } = useUserRole();
  const closeShiftGuard = useActionGuard();

  // Read on every render so currency/exchange-rate changes apply while the page is open
  const enabledCurrencies = getEnabledCurrencies();
  const usdCurrency = enabledCurrencies.find(currency => currency.code === 'USD');
  const formatUsd = (amount: number) => formatCurrency(
    amount,
    usdCurrency?.symbol || '$',
    usdCurrency?.decimals ?? 2,
    'USD',
    usdCurrency?.name
  );

  // Multi-currency details of active shift — ديناميكي لجميع العملات المفعلة
  const openShiftCurrencies = useMemo(() => {
    if (!openShift) return null;
    const curr = openShift.currencies || {};
    const result: Record<string, { opening: number; sales: number; expenses: number; deposits: number; withdrawals: number; expected: number }> = {};
    const allCodes = new Set([
      ...enabledCurrencies.map(c => c.code),
      // USD لا يُضاف قسراً: فقط إذا كان مفعلاً أو له حركة في الوردية (أو وردية قديمة بلا تفصيل عملات)
      ...(Object.keys(curr).length === 0 ? ['USD'] : []),
      ...Object.keys(curr)
    ]);
    allCodes.forEach(code => {
      const cObj = curr[code] || {
        opening: code === 'USD' ? openShift.openingCash : 0,
        sales: code === 'USD' ? openShift.salesTotal : 0,
        expenses: code === 'USD' ? openShift.expensesTotal : 0,
        deposits: code === 'USD' ? openShift.depositsTotal : 0,
        withdrawals: code === 'USD' ? openShift.withdrawalsTotal : 0,
      };
      const exp = roundForCurrency(cObj.opening + cObj.sales + cObj.deposits - cObj.expenses - cObj.withdrawals, code);
      result[code] = { ...cObj, expected: exp };
    });
    return result;
  }, [openShift, enabledCurrencies]);

  const loadDeferred = () => {
    if (!isOwner) return;
    void loadDeferredShiftVariances().then(setDeferred);
  };
  useEffect(() => {
    void loadShiftVarianceTolerance().then(setToleranceUsd);
    loadDeferred();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner]);

  // Load data
  const loadData = () => {
    const allShifts = loadShifts();
    setShifts(allShifts);

    const currentShift = getActiveShift();
    setOpenShift(currentShift);

    if (currentShift) {
      const status = calculateShiftStatus(currentShift);
      setShiftStatus(status);
    }

    // خلفي: دمج الورديات السحابية
    loadCloudShifts().then((cloudShifts) => {
      if (cloudShifts && cloudShifts.length > 0) {
        setShifts(prev => {
          const localIds = new Set(prev.map(s => s.id));
          const newFromCloud = cloudShifts
            .filter(cs => !localIds.has(cs.id))
            .map(cs => ({
              id: cs.id,
              openedAt: cs.opened_at,
              closedAt: cs.closed_at || undefined,
              openingCash: Number(cs.opening_balance) || 0,
              closingCash: cs.actual_balance !== null && cs.actual_balance !== undefined ? Number(cs.actual_balance) : undefined,
              expectedCash: Number(cs.expected_balance) || 0,
              discrepancy: cs.variance !== null && cs.variance !== undefined ? Number(cs.variance) : undefined,
              userId: cs.cashier_id || cs.user_id || '',
              userName: cs.cashier_name || (isEn ? 'Cashier' : 'كاشير'),
              status: (cs.closed_at ? 'closed' : 'open') as 'open' | 'closed',
              salesTotal: 0,
              expensesTotal: 0,
              depositsTotal: 0,
              withdrawalsTotal: 0,
              cogsTotal: 0,
              grossProfitTotal: 0,
            }));
          if (newFromCloud.length === 0) return prev;
          return [...prev, ...newFromCloud].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
        });
      }
    }).catch(() => {}).finally(() => {
      setIsLoadingCloud(false);
    });
  };

  useEffect(() => {
    loadData();

    const handleUpdate = () => loadData();
    window.addEventListener(EVENTS.CASH_SHIFTS_UPDATED, handleUpdate);
    window.addEventListener(EVENTS.INVOICES_UPDATED, handleUpdate);
    window.addEventListener(EVENTS.EXPENSES_UPDATED, handleUpdate);

    return () => {
      window.removeEventListener(EVENTS.CASH_SHIFTS_UPDATED, handleUpdate);
      window.removeEventListener(EVENTS.INVOICES_UPDATED, handleUpdate);
      window.removeEventListener(EVENTS.EXPENSES_UPDATED, handleUpdate);
    };
  }, []);

  // Refresh status periodically
  useEffect(() => {
    if (!openShift) return;

    const interval = setInterval(() => {
      const status = calculateShiftStatus(openShift);
      setShiftStatus(status);
    }, 30000);

    return () => clearInterval(interval);
  }, [openShift]);

  // Get user display name
  const userName = profile?.full_name || user?.email?.split('@')[0] || t('products.defaultUser');
  const userId = user?.id || 'unknown';

  // Total opening USD from multi-currency inputs
  const totalOpeningUSD = useMemo(() => {
    let sum = 0;
    enabledCurrencies.forEach(c => {
      const val = parseFloat(openings[c.code] || '') || 0;
      if (val > 0) {
        sum += toUsd(val, c.code, c.rate);
      }
    });
    return round8(sum);
  }, [openings, enabledCurrencies]);

  // Handle start shift
  const handleStartShift = () => {
    const currencyOpeningsRecord: Record<string, number> = {};
    let hasValidPositive = false;

    enabledCurrencies.forEach(c => {
      const val = parseFloat(openings[c.code] || '') || 0;
      if (val < 0) return;
      if (val > 0) {
        hasValidPositive = true;
        currencyOpeningsRecord[c.code] = val;
      }
    });

    const usdVal = parseFloat(openings['USD'] || '') || 0;
    if (!hasValidPositive && usdVal === 0 && openings['USD'] === '') {
      toast.error(t('cashShifts.enterValidAmount'));
      return;
    }

    const activeDef = enabledCurrencies.find(c => c.code === activeShiftCurrency) || enabledCurrencies[0];
    const activeRate = activeDef ? activeDef.rate : 1;

    const newShift = openShiftFn(totalOpeningUSD, userId, userName, currencyOpeningsRecord, activeShiftCurrency, activeRate);
    addActivityLog('shift_opened', userId, userName, `${t('cashShifts.startShift')} - ${formatMoney(totalOpeningUSD, 'USD')}`);
    toast.success(t('cashShifts.shiftOpened'));

    // مزامنة فتح الوردية مع السحابة فورياً
    if (newShift?.id) {
      void openShiftCloud({
        shiftId: newShift.id,
        cashierId: userId,
        cashierName: userName,
        openingBalance: totalOpeningUSD,
        openingByCurrency: currencyOpeningsRecord,
      });
    }

    setShowStartDialog(false);
    setOpenings({});
    loadData();
  };

  // Total closing USD from multi-currency inputs
  const totalClosingUSD = useMemo(() => {
    let sum = 0;
    enabledCurrencies.forEach(c => {
      const val = parseFloat(closings[c.code] || '') || 0;
      if (val > 0) {
        sum += toUsd(val, c.code, c.rate);
      }
    });
    return round8(sum);
  }, [closings, enabledCurrencies]);

  const hasAnyClosingInput = useMemo(() => {
    return Object.values(closings).some(v => v !== '');
  }, [closings]);

  // Calculate discrepancy for preview
  const previewDiscrepancy = useMemo(() => {
    if (!hasAnyClosingInput) return 0;
    return round8(totalClosingUSD - shiftStatus.expectedCash);
  }, [hasAnyClosingInput, totalClosingUSD, shiftStatus.expectedCash]);

  // فروقات الإقفال لكل عملة + الحكم على حد السماح
  const closingRows = useMemo(() => enabledCurrencies.map(c => {
    const expected = openShiftCurrencies?.[c.code]?.expected ?? (c.code === 'USD' ? shiftStatus.expectedCash : 0);
    const counted = parseFloat(closings[c.code] || '') || 0;
    const variance = roundForCurrency(counted - expected, c.code);
    const varianceUsd = variance === 0 ? 0 : toUsd(variance, c.code, c.rate);
    return { code: c.code, rate: c.rate, expected, counted, variance, varianceUsd };
  }), [enabledCurrencies, openShiftCurrencies, closings, shiftStatus.expectedCash]);
  const netVarianceUsd = useMemo(() => round8(closingRows.reduce((a, r) => a + r.varianceUsd, 0)), [closingRows]);
  const beyondTolerance = hasAnyClosingInput && (
    closingRows.some(r => Math.abs(r.varianceUsd) > toleranceUsd) || Math.abs(netVarianceUsd) > toleranceUsd
  );

  // Handle close shift
  const handleCloseShift = () => closeShiftGuard.run(async () => {
    if (!openShift) return;

    const hasPendingCashPurchase = loadQueue().some(operation =>
      operation.type === 'quick_purchase' && operation.status !== 'completed' &&
      operation.data.paymentMethod === 'cash' && operation.data.shiftId === openShift.id
    );
    if (hasPendingCashPurchase) {
      toast.error(isEn ? 'Please sync pending cash purchases for this shift before closing.' : 'زامن المشتريات النقدية المعلّقة لهذه الوردية قبل الإقفال.');
      return;
    }

    if (!hasAnyClosingInput) {
      toast.error(t('cashShifts.enterValidAmount'));
      return;
    }

    const currencyClosingsRecord: Record<string, number> = {};
    for (const c of enabledCurrencies) {
      const val = parseFloat(closings[c.code] || '') || 0;
      if (val < 0) {
        toast.error(t('cashShifts.enterValidAmount'));
        return;
      }
      if (val > 0) {
        currencyClosingsRecord[c.code] = val;
      }
    }

    const adjustmentNote = beyondTolerance && varianceDecision === 'accept' ? t('cashShifts.createAdjustment') : undefined;
    const closeCounts = closingRows.map(r => ({ code: r.code, counted: r.counted, rate: r.rate }));
    const closeDecision = varianceDecision;

    // Close dialog immediately for responsive UX
    setShowCloseDialog(false);
    setClosings({});
    setVarianceDecision('accept');

    try {
      const activeDef = enabledCurrencies.find(c => c.code === activeShiftCurrency) || enabledCurrencies[0];
      const activeRate = activeDef ? activeDef.rate : 1;
      const result = closeShiftFn(totalClosingUSD, adjustmentNote, currencyClosingsRecord, activeShiftCurrency, activeRate);

      if (result) {
        const { discrepancy } = result;
        const discrepancyText = discrepancy === 0
          ? t('cashShifts.noDiscrepancy')
          : discrepancy > 0
            ? `${t('cashShifts.surplus')} ${formatMoney(discrepancy, 'USD')}`
            : `${t('cashShifts.shortage')} ${formatMoney(Math.abs(discrepancy), 'USD')}`;

        addActivityLog('shift_closed', userId, userName, `${t('cashShifts.closeShift')} - ${discrepancyText} (${formatMoney(totalClosingUSD, 'USD')})`);
        toast.success(t('cashShifts.shiftClosed'), { description: discrepancyText });

        // مزامنة إغلاق الوردية مع السحابة فورياً
        if (openShift?.id) {
          void closeShiftCloud({
            shiftId: openShift.id,
            expectedBalance: shiftStatus.expectedCash,
            actualBalance: totalClosingUSD,
            varianceReason: adjustmentNote || (discrepancy !== 0 ? discrepancyText : undefined),
            counts: closeCounts,
            decision: closeDecision,
          }).then(() => loadDeferred());
        }
      }
    } catch (err) {
      console.error('[handleCloseShift]', err);
      toast.error(t('cashShifts.enterValidAmount'));
    } finally {
      loadData();
    }
  });

  // Recent shifts (last 10)
  const recentShifts = useMemo(() => {
    return shifts.slice(0, 10);
  }, [shifts]);

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Header */}
      <PageHeader
        title={t('cashShifts.pageTitle')}
        subtitle={t('cashShifts.pageSubtitle')}
        icon={<Wallet className="h-5 w-5 text-primary" />}
        actions={
          <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
            <Button variant="outline" size="sm" onClick={loadData}>
              <RefreshCw className="h-4 w-4" />
              {t('cashShifts.refresh')}
            </Button>
            {openShift ? (
              <Button variant="destructive" size="sm" onClick={() => setShowCloseDialog(true)}>
                <StopCircle className="h-4 w-4" />
                {t('cashShifts.closeShift')}
              </Button>
            ) : (
              <Button size="sm" onClick={() => setShowStartDialog(true)}>
                <PlayCircle className="h-4 w-4" />
                {t('cashShifts.startShift')}
              </Button>
            )}
          </div>
        }
      />

      {/* Current Shift Status */}
      {openShift ? (
        <Card className="border-primary/50 bg-primary/5">
          <CardHeader>
            <div className="flex justify-between items-start">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="h-5 w-5 text-primary animate-pulse" />
                  {t('cashShifts.currentShift')}
                </CardTitle>
                <CardDescription>
                  {t('cashShifts.startedAt')} {formatDateTime(openShift.openedAt)} • {openShift.userName}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowFx(true)}>{isEn ? "Currency Exchange" : "تحويل عملة"}</Button>
                <Badge variant="default" className="bg-green-500">
                  {t('cashShifts.active')}
                </Badge>
              </div>
              <ShiftFxDialog open={showFx} onOpenChange={setShowFx} shiftId={openShift.id} onDone={loadData} />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-background rounded-lg p-4 border">
                <div className="text-sm text-muted-foreground mb-1">{t('cashShifts.openingCash')}</div>
                <div className="text-xl font-bold">{formatUsd(openShift.openingCash)}</div>
              </div>
              <div className="bg-background rounded-lg p-4 border">
                <div className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                  <TrendingUp className="h-4 w-4 text-green-500" />
                  {t('cashShifts.cashSales')}
                </div>
                <div className="text-xl font-bold text-green-600">{formatUsd(shiftStatus.cashSales)}</div>
              </div>
              <div className="bg-background rounded-lg p-4 border">
                <div className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                  <TrendingDown className="h-4 w-4 text-red-500" />
                  {t('cashShifts.cashExpenses')}
                </div>
                <div className="text-xl font-bold text-red-600">{formatUsd(shiftStatus.cashExpenses)}</div>
              </div>
              <div className="bg-background rounded-lg p-4 border border-primary">
                <div className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                  <Banknote className="h-4 w-4 text-primary" />
                  {t('cashShifts.expectedCash')}
                </div>
                <div className="text-xl font-bold text-primary">{formatUsd(shiftStatus.expectedCash)}</div>
              </div>
            </div>

            {/* Detailed Multi-Currency Breakdown */}
            {openShiftCurrencies && (
              <div className="pt-3 border-t">
                <div className="text-sm font-semibold mb-3 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-foreground">
                    <Banknote className="w-4 h-4 text-primary" />
                    {isEn ? "Drawer Cash Breakdown by Currency:" : "تفصيل النقدية بالدرج حسب العملة:"}
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {enabledCurrencies.map((currency) => {
                    const color = currency.code === 'USD' ? 'text-blue-600' : 'text-primary';
                    const data = openShiftCurrencies[currency.code] || { opening: 0, sales: 0, expenses: 0, expected: 0 };
                    const fmt = (amount: number) => formatCurrency(
                      amount,
                      currency.symbol,
                      currency.decimals,
                      currency.code,
                      currency.name
                    );

                    return (
                      <div key={currency.code} className="bg-background rounded-lg p-3 border space-y-2">
                        <div className="flex items-center justify-between font-bold text-sm">
                          <span className={`flex items-center gap-1.5 ${color}`}>
                            <Banknote className="w-4 h-4" /> {getCurrencyDisplayLabel(currency.code, currency.symbol, currency.name)}
                          </span>
                          <Badge variant="outline" className="font-mono text-xs">{currency.code}</Badge>
                        </div>
                        <div className="text-xs space-y-1 text-muted-foreground pt-1">
                          <div className="flex justify-between">
                            <span>{isEn ? "Opening:" : "الافتتاحي:"}</span>
                            <span className="font-medium text-foreground">{fmt(data.opening)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>{isEn ? "Sales & Collections:" : "المبيعات والمقبوضات:"}</span>
                            <span className="font-medium text-green-600">+{fmt(data.sales)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>{isEn ? "Expenses:" : "المصروفات:"}</span>
                            <span className="font-medium text-red-600">-{fmt(data.expenses)}</span>
                          </div>
                          <div className="flex justify-between pt-1 border-t font-bold text-foreground text-sm">
                            <span>{isEn ? "Expected in Drawer:" : "المتوقع بالدرج:"}</span>
                            <span className={`${color} font-mono`}>{fmt(data.expected)}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card className="border-dashed border-2">
          <CardContent className="py-12 text-center">
            <Wallet className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">{t('cashShifts.noOpenShift')}</h3>
            <p className="text-muted-foreground mb-4">{t('cashShifts.startNewShift')}</p>
            <Button onClick={() => setShowStartDialog(true)}>
              <PlayCircle className="h-4 w-4" />
              {t('cashShifts.startShift')}
            </Button>
          </CardContent>
        </Card>
      )}

      {isOwner && deferred.length > 0 && (
        <Card className="border-amber-400">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="w-4 h-4 text-amber-600" /> {isEn ? `Pending Variances (${deferred.length})` : `فروقات بانتظار القرار (${deferred.length})`}</CardTitle>
            <CardDescription>{isEn ? "Shifts closed with a variance above tolerance awaiting owner decision." : "ورديات أُقفلت بفرق أكبر من حد السماح وأُجّل قرارها."}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {deferred.map(d => (
              <div key={d.id} className="rounded-lg border p-3 space-y-2">
                <div className="flex justify-between text-sm">
                  <span>{d.cashier_name || (isEn ? 'Cashier' : 'كاشير')} — {d.closed_at ? formatDateTime(d.closed_at) : ''}</span>
                  <span className={cn('font-mono font-bold', (d.variance || 0) < 0 ? 'text-red-600' : 'text-blue-600')}>{(d.variance || 0) > 0 ? '+' : ''}{formatUsd(d.variance || 0)}</span>
                </div>
                <div className="text-[11px] text-muted-foreground font-mono space-y-0.5">
                  {(d.currency_counts || []).filter(c => c.variance !== 0).map(c => (
                    <div key={c.code}>{c.code}: {isEn ? 'Expected' : 'متوقع'} {c.expected} / {isEn ? 'Counted' : 'معدود'} {c.counted} / {isEn ? 'Diff' : 'فرق'} {c.variance > 0 ? '+' : ''}{c.variance}</div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={async () => {
                    const r = await resolveShiftVarianceCloud(d.id, 'accept', isEn ? 'Approved by owner' : 'اعتماد من المالك');
                    if (r.ok) { toast.success(isEn ? 'Variance recorded in cashbox' : 'سُجّل الفرق في الصندوق'); loadDeferred(); } else toast.error(r.error || (isEn ? 'Action failed' : 'تعذر التنفيذ'));
                  }}>{isEn ? "Approve & Record Variance" : "اعتماد وتسجيل الفرق"}</Button>
                  <Button size="sm" variant="outline" onClick={() => {
                    setDismissNote('');
                    setDismissTarget(d.id);
                  }}>{isEn ? "Dismiss Without Recording" : "إغلاق دون تسجيل"}</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Recent Shifts */}
      <Card>
        <CardHeader>
          <CardTitle>{t('cashShifts.recentShifts')}</CardTitle>
          <CardDescription>{t('cashShifts.last10Shifts')}</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoadingCloud && recentShifts.length === 0 ? (
            <ListPageSkeleton rows={4} />
          ) : recentShifts.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {t('cashShifts.noShifts')}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('cashShifts.user')}</TableHead>
                    <TableHead>{t('cashShifts.openTime')}</TableHead>
                    <TableHead>{t('cashShifts.closeTime')}</TableHead>
                    <TableHead>{t('cashShifts.opening')}</TableHead>
                    <TableHead>{t('cashShifts.sales')}</TableHead>
                    <TableHead>{t('cashShifts.expected')}</TableHead>
                    <TableHead>{t('cashShifts.actual')}</TableHead>
                    <TableHead>{t('cashShifts.discrepancy')}</TableHead>
                    <TableHead>{isEn ? "Adjustments" : "التعديلات"}</TableHead>
                    <TableHead>{t('common.status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentShifts.map((shift) => (
                    <TableRow key={shift.id}>
                      <TableCell className="font-medium">{shift.userName}</TableCell>
                      <TableCell className="text-sm">{formatDateTime(shift.openedAt)}</TableCell>
                      <TableCell className="text-sm">
                        {shift.closedAt ? formatDateTime(shift.closedAt) : '-'}
                      </TableCell>
                      <TableCell>{formatUsd(shift.openingCash)}</TableCell>
                      <TableCell className="text-green-600">
                        {formatUsd(shift.salesTotal)}
                      </TableCell>
                      <TableCell>{formatUsd(shift.expectedCash || 0)}</TableCell>
                      <TableCell>
                        {shift.closingCash !== undefined ? formatUsd(shift.closingCash) : '-'}
                      </TableCell>
                      <TableCell>
                        {shift.discrepancy !== undefined ? (
                          <span className={
                            shift.discrepancy === 0
                              ? 'text-muted-foreground'
                              : shift.discrepancy > 0
                                ? 'text-green-600'
                                : 'text-red-600'
                          }>
                            {shift.discrepancy > 0 ? '+' : ''}{formatUsd(shift.discrepancy)}
                          </span>
                        ) : '-'}
                      </TableCell>
                      <TableCell>
                        {shift.adjustments && shift.adjustments.length > 0 ? (
                          <div className="space-y-1">
                            {shift.adjustments.map(adj => (
                              <Badge key={adj.id} variant={adj.type === 'expense_added' ? 'destructive' : 'secondary'} className="text-xs">
                                {adj.type === 'expense_added' ? (isEn ? 'Expense' : 'مصروف') : (isEn ? 'Income' : 'إيراد')} {formatUsd(adj.amount)}
                              </Badge>
                            ))}
                          </div>
                        ) : '-'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={shift.status === 'open' ? 'default' : 'secondary'}>
                          {shift.status === 'open' ? t('cashShifts.status.open') : t('cashShifts.status.closed')}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Start Shift Dialog */}
      <Dialog open={showStartDialog} onOpenChange={setShowStartDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PlayCircle className="h-5 w-5 text-primary" />
              {t('cashShifts.startShiftTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('cashShifts.startShiftDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-3">
            <div className="text-xs text-muted-foreground">
              {isEn ? "Enter the opening cash available in the drawer for each currency:" : "أدخل الرصيد الافتتاحي المتوفر في درج الكاشير لكل عملة:"}
            </div>

            <div className="space-y-2.5 max-h-[50vh] overflow-y-auto pr-1">
              {enabledCurrencies.map((curr) => {
                const val = openings[curr.code] || '';
                const numVal = parseFloat(val) || 0;
                const usdEq = numVal > 0 ? toUsd(numVal, curr.code, curr.rate) : 0;
                return (
                  <div key={curr.code} className="space-y-1 p-2.5 rounded-xl border border-border/60 bg-muted/20">
                    <div className="flex items-center justify-between">
                      <Label htmlFor={`opening_${curr.code}`} className="text-xs font-semibold flex items-center gap-1.5">
                        <Banknote className="w-3.5 h-3.5 text-primary" />
                        <span>{getCurrencyDisplayLabel(curr.code, curr.symbol, curr.name)}</span>
                      </Label>
                      {curr.code !== 'USD' && (
                        <span className="text-[11px] text-muted-foreground font-mono">                        1$ = {curr.rate} {getCurrencyDisplayLabel(curr.code, curr.symbol, curr.name)}</span>
                      )}
                    </div>
                    <Input
                      id={`opening_${curr.code}`}
                      type="number"
                      min="0"
                      step={curr.decimals === 0 ? (curr.rate >= 1000 ? "500" : "1") : curr.decimals === 3 ? "0.001" : "0.01"}
                      value={val}
                      onChange={(e) => setOpenings(prev => ({ ...prev, [curr.code]: e.target.value }))}
                      placeholder={`0 ${getCurrencyDisplayLabel(curr.code, curr.symbol, curr.name)}`}
                      className="font-mono text-base bg-background"
                    />
                    {val !== '' && (() => {
                      const row = closingRows.find(r => r.code === curr.code);
                      if (!row || row.variance === 0) return null;
                      return (
                        <div className={cn('text-[11px] font-mono font-bold', Math.abs(row.varianceUsd) > toleranceUsd ? 'text-red-600' : 'text-amber-600')}>
                          {row.variance > 0 ? (isEn ? 'Surplus' : 'زيادة') : (isEn ? 'Shortage' : 'نقص')} {formatCurrency(Math.abs(row.variance), curr.symbol, curr.decimals, curr.code, curr.name)}
                          {curr.code !== 'USD' && <> (≈ ${formatNumber(Math.abs(row.varianceUsd), 2)})</>}
                        </div>
                      );
                    })()}
                    {numVal > 0 && curr.code !== 'USD' && (
                      <div className="text-[10.5px] text-muted-foreground font-mono">
                        {isEn ? "Equals" : "يعادل"} ${formatNumber(usdEq, 2)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Total USD preview */}
            <div className="bg-primary/10 rounded-lg p-3 text-sm flex items-center justify-between border border-primary/20">
              <span className="font-semibold text-primary">{isEn ? "Total Opening (USD):" : "إجمالي الافتتاحي بالدولار:"}</span>
              <span className="font-bold text-lg font-mono text-primary">
                ${totalOpeningUSD.toFixed(2)}
              </span>
            </div>

            <div className="bg-muted/50 rounded-lg p-3 text-xs text-muted-foreground flex justify-between items-center">
              <span><strong>{t('cashShifts.employee')}:</strong> {userName}</span>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowStartDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleStartShift}>
              {t('cashShifts.startShift')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close Shift Dialog */}
      <Dialog open={showCloseDialog} onOpenChange={setShowCloseDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <StopCircle className="h-5 w-5 text-destructive" />
              {t('cashShifts.closeShiftTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('cashShifts.closeShiftDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-3 max-h-[70vh] overflow-y-auto pr-1">
            {/* Quick Fill Button */}
            <div className="flex items-center justify-between bg-muted/40 p-2.5 rounded-lg border">
              <span className="text-xs text-muted-foreground">{isEn ? "Quickly fill actual amounts matching expected totals:" : "لإدخال المبالغ الفعلية المطابقة للحساب فوراً:"}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs h-7"
                onClick={() => {
                  if (openShiftCurrencies) {
                    const matched: Record<string, string> = {};
                    enabledCurrencies.forEach(c => {
                      const exp = openShiftCurrencies[c.code]?.expected ?? (c.code === 'USD' ? shiftStatus.expectedCash : 0);
                      matched[c.code] = exp.toString();
                    });
                    setClosings(matched);
                  } else {
                    setClosings({ USD: shiftStatus.expectedCash.toString() });
                  }
                }}
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                {isEn ? "Match Expected" : "مطابقة مع المتوقع"}
              </Button>
            </div>

            {/* Inputs per currency — ديناميكي لجميع العملات المفعلة */}
            <div className="space-y-3">
              {enabledCurrencies.map((curr) => {
                const val = closings[curr.code] || '';
                const numVal = parseFloat(val) || 0;
                const usdEq = numVal > 0 ? toUsd(numVal, curr.code, curr.rate) : 0;
                const exp = openShiftCurrencies?.[curr.code]?.expected ?? (curr.code === 'USD' ? shiftStatus.expectedCash : 0);
                return (
                  <div key={curr.code} className="p-3 rounded-lg border bg-background space-y-1.5">
                    <div className="flex justify-between items-center text-xs">
                      <Label htmlFor={`closing_${curr.code}`} className="font-semibold flex items-center gap-1.5 text-primary">
                        <Banknote className="w-3.5 h-3.5" /> {getCurrencyDisplayLabel(curr.code, curr.symbol, curr.name)}
                      </Label>
                      <span className="text-muted-foreground text-[11px]">
                        {isEn ? "Expected:" : "المتوقع:"} <strong className="text-foreground font-mono">{formatCurrency(exp, curr.symbol, curr.decimals, curr.code, curr.name)}</strong>
                      </span>
                    </div>
                    <Input
                      id={`closing_${curr.code}`}
                      type="number"
                      min="0"
                      step={curr.decimals === 0 ? "1" : curr.decimals === 3 ? "0.001" : "0.01"}
                      value={val}
                      onChange={(e) => setClosings(prev => ({ ...prev, [curr.code]: e.target.value }))}
                      placeholder={`0 ${getCurrencyDisplayLabel(curr.code, curr.symbol, curr.name)}`}
                      className="font-mono text-base"
                    />
                    {numVal > 0 && curr.code !== 'USD' && (
                      <div className="text-[10.5px] text-muted-foreground font-mono mt-1">
                        {isEn ? "Equals" : "يعادل"} ${formatNumber(usdEq, 2)} — {isEn ? "Rate 1$ =" : "سعر الصرف 1$ ="} {curr.rate} {getCurrencyDisplayLabel(curr.code, curr.symbol, curr.name)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Summary & Discrepancy Preview */}
            {hasAnyClosingInput && (
              <div className="space-y-2">
                {/* Currency toggle pills for closing summary */}
                <div className="flex items-center gap-1.5 p-1 rounded-xl bg-muted/50 border">
                  <span className="text-[11px] text-muted-foreground px-2 font-medium">{isEn ? "Show closing summary in:" : "عرض ملخص الإغلاق بـ:"}</span>
                  {enabledCurrencies.map(curr => {
                    return (
                      <button
                        key={curr.code}
                        type="button"
                        onClick={() => setActiveShiftCurrency(curr.code)}
                        className={cn(
                          "rounded-full h-7 px-3 text-xs font-bold transition-all select-none cursor-pointer",
                          activeShiftCurrency === curr.code
                            ? "bg-primary text-primary-foreground shadow-xs"
                            : "bg-muted text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {getCurrencyDisplayLabel(curr.code, curr.symbol, curr.name)}
                      </button>
                    );
                  })}
                </div>

                <div className="bg-muted/60 rounded-xl p-3 text-xs space-y-1.5 border">
                  {(() => {
                    const activeCurrency = enabledCurrencies.find(c => c.code === activeShiftCurrency) || enabledCurrencies[0];
                    if (!activeCurrency) return null;
                    const formatActiveAmount = (amount: number) => formatCurrency(
                      amount,
                      activeCurrency.symbol,
                      activeCurrency.decimals,
                      activeCurrency.code,
                      activeCurrency.name
                    );

                    return (
                      <>
                        <div className="flex justify-between items-center text-muted-foreground">
                          <span>{isEn ? "Total Expected:" : "المتوقع الإجمالي:"}</span>
                          <div className="text-start">
                            <span className="font-mono font-bold text-foreground text-sm">
                              {formatUsd(shiftStatus.expectedCash)}
                            </span>
                            {activeCurrency.code !== 'USD' && (
                              <span className="block text-[10.5px] font-mono text-muted-foreground">
                                = {formatActiveAmount(fromUsd(shiftStatus.expectedCash, activeCurrency.code, activeCurrency.rate))}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex justify-between items-center text-muted-foreground pt-1 border-t border-border/40">
                          <span>{isEn ? "Actual Counted:" : "الفعلي المعدود:"}</span>
                          <div className="text-start">
                            <span className="font-mono font-bold text-foreground text-sm">
                              {formatUsd(totalClosingUSD)}
                            </span>
                            {activeCurrency.code !== 'USD' && (
                              <span className="block text-[10.5px] font-mono text-muted-foreground">
                                = {formatActiveAmount(fromUsd(totalClosingUSD, activeCurrency.code, activeCurrency.rate))}
                              </span>
                            )}
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </div>

                <div className={`rounded-xl p-4 border-2 ${previewDiscrepancy === 0
                    ? 'bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800'
                    : previewDiscrepancy > 0
                      ? 'bg-blue-50 border-blue-200 dark:bg-blue-950 dark:border-blue-800'
                      : 'bg-red-50 border-red-200 dark:bg-red-950 dark:border-red-800'
                  }`}>
                  <div className="flex items-center gap-2 mb-1">
                    {previewDiscrepancy === 0 ? (
                      <CheckCircle2 className="h-5 w-5 text-green-600" />
                    ) : previewDiscrepancy > 0 ? (
                      <TrendingUp className="h-5 w-5 text-blue-600" />
                    ) : (
                      <AlertTriangle className="h-5 w-5 text-red-600" />
                    )}
                    <span className="font-semibold text-sm">
                      {previewDiscrepancy === 0
                        ? t('cashShifts.noDiscrepancy')
                        : previewDiscrepancy > 0
                          ? t('cashShifts.surplus')
                          : t('cashShifts.shortage')}
                    </span>
                  </div>
                  <div className={`text-2xl font-bold font-mono ${previewDiscrepancy === 0
                      ? 'text-green-600'
                      : previewDiscrepancy > 0
                        ? 'text-blue-600'
                        : 'text-red-600'
                    }`}>
                    {previewDiscrepancy > 0 ? '+' : ''}{formatUsd(previewDiscrepancy)}
                  </div>
                  {activeShiftCurrency !== 'USD' && (() => {
                    const activeCurrency = enabledCurrencies.find(c => c.code === activeShiftCurrency);
                    return activeCurrency ? (
                    <div className="text-xs font-mono font-bold text-muted-foreground mt-0.5">
                      = {previewDiscrepancy > 0 ? '+' : ''}{formatCurrency(
                        fromUsd(previewDiscrepancy, activeCurrency.code, activeCurrency.rate),
                        activeCurrency.symbol,
                        activeCurrency.decimals,
                        activeCurrency.code,
                        activeCurrency.name
                      )}
                    </div>
                    ) : null;
                  })()}
                </div>
              </div>
            )}

            {Number((openShift as any)?.digitalTotal || 0) > 0 && (
              <div className="rounded-lg border p-3 text-xs">
                {isEn ? "Digital Sales (not in cash drawer):" : "مبيعات دفع رقمي (لا تدخل درج النقد):"} <b>{formatUsd(Number((openShift as any).digitalTotal))}</b>
              </div>
            )}

            {supplierMoney && (supplierMoney.drawerPaid + supplierMoney.drawerRefunded + supplierMoney.externalPaid + supplierMoney.externalRefunded) > 0 && (
              <div className="rounded-lg border p-3 text-xs space-y-1">
                <div className="font-semibold">{isEn ? "Supplier Payments During This Shift" : "دفعات الموردين خلال هذه الوردية"}</div>
                {supplierMoney.drawerPaid > 0 && <div>{isEn ? "Paid from drawer:" : "مدفوع من الصندوق (الغلة):"} <b>{formatUsd(supplierMoney.drawerPaid)}</b> — {isEn ? "included in expected balance" : "محسوب ضمن المتوقع في الصندوق"}</div>}
                {supplierMoney.drawerRefunded > 0 && <div>{isEn ? "Refunded by suppliers to drawer:" : "مسترد من موردين إلى الصندوق:"} <b>{formatUsd(supplierMoney.drawerRefunded)}</b></div>}
                {supplierMoney.externalPaid > 0 && <div className="text-muted-foreground">{isEn ? "Paid externally:" : "مدفوع من مصدر خارجي:"} {formatUsd(supplierMoney.externalPaid)} — {isEn ? "does not affect drawer" : "لا يؤثر على الصندوق"}</div>}
                {supplierMoney.externalRefunded > 0 && <div className="text-muted-foreground">{isEn ? "Refunded externally:" : "مسترد خارج الصندوق:"} {formatUsd(supplierMoney.externalRefunded)}</div>}
              </div>
            )}

            {/* قرار الفرق: ضمن حد السماح أو أكبر منه */}
            {hasAnyClosingInput && !beyondTolerance && closingRows.some(r => r.variance !== 0) && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-300">
                {isEn ? `Variance is within tolerance (up to ${formatUsd(toleranceUsd)}) — accepted as rounding difference.` : `الفرق ضمن حد السماح (حتى ${formatUsd(toleranceUsd)}) — يُعتمد كفرق تقريب دون إجراء إضافي.`}
              </div>
            )}
            {beyondTolerance && (
              <div className="rounded-lg border-2 border-red-300 p-3 space-y-2">
                <div className="text-xs font-semibold text-red-700 dark:text-red-400">
                  {isEn ? `Variance exceeds tolerance (${formatUsd(toleranceUsd)}). Net diff:` : `الفرق أكبر من حد السماح (${formatUsd(toleranceUsd)}). صافي الفرق:`} {netVarianceUsd > 0 ? '+' : ''}{formatUsd(netVarianceUsd)}
                </div>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input type="radio" name="varianceDecision" checked={varianceDecision === 'accept'} onChange={() => setVarianceDecision('accept')} className="mt-1" />
                  <span>{isEn ? "Record variance now as cashbox surplus/shortage" : "تسجيل الفرق الآن كفائض أو عجز في الصندوق"}</span>
                </label>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input type="radio" name="varianceDecision" checked={varianceDecision === 'defer'} onChange={() => setVarianceDecision('defer')} className="mt-1" />
                  <span>{isEn ? "Defer decision to owner (not recorded now; appears under Pending Variances)" : "تأجيل القرار للمالك (لا يُسجَّل شيء الآن ويظهر في «فروقات بانتظار القرار»)"}</span>
                </label>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCloseDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleCloseShift} disabled={closeShiftGuard.isRunning}>
              {closeShiftGuard.isRunning && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('cashShifts.closeShift')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!dismissTarget} onOpenChange={(o) => { if (!o) setDismissTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{isEn ? "Dismiss Variance Without Recording" : "إغلاق الفرق دون تسجيل"}</DialogTitle>
            <DialogDescription>{isEn ? "No surplus or shortage will be recorded. Enter a clear reason for audit tracking." : "لن يُسجَّل أي فائض أو عجز. اكتب سبباً واضحاً للتوثيق."}</DialogDescription>
          </DialogHeader>
          <Input value={dismissNote} onChange={(e) => setDismissNote(e.target.value)} placeholder={isEn ? "Reason (required)" : "السبب (إلزامي)"} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDismissTarget(null)}>{isEn ? "Cancel" : "إلغاء"}</Button>
            <Button disabled={!dismissNote.trim()} onClick={async () => {
              if (!dismissTarget) return;
              const r = await resolveShiftVarianceCloud(dismissTarget, 'dismiss', dismissNote.trim());
              if (r.ok) { toast.success(isEn ? 'Variance closed' : 'أُغلق الفرق'); setDismissTarget(null); loadDeferred(); } else toast.error(r.error || (isEn ? 'Action failed' : 'تعذر التنفيذ'));
            }}>{isEn ? "Confirm" : "تأكيد"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
