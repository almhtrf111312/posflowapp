// Cash Box (الصندوق) Page - Shift Management & Reconciliation
import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Wallet, Clock, Play, Square, AlertTriangle, CheckCircle,
  TrendingUp, TrendingDown, DollarSign, ArrowUpRight, ArrowDownRight,
  History, Calculator, RefreshCw
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { PageHeader } from '@/components/layout/PageHeader';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/lib/sonner-bridge';
import { useAuth } from '@/hooks/auth-context';
import { useLanguage } from '@/hooks/language-context';
import { useMoney } from '@/hooks/use-money';
import { addActivityLog } from '@/lib/activity-log';
import { formatNumber, formatCurrency, formatDateTime, formatDate, formatTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import {
  loadCashboxState,
  loadShifts,
  getActiveShift,
  openShift,
  closeShift,
  getShiftStats,
  addShiftAdjustment,
  Shift,
} from '@/lib/cashbox-store';
import { EVENTS } from '@/lib/events';
import { openShiftCloud, closeShiftCloud, loadCloudShifts } from '@/lib/cloud/cashbox-cloud';

export default function Cashbox() {
  const { user, profile } = useAuth();
  const { language } = useLanguage();
  const isEn = language === 'en';
  const m = useMoney();
  const [cashboxState, setCashboxState] = useState(loadCashboxState());
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [activeShift, setActiveShift] = useState<Shift | null>(null);

  // Dialog states
  const [showOpenDialog, setShowOpenDialog] = useState(false);
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);

  // Form states
  const [openingAmount, setOpeningAmount] = useState('');
  const [closingAmount, setClosingAmount] = useState('');
  const [closingNotes, setClosingNotes] = useState('');

  // Load data
  const loadData = () => {
    setCashboxState(loadCashboxState());
    setShifts(loadShifts());
    setActiveShift(getActiveShift());

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
    }).catch(() => {});
  };

  // Always call the latest loadData (it closes over the current language) without re-subscribing every render
  const loadDataRef = useRef(loadData);
  loadDataRef.current = loadData;

  useEffect(() => {
    loadDataRef.current();

    // Listen for updates
    const handleUpdate = () => loadDataRef.current();
    window.addEventListener(EVENTS.CASHBOX_UPDATED, handleUpdate);
    window.addEventListener(EVENTS.SHIFTS_UPDATED, handleUpdate);
    window.addEventListener(EVENTS.INVOICES_UPDATED, handleUpdate);
    window.addEventListener(EVENTS.CASH_SHIFTS_UPDATED, handleUpdate);

    return () => {
      window.removeEventListener(EVENTS.CASHBOX_UPDATED, handleUpdate);
      window.removeEventListener(EVENTS.SHIFTS_UPDATED, handleUpdate);
      window.removeEventListener(EVENTS.INVOICES_UPDATED, handleUpdate);
      window.removeEventListener(EVENTS.CASH_SHIFTS_UPDATED, handleUpdate);
    };
  }, []);

  // Calculate expected closing cash
  const expectedClosing = useMemo(() => {
    if (!activeShift) return 0;
    return activeShift.openingCash + activeShift.salesTotal + activeShift.depositsTotal
      - activeShift.expensesTotal - activeShift.withdrawalsTotal;
  }, [activeShift]);

  // Stats
  // `shifts` is an intentional refresh trigger: getShiftStats() reads the shifts store directly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stats = useMemo(() => getShiftStats(), [shifts]);

  // Handlers
  const handleOpenShift = () => {
    const amount = parseFloat(openingAmount);
    if (isNaN(amount) || amount < 0) {
      toast.error(isEn ? 'Please enter a valid amount' : 'يرجى إدخال مبلغ صحيح');
      return;
    }

    const userName = profile?.full_name || user?.email || (isEn ? 'User' : 'مستخدم');
    const userId = user?.id || '';

    const newShift = openShift(amount, userId, userName);
    if (newShift?.id) {
      void openShiftCloud({
        shiftId: newShift.id,
        cashierId: userId,
        cashierName: userName,
        openingBalance: amount,
      });
    }

    addActivityLog(
      'shift_opened',
      userId,
      userName,
      isEn ? `Opened new shift with opening balance ${m.fmt(amount)}` : `تم فتح وردية جديدة برصيد افتتاحي ${m.fmt(amount)}`,
      { openingCash: amount }
    );

    toast.success(isEn ? 'Shift opened successfully' : 'تم فتح الوردية بنجاح');
    setShowOpenDialog(false);
    setOpeningAmount('');
    loadData();
  };

  const handleCloseShift = () => {
    const amount = parseFloat(closingAmount);
    if (isNaN(amount) || amount < 0) {
      toast.error(isEn ? 'Please enter a valid amount' : 'يرجى إدخال مبلغ صحيح');
      return;
    }

    const result = closeShift(amount, closingNotes);

    if (!result) {
      toast.error(isEn ? 'No open shift' : 'لا توجد وردية مفتوحة');
      return;
    }

    if (result.shift?.id) {
      void closeShiftCloud({
        shiftId: result.shift.id,
        expectedBalance: result.shift.expectedCash || 0,
        actualBalance: amount,
        varianceReason: closingNotes || undefined,
      });
    }

    const userName = profile?.full_name || user?.email || (isEn ? 'User' : 'مستخدم');
    const userId = user?.id || '';

    addActivityLog(
      'shift_closed',
      userId,
      userName,
      isEn ? `Shift closed - Variance: ${m.fmt(result.discrepancy)}` : `تم إغلاق الوردية - الفارق: ${m.fmt(result.discrepancy)}`,
      {
        closingCash: amount,
        expectedCash: result.shift.expectedCash,
        discrepancy: result.discrepancy
      }
    );

    if (result.discrepancy !== 0) {
      const type = result.discrepancy > 0 ? (isEn ? 'Surplus' : 'فائض') : (isEn ? 'Shortage' : 'عجز');
      toast.warning(isEn ? `Shift closed with ${type}: ${m.fmt(Math.abs(result.discrepancy))}` : `تم إغلاق الوردية مع ${type}: ${m.fmt(Math.abs(result.discrepancy))}`);
    } else {
      toast.success(isEn ? 'Shift closed successfully - Cashbox balanced' : 'تم إغلاق الوردية بنجاح - الصندوق متطابق');
    }

    setShowCloseDialog(false);
    setClosingAmount('');
    setClosingNotes('');
    loadData();
  };

  return (
    <div className="p-3 sm:p-4 md:p-6 space-y-4 md:space-y-6">
      <PageHeader
        title={isEn ? "Shift Cashbox" : "صندوق الوردية"}
        icon={<Wallet className="w-5 h-5" />}
        actions={
          <>
            <Button
              variant="outline"
              size="default"
              onClick={() => setShowHistoryDialog(true)}
            >
              <History className="w-4 h-4 shrink-0" />
              <span>{isEn ? "Shift History" : "سجل الورديات"}</span>
            </Button>
            {activeShift ? (
              <Button
                variant="destructive"
                size="default"
                onClick={() => setShowCloseDialog(true)}
              >
                <Square className="w-4 h-4 shrink-0 fill-current" />
                <span>{isEn ? "Close Shift" : "إغلاق الوردية"}</span>
              </Button>
            ) : (
              <Button
                variant="default"
                size="default"
                onClick={() => setShowOpenDialog(true)}
              >
                <Play className="w-4 h-4 shrink-0 fill-current" />
                <span>{isEn ? "Open New Shift Now" : "فتح وردية جديدة الآن"}</span>
              </Button>
            )}
          </>
        }
      />

      {/* Top Section: Shift Card (Closed or Active) */}
      {!activeShift ? (
        <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20 space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-warning/15 text-warning flex items-center justify-center">
            <Clock className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-bold text-foreground">{isEn ? "No Open Shifts Right Now" : "لا توجد ورديات مفتوحة حالياً"}</h2>
            <p className="text-xs sm:text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              {isEn ? "Start a new shift to accurately track cash sales, collections, and drawer expenses" : "ابدأ وردية جديدة لتسجيل ومتابعة المبيعات، المقبوضات، والمصروفات النقدية للصندوق بدقة"}
            </p>
          </div>
          <Button
            variant="default"
            size="default"
            onClick={() => setShowOpenDialog(true)}
          >
            <Play className="w-4 h-4 shrink-0 fill-current" />
            <span>{isEn ? "Open New Shift Now" : "فتح وردية جديدة الآن"}</span>
          </Button>
        </div>
      ) : (
        <Card className="border border-border/80 rounded-2xl overflow-hidden shadow-xs">
          <CardHeader className="p-4 sm:p-5 pb-3 border-b border-border/50 bg-muted/20">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-success/15 text-success flex items-center justify-center shrink-0">
                  <Clock className="w-4 h-4" />
                </div>
                <div>
                  <CardTitle className="flex items-center gap-2">{isEn ? "Current Open Shift" : "الوردية الحالية المفتوحة"}</CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {isEn ? "Cashier:" : "المسؤول:"} <span className="font-semibold text-foreground">{activeShift.userName}</span> • {isEn ? "Started:" : "بدأت:"} <span dir="ltr" className="inline-block font-mono tabular-nums">{formatDateTime(activeShift.openedAt)}</span>
                  </p>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <div className="bg-muted/50 rounded-xl p-3 border border-border/40">
                <p className="text-xs text-muted-foreground">{isEn ? "Opening Balance" : "رصيد الافتتاح"}</p>
                <p className="text-sm sm:text-base font-bold text-foreground font-mono mt-0.5">
                  <span dir="ltr" className="inline-block tabular-nums">{m.fmt(activeShift.openingCash)}</span>
                </p>
              </div>

              <div className="bg-muted/50 rounded-xl p-3 border border-border/40">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <ArrowUpRight className="w-3 h-3 text-success" />
                  {isEn ? "Sales" : "المبيعات"}
                </p>
                <p className="text-sm sm:text-base font-bold text-success font-mono mt-0.5">
                  <span dir="ltr" className="inline-block tabular-nums">+{m.fmt(activeShift.salesTotal)}</span>
                </p>
              </div>

              <div className="bg-muted/50 rounded-xl p-3 border border-border/40">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <ArrowUpRight className="w-3 h-3 text-success" />
                  {isEn ? "Deposits" : "الإيداعات"}
                </p>
                <p className="text-sm sm:text-base font-bold text-success font-mono mt-0.5">
                  <span dir="ltr" className="inline-block tabular-nums">+{m.fmt(activeShift.depositsTotal)}</span>
                </p>
              </div>

              <div className="bg-muted/50 rounded-xl p-3 border border-border/40">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <ArrowDownRight className="w-3 h-3 text-destructive" />
                  {isEn ? "Expenses" : "المصاريف"}
                </p>
                <p className="text-sm sm:text-base font-bold text-destructive font-mono mt-0.5">
                  <span dir="ltr" className="inline-block tabular-nums">-{m.fmt(activeShift.expensesTotal)}</span>
                </p>
              </div>

              <div className="bg-muted/50 rounded-xl p-3 border border-border/40">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <ArrowDownRight className="w-3 h-3 text-destructive" />
                  {isEn ? "Withdrawals" : "السحوبات"}
                </p>
                <p className="text-sm sm:text-base font-bold text-destructive font-mono mt-0.5">
                  <span dir="ltr" className="inline-block tabular-nums">-{m.fmt(activeShift.withdrawalsTotal)}</span>
                </p>
              </div>

              <div className="bg-primary/10 rounded-xl p-3 border border-primary/30">
                <p className="text-xs text-primary font-bold flex items-center gap-1">
                  <Calculator className="w-3 h-3" />
                  {isEn ? "Expected Balance" : "الرصيد المتوقع"}
                </p>
                <p className="text-sm sm:text-base font-bold text-primary font-mono mt-0.5">
                  <span dir="ltr" className="inline-block tabular-nums">{m.fmt(expectedClosing)}</span>
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Compact 4-Metric Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 text-center select-none">
        <div className="bg-card p-3 rounded-xl border border-border shadow-xs">
          <span className="text-xs text-muted-foreground font-medium block truncate">{isEn ? "Shift Status" : "حالة الوردية"}</span>
          <span className={cn(
            "text-sm sm:text-base font-bold tabular-nums block mt-0.5",
            activeShift ? "text-success" : "text-warning"
          )}>
            {activeShift ? (isEn ? 'Open' : 'مفتوحة') : (isEn ? 'Closed' : 'مغلقة')}
          </span>
        </div>
        <div className="bg-card p-3 rounded-xl border border-border shadow-xs">
          <span className="text-xs text-primary font-medium block truncate">{isEn ? "Current Balance" : "الرصيد الحالي"}</span>
          <span dir="ltr" className="inline-block text-sm sm:text-base font-bold text-primary font-mono tabular-nums mt-0.5">
            {m.fmt(cashboxState.currentBalance)}
          </span>
        </div>
        <div className="bg-card p-3 rounded-xl border border-border shadow-xs">
          <span className="text-xs text-success font-medium block truncate">{isEn ? "Total Surplus" : "إجمالي الفائض"}</span>
          <span dir="ltr" className="inline-block text-sm sm:text-base font-bold text-success font-mono tabular-nums mt-0.5">
            {m.fmt(stats.totalSurplus)}
          </span>
        </div>
        <div className="bg-card p-3 rounded-xl border border-border shadow-xs">
          <span className="text-xs text-destructive font-medium block truncate">{isEn ? "Total Shortage" : "إجمالي العجز"}</span>
          <span dir="ltr" className="inline-block text-sm sm:text-base font-bold text-destructive font-mono tabular-nums mt-0.5">
            {m.fmt(stats.totalShortage)}
          </span>
        </div>
      </div>

      {/* Recent Shifts */}
      <Card>
        <CardHeader className="p-4 sm:p-5 pb-3">
          <CardTitle className="flex items-center gap-2">
            <History className="w-5 h-5 text-primary" />
            {isEn ? "Recent Shifts" : "آخر الورديات"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {shifts.filter(s => s.status === 'closed').slice(0, 5).length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
              <Clock className="w-12 h-12 text-muted-foreground/50 mb-3" />
              <p className="text-sm sm:text-base font-semibold text-foreground">{isEn ? "No closed shifts yet" : "لا توجد ورديات مغلقة"}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {shifts.filter(s => s.status === 'closed').slice(0, 5).map(shift => (
                <div key={shift.id} className="flex items-center justify-between p-4 bg-muted rounded-xl">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{shift.userName}</span>
                      <Badge variant={shift.discrepancy === 0 ? 'default' : shift.discrepancy! > 0 ? 'secondary' : 'destructive'}>
                        {shift.discrepancy === 0 ? (isEn ? 'Balanced' : 'متطابق') : shift.discrepancy! > 0 ? (isEn ? 'Surplus' : 'فائض') : (isEn ? 'Shortage' : 'عجز')}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      {formatDate(shift.openedAt)}
                      {' • '}
                      {formatTime(shift.openedAt)}
                      {' - '}
                      {shift.closedAt && formatTime(shift.closedAt)}
                    </p>
                  </div>

                  <div className="text-end">
                    <p className="text-sm text-muted-foreground">{isEn ? "Sales" : "المبيعات"}</p>
                    <p className="font-bold text-success"><span dir="ltr" className="inline-block tabular-nums">{m.fmt(shift.salesTotal)}</span></p>
                  </div>

                  <div className="text-end ms-4">
                    <p className="text-sm text-muted-foreground">{isEn ? "Variance" : "الفارق"}</p>
                    <p className={cn(
                      "font-bold",
                      shift.discrepancy === 0 ? "text-foreground" : shift.discrepancy! > 0 ? "text-success" : "text-destructive"
                    )}>
                      <span dir="ltr" className="inline-block tabular-nums">{shift.discrepancy === 0 ? '0' : (shift.discrepancy! > 0 ? '+' : '') + m.fmt(shift.discrepancy!)}</span>
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Open Shift Dialog */}
      <Dialog open={showOpenDialog} onOpenChange={setShowOpenDialog}>
        <DialogContent
          className="w-[min(calc(100vw-1.5rem),28rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]"
          onPointerDownOutside={(e) => { if (openingAmount) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (openingAmount) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <DialogTitle className="flex items-center gap-2">
              <Play className="w-5 h-5 text-primary" />
              {isEn ? "Open New Shift" : "فتح وردية جديدة"}
            </DialogTitle>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label>{isEn ? "Opening Balance" : "الرصيد الافتتاحي"}</Label>
              <Input
                dir="ltr"
                className="tabular-nums"
                type="number"
                value={openingAmount}
                onChange={(e) => setOpeningAmount(e.target.value)}
                placeholder={isEn ? "Enter opening cash amount" : "أدخل المبلغ الموجود في الصندوق"}
                min="0"
                step="0.01"
              />
              <p className="text-xs text-muted-foreground">
                {isEn ? "Enter the actual cash currently in the drawer when starting the shift" : "أدخل المبلغ النقدي الموجود فعلياً في الصندوق عند بدء الوردية"}
              </p>
            </div>
          </DialogBody>

          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
            <Button variant="outline" size="default" onClick={() => setShowOpenDialog(false)}>
              {isEn ? 'Cancel' : 'إلغاء'}
            </Button>
            <Button variant="default" size="default" onClick={handleOpenShift}>
              {isEn ? "Open Shift" : "فتح الوردية"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close Shift Dialog */}
      <Dialog open={showCloseDialog} onOpenChange={setShowCloseDialog}>
        <DialogContent
          className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]"
          onPointerDownOutside={(e) => { if (closingAmount || closingNotes) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (closingAmount || closingNotes) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <DialogTitle className="flex items-center gap-2">
              <Square className="w-5 h-5 text-destructive" />
              {isEn ? 'Close Shift' : 'إغلاق الوردية'}
            </DialogTitle>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {/* Expected vs Actual */}
            <div className="bg-muted rounded-xl p-4">
              <div className="flex justify-between items-center mb-2">
                <span className="text-muted-foreground">{isEn ? "Expected Balance:" : "الرصيد المتوقع:"}</span>
                <span dir="ltr" className="inline-block font-bold text-primary tabular-nums">{m.fmt(expectedClosing)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {isEn ? "= Opening + Sales + Deposits - Expenses - Withdrawals" : "= الافتتاح + المبيعات + الإيداعات - المصاريف - السحوبات"}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>{isEn ? "Actual Balance" : "الرصيد الفعلي"}</Label>
              <Input
                dir="ltr"
                className="tabular-nums"
                type="number"
                value={closingAmount}
                onChange={(e) => setClosingAmount(e.target.value)}
                placeholder={isEn ? "Enter actual counted cash" : "أدخل المبلغ الفعلي في الصندوق"}
                min="0"
                step="0.01"
              />
            </div>

            {closingAmount && (
              <div className={cn(
                "rounded-xl p-4 border-2",
                parseFloat(closingAmount) === expectedClosing
                  ? "bg-success/10 border-success/30"
                  : parseFloat(closingAmount) > expectedClosing
                    ? "bg-info/10 border-info/30"
                    : "bg-destructive/10 border-destructive/30"
              )}>
                <div className="flex items-center gap-2">
                  {parseFloat(closingAmount) === expectedClosing ? (
                    <CheckCircle className="w-5 h-5 text-success" />
                  ) : (
                    <AlertTriangle className="w-5 h-5 text-warning" />
                  )}
                  <span className="font-medium">
                    {parseFloat(closingAmount) === expectedClosing
                      ? (isEn ? 'Cashbox Balanced ✓' : 'الصندوق متطابق ✓')
                      : parseFloat(closingAmount) > expectedClosing
                        ? (isEn ? `Surplus: ${m.fmt(parseFloat(closingAmount) - expectedClosing)}` : `فائض: ${m.fmt(parseFloat(closingAmount) - expectedClosing)}`)
                        : (isEn ? `Shortage: ${m.fmt(expectedClosing - parseFloat(closingAmount))}` : `عجز: ${m.fmt(expectedClosing - parseFloat(closingAmount))}`)
                    }
                  </span>
                </div>

                {/* أزرار التعديل السريع */}
                {parseFloat(closingAmount) !== expectedClosing && activeShift && (
                  <div className="mt-3 pt-3 border-t border-border">
                    {parseFloat(closingAmount) < expectedClosing ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => {
                          const diff = expectedClosing - parseFloat(closingAmount);
                          const success = addShiftAdjustment('expense_added', diff, isEn ? 'Cashbox shortage' : 'عجز في الصندوق');
                          if (success) {
                            toast.success(isEn ? `Recorded ${m.fmt(diff)} as expense` : `تم تسجيل ${m.fmt(diff)} كمصروف`);
                            loadData();
                          }
                        }}
                      >
                        <ArrowDownRight className="w-4 h-4" />
                        {isEn ? `Record ${m.fmt(expectedClosing - parseFloat(closingAmount))} as Expense` : `تسجيل ${m.fmt(expectedClosing - parseFloat(closingAmount))} كمصروف`}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full text-success border-success/40 hover:bg-success/10 hover:text-success"
                        onClick={() => {
                          const diff = parseFloat(closingAmount) - expectedClosing;
                          const success = addShiftAdjustment('income_added', diff, isEn ? 'Cashbox surplus' : 'فائض في الصندوق');
                          if (success) {
                            toast.success(isEn ? `Recorded ${m.fmt(diff)} as extra income` : `تم تسجيل ${m.fmt(diff)} كإيراد إضافي`);
                            loadData();
                          }
                        }}
                      >
                        <ArrowUpRight className="w-4 h-4" />
                        {isEn ? `Record ${m.fmt(parseFloat(closingAmount) - expectedClosing)} as Income` : `تسجيل ${m.fmt(parseFloat(closingAmount) - expectedClosing)} كإيراد`}
                      </Button>
                    )}
                    <p className="text-xs text-muted-foreground mt-2 text-center">
                      {isEn ? "Totals will be adjusted to match the actual balance" : "سيتم تعديل المجاميع لمطابقة الرصيد الفعلي"}
                    </p>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label>{isEn ? "Notes (Optional)" : "ملاحظات (اختياري)"}</Label>
              <Textarea
                value={closingNotes}
                onChange={(e) => setClosingNotes(e.target.value)}
                placeholder={isEn ? "Any notes about variance or shift..." : "أي ملاحظات حول الفارق أو الوردية..."}
                rows={2}
              />
            </div>
          </DialogBody>

          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
            <Button variant="outline" size="default" onClick={() => setShowCloseDialog(false)}>
              {isEn ? 'Cancel' : 'إلغاء'}
            </Button>
            <Button variant="destructive" size="default" onClick={handleCloseShift}>
              {isEn ? 'Close Shift' : 'إغلاق الوردية'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* History Dialog */}
      <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
        <DialogContent className="w-[min(calc(100vw-1.5rem),42rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]">
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <DialogTitle className="flex items-center gap-2">
              <History className="w-5 h-5 text-primary" />
              {isEn ? 'Shift History' : 'سجل الورديات'}
            </DialogTitle>
          </DialogHeader>

          <DialogBody className="space-y-3">
            {shifts.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
                <Clock className="w-12 h-12 text-muted-foreground/50 mb-3" />
                <p className="text-sm sm:text-base font-semibold text-foreground">{isEn ? "No shifts found" : "لا توجد ورديات"}</p>
              </div>
            ) : (
              shifts.map(shift => (
                <div key={shift.id} className="border border-border rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Badge variant={shift.status === 'open' ? 'default' : 'secondary'}>
                        {shift.status === 'open' ? (isEn ? 'Open' : 'مفتوحة') : (isEn ? 'Closed' : 'مغلقة')}
                      </Badge>
                      {shift.status === 'closed' && (
                        <Badge variant={shift.discrepancy === 0 ? 'outline' : shift.discrepancy! > 0 ? 'secondary' : 'destructive'}>
                          {shift.discrepancy === 0 ? (isEn ? 'Balanced' : 'متطابق') : shift.discrepancy! > 0 ? (isEn ? 'Surplus' : 'فائض') : (isEn ? 'Shortage' : 'عجز')}
                        </Badge>
                      )}
                    </div>
                    <span className="text-sm text-muted-foreground">{shift.userName}</span>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                    <div>
                      <span className="text-muted-foreground">{isEn ? "Opening:" : "الافتتاح:"}</span>
                      <span dir="ltr" className="inline-block font-medium ms-1 tabular-nums">{m.fmt(shift.openingCash)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{isEn ? "Sales:" : "المبيعات:"}</span>
                      <span dir="ltr" className="inline-block font-medium text-success ms-1 tabular-nums">+{m.fmt(shift.salesTotal)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{isEn ? "Expenses:" : "المصاريف:"}</span>
                      <span dir="ltr" className="inline-block font-medium text-destructive ms-1 tabular-nums">-{m.fmt(shift.expensesTotal)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{isEn ? "Deposits:" : "الإيداعات:"}</span>
                      <span dir="ltr" className="inline-block font-medium text-success ms-1 tabular-nums">+{m.fmt(shift.depositsTotal)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{isEn ? "Withdrawals:" : "السحوبات:"}</span>
                      <span dir="ltr" className="inline-block font-medium text-destructive ms-1 tabular-nums">-{m.fmt(shift.withdrawalsTotal)}</span>
                    </div>
                    {shift.status === 'closed' && (
                      <>
                        <div>
                          <span className="text-muted-foreground">{isEn ? "Expected:" : "المتوقع:"}</span>
                          <span dir="ltr" className="inline-block font-medium text-primary ms-1 tabular-nums">{m.fmt(shift.expectedCash || 0)}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">{isEn ? "Closing:" : "الإغلاق:"}</span>
                          <span dir="ltr" className="inline-block font-medium ms-1 tabular-nums">{m.fmt(shift.closingCash || 0)}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">{isEn ? "Variance:" : "الفارق:"}</span>
                          <span dir="ltr" className={cn(
                            "inline-block font-medium ms-1 tabular-nums",
                            shift.discrepancy === 0 ? "" : shift.discrepancy! > 0 ? "text-success" : "text-destructive"
                          )}>
                            {shift.discrepancy === 0 ? '0' : (shift.discrepancy! > 0 ? '+' : '') + m.fmt(shift.discrepancy!)}
                          </span>
                        </div>
                      </>
                    )}
                  </div>

                  {/* التعديلات */}
                  {shift.adjustments && shift.adjustments.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-border">
                      <p className="text-xs font-medium text-muted-foreground mb-2">{isEn ? "Adjustments:" : "التعديلات:"}</p>
                      <div className="space-y-1">
                        {shift.adjustments.map(adj => (
                          <div key={adj.id} className={cn(
                            "text-xs px-2 py-1 rounded flex items-center justify-between",
                            adj.type === 'expense_added' ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success"
                          )}>
                            <span>
                              {adj.type === 'expense_added' ? (isEn ? '📉 Expense' : '📉 مصروف') : (isEn ? '📈 Income' : '📈 إيراد')}: {adj.reason}
                            </span>
                            <span dir="ltr" className="inline-block font-medium tabular-nums">{m.fmt(adj.amount)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="mt-2 text-xs text-muted-foreground">
                    {formatDateTime(shift.openedAt)}
                    {shift.closedAt && ` - ${formatDateTime(shift.closedAt)}`}
                  </div>
                </div>
              ))
            )}
          </DialogBody>

          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
            <Button variant="outline" size="default" onClick={() => setShowHistoryDialog(false)}>
              {isEn ? 'Close' : 'إغلاق'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
