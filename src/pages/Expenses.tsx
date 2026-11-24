import { getActiveShift } from '@/lib/cashbox-store';
import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Search,
  Plus,
  Receipt,
  Calendar,
  DollarSign,
  Trash2,
  Save,
  Users,
  TrendingDown,
  RefreshCw,
  Clock,
  Check,
  X,
  Bell,
  Settings2,
  Pencil,
  RotateCcw,
  MoreVertical,
  Loader2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn, formatNumber, formatCurrency, formatDateTime } from '@/lib/utils';
import { useMoney } from '@/hooks/use-money';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DatePicker } from '@/components/ui/date-picker';
import { toast } from '@/lib/sonner-bridge';
import {
  loadExpensesCloud,
  addExpenseCloud,
  deleteExpenseCloud,
  reverseExpenseWithResultCloud,
  getExpenseStatsCloud,
  expenseTypes,
  Expense,
  ExpenseType
} from '@/lib/cloud/expenses-cloud';
import {
  loadRecurringExpenses,
  loadRecurringExpensesCloud,
  addRecurringExpenseCloud,
  updateRecurringExpenseCloud,
  deleteRecurringExpenseCloud,
  getDueExpenses,
  payRecurringExpense,
  skipRecurringExpense,
  recurringIntervals,
  RecurringExpense
} from '@/lib/recurring-expenses-store';
import { emitEvent, EVENTS } from '@/lib/events';
import { useLanguage } from '@/hooks/use-language';
import { processExpense, reverseExpenseTransaction, restoreExpenseCash } from '@/lib/unified-transactions';
import { toLocalDateString } from '@/lib/date-utils';
import { PageHeader } from '@/components/layout/PageHeader';
import { ListPageSkeleton } from '@/components/ui/page-skeleton';
import { useDeferWhileHidden } from '@/contexts/PageActivityContext';

export default function Expenses() {
  const deferWhileHidden = useDeferWhileHidden();
  const m = useMoney();
  const [expenseCurrency, setExpenseCurrency] = useState<string>(() => m.activeCode);
  const selectedCurrencyDef = m.enabledCurrencies.find(c => c.code === expenseCurrency) || m.getCurrencyDef(expenseCurrency);
  const currentExpenseDef = selectedCurrencyDef;
  const { t, isRTL } = useLanguage();

  const getLocalizedExpenseType = (type: string, fallback?: string): string => {
    const translationKey = `expenses.types.${type}`;
    const translated = t(translationKey as Parameters<typeof t>[0]);
    if (translated && translated !== translationKey) return translated;
    return fallback || type;
  };

  const getLocalizedInterval = (interval: { value: number; label: string; interval: string }): string => {
    return t(`expenses.intervals.${interval.interval}` as Parameters<typeof t>[0]) || interval.label;
  };
  const [searchParams, setSearchParams] = useSearchParams();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [recurringExpenses, setRecurringExpenses] = useState<RecurringExpense[]>(() => loadRecurringExpenses());
  const [dueExpenses, setDueExpenses] = useState<RecurringExpense[]>(() => getDueExpenses());
  const [searchQuery, setSearchQuery] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isPaying, setIsPaying] = useState(false);
  const savingRef = useRef(false);

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showRecurringDialog, setShowRecurringDialog] = useState(false);
  const [showRecurringListDialog, setShowRecurringListDialog] = useState(false);
  const [showEditRecurringDialog, setShowEditRecurringDialog] = useState(false);
  const [editingRecurring, setEditingRecurring] = useState<RecurringExpense | null>(null);
  const [editRecurringForm, setEditRecurringForm] = useState({
    name: '',
    type: 'wages' as ExpenseType,
    customType: '',
    amount: 0,
    currency: m.activeCode,
    intervalDays: 30,
    notes: '',
    autoPay: false,
  });
  const [showPayConfirmDialog, setShowPayConfirmDialog] = useState(false);
  const [selectedExpense, setSelectedExpense] = useState<Expense | null>(null);
  const [selectedRecurring, setSelectedRecurring] = useState<RecurringExpense | null>(null);
  const [stats, setStats] = useState({ totalExpenses: 0, totalThisMonth: 0, expenseCount: 0, monthlyCount: 0, byType: {} as Record<string, number> });

  // Form state
  const [formData, setFormData] = useState({
    type: 'rent' as ExpenseType,
    customType: '',
    amount: 0,
    notes: '',
    date: toLocalDateString(new Date()),
  });

  // Recurring form state
  const [recurringForm, setRecurringForm] = useState({
    name: '',
    type: 'wages' as ExpenseType,
    customType: '',
    amount: 0,
    currency: m.activeCode,
    intervalDays: 30,
    startDate: toLocalDateString(new Date()),
    notes: '',
    payImmediately: false,
    autoPay: false,
  });

  const recurringCurrencyDef = m.enabledCurrencies.find(c => c.code === (recurringForm.currency || m.activeCode)) || m.getCurrencyDef(recurringForm.currency || m.activeCode);
  const editRecurringCurrencyDef = m.enabledCurrencies.find(c => c.code === (editRecurringForm.currency || m.activeCode)) || m.getCurrencyDef(editRecurringForm.currency || m.activeCode);

  // Load expenses and recurring expenses from cloud
  useEffect(() => {
    const loadData = async () => {
      try {
        const [expensesData, statsData, recurringData] = await Promise.all([
          loadExpensesCloud(),
          getExpenseStatsCloud(),
          loadRecurringExpensesCloud(),
        ]);
        setExpenses(expensesData);
        setStats(statsData);
        setRecurringExpenses(recurringData);
        setDueExpenses(getDueExpenses());
      } finally {
        setIsLoading(false);
      }
    };
    loadData();

    // التحديثات القادمة أثناء إخفاء الصفحة تُؤجَّل إلى لحظة فتحها
    const handleUpdate = () => deferWhileHidden('expenses', loadData);
    const handleRecurringUpdate = () => deferWhileHidden('recurring', async () => {
      const recurringData = await loadRecurringExpensesCloud();
      setRecurringExpenses(recurringData);
      setDueExpenses(getDueExpenses());
    });

    window.addEventListener(EVENTS.EXPENSES_UPDATED, handleUpdate);
    window.addEventListener(EVENTS.RECURRING_EXPENSES_UPDATED, handleRecurringUpdate);
    return () => {
      window.removeEventListener(EVENTS.EXPENSES_UPDATED, handleUpdate);
      window.removeEventListener(EVENTS.RECURRING_EXPENSES_UPDATED, handleRecurringUpdate);
    };
  }, []);

  // Auto-open add dialog from URL params
  useEffect(() => {
    if (searchParams.get('action') === 'new') {
      resetForm();
      setShowAddDialog(true);
      searchParams.delete('action');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Auto-open pay confirmation dialog from URL param (e.g., from SyncStatusMenu)
  useEffect(() => {
    const payId = searchParams.get('payRecurringId');
    if (payId && recurringExpenses.length > 0) {
      const target = recurringExpenses.find(e => e.id === payId);
      if (target) {
        setSelectedRecurring(target);
        setShowPayConfirmDialog(true);
      }
      searchParams.delete('payRecurringId');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams, recurringExpenses]);

  const filteredExpenses = expenses.filter(expense =>
    expense.typeLabel.toLowerCase().includes(searchQuery.toLowerCase()) ||
    expense.notes?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const resetForm = () => {
    setFormData({
      type: 'rent',
      customType: '',
      amount: 0,
      notes: '',
      date: toLocalDateString(new Date()),
    });
  };

  const resetRecurringForm = () => {
    setRecurringForm({
      name: '',
      type: 'wages',
      customType: '',
      amount: 0,
      currency: m.activeCode,
      intervalDays: 30,
      startDate: toLocalDateString(new Date()),
      notes: '',
      payImmediately: false,
      autoPay: false,
    });
  };

  const setShowAddExpense = (open: boolean) => {
    if (open) resetForm();
    setShowAddDialog(open);
  };

  const handleAddExpense = async () => {
    // ✅ منع تكرار الإدخال عند الضغط المتعدد
    if (isSaving || savingRef.current) return;

    if (formData.amount <= 0) {
      toast.error(t('expenses.enterValidAmount'));
      return;
    }

    if (formData.type === 'other' && !formData.customType) {
      toast.error(t('expenses.specifyExpenseType'));
      return;
    }

    savingRef.current = true;
    setIsSaving(true);
    try {
      const amountUSD = m.toUsd(formData.amount, expenseCurrency, selectedCurrencyDef.rate);
      const noteSuffix = expenseCurrency !== 'USD'
        ? ` (${m.roundForCurrency(formData.amount, expenseCurrency)} ${selectedCurrencyDef.symbol})`
        : '';
      const finalNotes = formData.notes ? `${formData.notes}${noteSuffix}` : (noteSuffix.trim() || undefined);

      const expenseShiftId = getActiveShift()?.id;
      const created = await addExpenseCloud({
        shiftId: expenseShiftId,
        paidFrom: expenseShiftId ? 'drawer' : undefined,
        type: formData.type,
        customType: formData.customType,
        amount: amountUSD,
        originalCurrency: expenseCurrency,
        originalAmount: formData.amount,
        exchangeRate: selectedCurrencyDef.rate,
        notes: finalNotes,
        date: formData.date,
      });

      if (!created) {
        toast.error(t('expenses.addError') || 'فشل في إضافة المصروف');
        return;
      }

      // ✅ خصم المبلغ من الصندوق بعملة المصروف الأصلية وسعر صرفها، مع ربط الحركة بمعرّف المصروف نفسه
      processExpense(amountUSD, formData.type, undefined, undefined, created.id, expenseCurrency, formData.amount,
        selectedCurrencyDef.rate, false, Boolean(expenseShiftId && getActiveShift()?.id === expenseShiftId));

      const [expensesData, statsData] = await Promise.all([
        loadExpensesCloud(),
        getExpenseStatsCloud()
      ]);
      setExpenses(expensesData);
      setStats(statsData);
      setShowAddDialog(false);
      resetForm();
      toast.success(t('expenses.expenseAdded'));
      import('@/lib/activity-log').then(({ logActivity }) => logActivity('expense_added', `إضافة مصروف (${formData.type}): ${amountUSD}`, { id: created.id, amount: amountUSD, type: formData.type }));
    } catch (err) {
      // رفض الخادم (مثل فترة مغلقة) يُعرض برسالته الحقيقية بدل نجاح وهمي
      toast.error(err instanceof Error && err.message ? err.message : (t('expenses.addError') || 'فشل في إضافة المصروف'));
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  const handleAddRecurringExpense = async () => {
    if (!recurringForm.name || recurringForm.amount <= 0) {
      toast.error(t('expenses.fillAllFields'));
      return;
    }

    const curr = recurringForm.currency || m.activeCode;
    const currDef = m.enabledCurrencies.find(c => c.code === curr) || m.getCurrencyDef(curr);
    const amountUSD = m.toUsd(recurringForm.amount, curr, currDef.rate);
    const currencySuffix = curr !== 'USD'
      ? ` (${m.roundForCurrency(recurringForm.amount, curr)} ${currDef.symbol})`
      : '';
    const finalNotes = recurringForm.notes
      ? `${recurringForm.notes}${currencySuffix}`
      : (currencySuffix.trim() || undefined);

    try {
      const newExpense = await addRecurringExpenseCloud({
        name: recurringForm.name,
        type: recurringForm.type,
        customType: recurringForm.customType,
        amount: amountUSD,
        originalAmount: recurringForm.amount,
        currency: curr,
        exchangeRate: currDef.rate,
        intervalDays: recurringForm.intervalDays,
        startDate: recurringForm.startDate,
        notes: finalNotes,
        autoPay: recurringForm.autoPay,
      });

      if (recurringForm.payImmediately) {
        const todayStr = toLocalDateString(new Date());
        const expenseShiftId = getActiveShift()?.id;
        const createdRecurringPayment = await addExpenseCloud({
          shiftId: expenseShiftId,
          paidFrom: expenseShiftId ? 'drawer' : undefined,
          type: recurringForm.type,
          customType: recurringForm.customType || recurringForm.name,
          amount: amountUSD,
          originalCurrency: curr,
          originalAmount: recurringForm.amount,
          exchangeRate: currDef.rate,
          notes: `${recurringForm.name} - دفعة سداد فوري لمصروف ثابت${currencySuffix}`,
          date: todayStr,
        });
        if (!createdRecurringPayment) throw new Error('فشل إنشاء دفعة المصروف الثابت');

        processExpense(amountUSD, recurringForm.type, undefined, undefined, createdRecurringPayment.id, curr,
          recurringForm.amount, currDef.rate, false, Boolean(expenseShiftId && getActiveShift()?.id === expenseShiftId));

        const nextDate = new Date(recurringForm.startDate || todayStr);
        nextDate.setDate(nextDate.getDate() + (recurringForm.intervalDays || 30));
        await updateRecurringExpenseCloud(newExpense.id, {
          lastPaidDate: todayStr,
          nextDueDate: toLocalDateString(nextDate),
        });

        emitEvent(EVENTS.EXPENSES_UPDATED, null);
      }

      const [expensesData, statsData, recurringData] = await Promise.all([
        loadExpensesCloud(),
        getExpenseStatsCloud(),
        loadRecurringExpensesCloud(),
      ]);
      setExpenses(expensesData);
      setStats(statsData);
      setRecurringExpenses(recurringData);
      setDueExpenses(getDueExpenses());
      setShowRecurringDialog(false);
      resetRecurringForm();
      toast.success(t('expenses.fixedExpenseAdded'));
    } catch (err) {
      console.error('[Expenses] Error adding recurring expense:', err);
      toast.error(t('expenses.addRecurringError') || 'فشل في إضافة المصروف الثابت');
    }
  };

  const handleOpenEditRecurring = (expense: RecurringExpense) => {
    setEditingRecurring(expense);
    const curr = expense.currency || 'USD';
    const currDef = m.enabledCurrencies.find(c => c.code === curr) || m.getCurrencyDef(curr);
    const effectiveRate = expense.exchangeRate || currDef.rate;
    const displayAmount = curr !== 'USD'
      ? m.roundForCurrency(m.fromUsd(expense.amount, curr, effectiveRate), curr)
      : expense.amount;

    setEditRecurringForm({
      name: expense.name,
      type: expense.type,
      customType: expense.customType || '',
      amount: displayAmount,
      currency: curr,
      intervalDays: expense.intervalDays,
      notes: expense.notes ? expense.notes.replace(/\s*\[CURRENCY:[^\]]+\]/g, '').replace(/\s*\([^)]*([₺$]|ل\.س|ج\.م|ر\.س|د\.إ|د\.ع|د\.أ|ل\.ل|د\.ك|ر\.ق|د\.ب|ر\.ع)[^)]*\)/g, '').trim() : '',
      autoPay: expense.autoPay ?? false,
    });
    setShowEditRecurringDialog(true);
  };

  const handleUpdateRecurringExpense = async () => {
    if (!editingRecurring) return;
    if (!editRecurringForm.name || editRecurringForm.amount <= 0) {
      toast.error(t('expenses.fillAllFields'));
      return;
    }

    const intervalInfo = recurringIntervals.find(i => i.value === editRecurringForm.intervalDays) || recurringIntervals[1];
    const curr = editRecurringForm.currency || m.activeCode;
    const currDef = m.enabledCurrencies.find(c => c.code === curr) || m.getCurrencyDef(curr);
    const amountUSD = m.toUsd(editRecurringForm.amount, curr, currDef.rate);
    const currencySuffix = curr !== 'USD'
      ? ` (${m.roundForCurrency(editRecurringForm.amount, curr)} ${currDef.symbol})`
      : '';
    const cleanNotes = editRecurringForm.notes ? editRecurringForm.notes.replace(/\s*\[CURRENCY:[^\]]+\]/g, '').replace(/\s*\([^)]*([₺$]|ل\.س|ج\.م|ر\.س|د\.إ|د\.ع|د\.أ|ل\.ل|د\.ك|ر\.ق|د\.ب|ر\.ع)[^)]*\)/g, '').trim() : '';
    const finalNotes = cleanNotes
      ? (currencySuffix ? `${cleanNotes}${currencySuffix}` : cleanNotes)
      : (currencySuffix.trim() || undefined);

    try {
      await updateRecurringExpenseCloud(editingRecurring.id, {
        name: editRecurringForm.name,
        type: editRecurringForm.type,
        customType: editRecurringForm.customType,
        amount: amountUSD,
        currency: curr,
        exchangeRate: currDef.rate,
        interval: intervalInfo.interval,
        intervalDays: editRecurringForm.intervalDays,
        notes: finalNotes,
        autoPay: editRecurringForm.autoPay,
      });

      const recurringData = await loadRecurringExpensesCloud();
      setRecurringExpenses(recurringData);
      setDueExpenses(getDueExpenses());
      setShowEditRecurringDialog(false);
      setEditingRecurring(null);
      toast.success(t('expenses.editRecurringSuccess') || 'تم تعديل المصروف الثابت بنجاح');
    } catch (err) {
      console.error('[Expenses] Error updating recurring expense:', err);
      toast.error(t('expenses.editRecurringError') || 'فشل في تعديل المصروف الثابت');
    }
  };

  const handleReverseExpense = async (expenseToReverse?: Expense) => {
    const expense = expenseToReverse || selectedExpense;
    if (!expense || expense.is_reversed) return;

    const reversedAmount = expense.amount;
    const reversedType = expense.type;
    const reversedId = expense.id;

    try {
      const originalShiftId = getActiveShift()?.id ?? null;
      const result = await reverseExpenseWithResultCloud(reversedId, 'تراجع بواسطة المستخدم', originalShiftId);
      if (result.cashRefunded && result.shiftId && getActiveShift()?.id === result.shiftId
          && result.cashAmount !== undefined && result.cashCurrency) {
        restoreExpenseCash(result.cashAmount, reversedType, reversedId, result.cashCurrency, result.cashCurrencyAmount);
      }

      // 3. تحديث البيانات محلياً
      const [expensesData, statsData] = await Promise.all([
        loadExpensesCloud(),
        getExpenseStatsCloud()
      ]);
      setExpenses(expensesData);
      setStats(statsData);
      setShowDeleteDialog(false);
      setSelectedExpense(null);

      if (result.queued) {
        toast.success('تمت جدولة عكس المصروف للمزامنة');
      } else if (result.alreadyReversed) {
        toast.success('المصروف معكوس مسبقاً');
      } else {
        toast.success(result.cashRefunded && result.cashAmount !== undefined
          ? `تم استرداد المصروف وإعادة ${m.fmt(result.cashAmount)} للصندوق`
          : 'تم عكس المصروف');
        import('@/lib/activity-log').then(({ logActivity }) => logActivity('expense_refund',
          `عكس مصروف (${reversedType}): ${reversedAmount}`,
          { id: reversedId, amount: reversedAmount, type: reversedType })).catch(() => {});
      }
    } catch (error) {
      // لا رسالة نجاح عند فشل الخادم: نعرض السبب الحقيقي الوارد من Supabase
      const reason = error instanceof Error && error.message ? error.message : '';
      toast.error(reason || t('expenses.reverseError') || 'فشل التراجع عن المصروف');
    }
  };

  const handleDeleteExpense = () => handleReverseExpense();

  // فتح نافذة التأكيد قبل الدفع لضمان عدم السداد المكرر العرضي
  const handleQuickPayRecurring = (expense: RecurringExpense) => {
    openPayConfirmDialog(expense);
  };

  const handlePayRecurring = async () => {
    if (!selectedRecurring || isPaying) return;
    setIsPaying(true);
    try {
      const success = await payRecurringExpense(selectedRecurring.id);
      if (success) {
        const [expensesData, statsData, recurringData] = await Promise.all([
          loadExpensesCloud(),
          getExpenseStatsCloud(),
          loadRecurringExpensesCloud(),
        ]);
        setExpenses(expensesData);
        setStats(statsData);
        setRecurringExpenses(recurringData);
        setDueExpenses(getDueExpenses());
        emitEvent(EVENTS.RECURRING_EXPENSES_UPDATED, null);
        toast.success(t('expenses.payExpenseSuccess') || `تم صرف مصروف: ${selectedRecurring.name}`);
      } else {
        toast.error(t('expenses.alreadyPaidToday') || 'هذا المصروف تم سداده اليوم بالفعل أو قيد المعالجة');
      }
    } catch (err) {
      console.error('[Expenses] Error paying recurring expense:', err);
      toast.error(t('expenses.payExpenseError') || 'فشل في تنفيذ عملية الصرف');
    } finally {
      setIsPaying(false);
      setShowPayConfirmDialog(false);
      setSelectedRecurring(null);
    }
  };

  const handleSkipRecurring = async (expense: RecurringExpense) => {
    try {
      skipRecurringExpense(expense.id);
      const recurringData = await loadRecurringExpensesCloud();
      setRecurringExpenses(recurringData);
      setDueExpenses(getDueExpenses());
      toast.info(t('expenses.paymentSkipped'));
    } catch (err) {
      console.error('[Expenses] Error skipping recurring expense:', err);
      toast.error(t('expenses.skipError') || 'فشل في تأجيل المصروف');
    }
  };

  const handleDeleteRecurring = async (id: string) => {
    try {
      await deleteRecurringExpenseCloud(id);
      const recurringData = await loadRecurringExpensesCloud();
      setRecurringExpenses(recurringData);
      setDueExpenses(getDueExpenses());
      toast.success(t('expenses.fixedExpenseDeleted'));
    } catch (err) {
      console.error('[Expenses] Error deleting recurring expense:', err);
      toast.error(t('expenses.deleteRecurringError') || 'فشل في حذف المصروف الثابت');
    }
  };

  const openDeleteDialog = (expense: Expense) => {
    setSelectedExpense(expense);
    setShowDeleteDialog(true);
  };

  const openPayConfirmDialog = (expense: RecurringExpense) => {
    setSelectedRecurring(expense);
    setShowPayConfirmDialog(true);
  };

  return (
    <div className="p-3 sm:p-4 md:p-6 space-y-4 md:space-y-6 overflow-x-hidden relative">
      {/* Top Header with Primary Add Actions */}
      <PageHeader
        title={t('expenses.title')}
        icon={<Receipt className="w-5 h-5" />}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={() => {
                resetRecurringForm();
                setShowRecurringDialog(true);
              }}
            >
              <RefreshCw className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{t('expenses.addRecurring')}</span>
            </Button>
            <Button
              type="button"
              variant="default"
              size="default"
              onClick={() => {
                resetForm();
                setShowAddDialog(true);
              }}
            >
              <Plus className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{t('expenses.addExpense')}</span>
            </Button>
          </>
        }
      />

      {/* Top Search */}
      <div className="flex items-center justify-between gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder={t('expenses.searchExpenses')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ps-9 pe-3"
          />
        </div>
      </div>

      {/* Due Expenses Alert Banner */}
      {dueExpenses.length > 0 && (
        <div className="p-3 bg-warning/10 border border-warning/30 rounded-2xl flex items-center justify-between gap-3 animate-in fade-in">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-warning/20 text-warning flex items-center justify-center shrink-0">
              <Bell className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <span className="font-bold text-xs text-foreground block truncate">
                <span dir="ltr" className="inline-block tabular-nums">{dueExpenses.length}</span> {t('expenses.dueToday')}
              </span>
              <p className="text-xs text-muted-foreground font-mono">
                {t('common.total')}: <span dir="ltr" className="inline-block font-bold text-foreground tabular-nums">{m.fmt(dueExpenses.reduce((sum, e) => sum + e.amount, 0))}</span>
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="border-warning/40 hover:bg-warning/15 text-xs font-bold rounded-xl shrink-0 text-warning"
            onClick={() => setShowRecurringListDialog(true)}
          >
            {t('expenses.reviewAndPay')}
          </Button>
        </div>
      )}

      {/* Compressed 4-Metric Stats Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        {/* Metric 1: هذا الشهر */}
        <div className="bg-card border border-border rounded-xl md:rounded-2xl p-3 text-center relative overflow-hidden">
          <span className="text-xs text-muted-foreground block truncate font-medium">
            {t('expenses.thisMonth')}
          </span>
          <span dir="ltr" className="inline-block text-sm sm:text-base md:text-lg font-bold font-mono text-destructive tabular-nums mt-0.5 truncate whitespace-nowrap">
            {m.fmt(stats.totalThisMonth)}
          </span>
          <div className="flex items-center justify-center gap-1 mt-0.5 text-xs text-muted-foreground">
            <TrendingDown className="w-3 h-3 text-destructive shrink-0" />
            <span className="truncate">{t('expenses.expense')}</span>
          </div>
        </div>

        {/* Metric 2: عمليات الشهر */}
        <div className="bg-card border border-border rounded-xl md:rounded-2xl p-3 text-center relative overflow-hidden">
          <span className="text-xs text-muted-foreground block truncate font-medium">
            {t('expenses.monthlyExpenses')}
          </span>
          <span dir="ltr" className="inline-block text-sm sm:text-base md:text-lg font-bold font-mono text-foreground tabular-nums mt-0.5 truncate">
            {stats.monthlyCount}
          </span>
          <div className="flex items-center justify-center gap-1 mt-0.5 text-xs text-muted-foreground">
            <Receipt className="w-3 h-3 text-warning shrink-0" />
            <span className="truncate">{t('expenses.operations')}</span>
          </div>
        </div>

        {/* Metric 3: إجمالي المصاريف */}
        <div className="bg-card border border-border rounded-xl md:rounded-2xl p-3 text-center relative overflow-hidden">
          <span className="text-xs text-muted-foreground block truncate font-medium">
            {t('expenses.totalExpenses')}
          </span>
          <span dir="ltr" className="inline-block text-sm sm:text-base md:text-lg font-bold font-mono text-foreground tabular-nums mt-0.5 truncate whitespace-nowrap">
            {m.fmt(stats.totalExpenses)}
          </span>
          <div className="flex items-center justify-center gap-1 mt-0.5 text-xs text-muted-foreground">
            <DollarSign className="w-3 h-3 text-info shrink-0" />
            <span className="truncate">{t('expenses.total')}</span>
          </div>
        </div>

        {/* Metric 4: مصاريف ثابتة */}
        <div
          className="bg-card border border-border rounded-xl md:rounded-2xl p-3 text-center relative overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors"
          onClick={() => setShowRecurringListDialog(true)}
          title={t('expenses.manageRecurring')}
        >
          <span className="text-xs text-muted-foreground block truncate font-medium">
            {t('expenses.fixedExpenses')}
          </span>
          <span dir="ltr" className="inline-block text-sm sm:text-base md:text-lg font-bold font-mono text-primary tabular-nums mt-0.5 truncate">
            {recurringExpenses.length}
          </span>
          <div className="flex items-center justify-center gap-1 mt-0.5 text-xs text-primary">
            <RefreshCw className="w-3 h-3 shrink-0" />
            <span className="truncate font-semibold">{t('expenses.manage')}</span>
          </div>
        </div>
      </div>

      {/* Expense Types Summary */}
      {Object.keys(stats.byType).length > 0 && (
        <div className="bg-card border border-border rounded-2xl p-3 space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground px-0.5">
            <span>{t('expenses.monthlyDistribution')}</span>
            <span className="text-xs font-mono"><span dir="ltr" className="inline-block tabular-nums">{Object.keys(stats.byType).length}</span> {t('expenses.categories')}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {Object.entries(stats.byType).map(([type, amount]) => (
              <div key={type} className="min-w-0 px-2.5 py-1.5 bg-muted/60 border border-border/40 rounded-xl text-xs flex items-center justify-between gap-1.5">
                <span className="min-w-0 truncate text-muted-foreground">{getLocalizedExpenseType(type)}:</span>
                <span dir="ltr" className="inline-block min-w-0 truncate font-bold font-mono text-foreground whitespace-nowrap tabular-nums" title={m.fmt(amount)}>{m.fmt(amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Expenses List */}
      <div className="space-y-2 md:space-y-2.5">
        {isLoading && expenses.length === 0 ? (
          <ListPageSkeleton rows={5} />
        ) : filteredExpenses.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
            <Receipt className="w-12 h-12 text-muted-foreground/50 mb-3" />
            <p className="text-sm sm:text-base font-semibold text-foreground">{t('expenses.noExpenses')}</p>
            <p className="text-xs sm:text-sm text-muted-foreground mt-1">{t('expenses.startAdding')}</p>
          </div>
        ) : (
          filteredExpenses.map((expense, index) => (
            <div
              key={expense.id}
              className="bg-card rounded-2xl border border-border p-3 md:p-3.5 relative overflow-hidden transition-all duration-200 hover:shadow-md hover:border-primary/40 fade-in"
              style={{ animationDelay: `${index * 30}ms` }}
            >
              {/* 3-Dots Dropdown Menu in Top-End */}
              <div className="absolute end-2 top-2 z-10">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-foreground"
                      title={t('common.options')}
                      aria-label={t('common.options')}
                    >
                      <MoreVertical className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-44 rounded-2xl p-1.5 border-border shadow-xl">
                    <DropdownMenuItem
                      onClick={() => openDeleteDialog(expense)}
                      disabled={expense.is_reversed}
                      className="gap-2 text-xs font-semibold text-warning focus:text-warning focus:bg-warning/10 rounded-xl cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>{expense.is_reversed ? t('expenses.alreadyReversed') : t('expenses.reverseExpense')}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Title & Amount Row */}
              <div className="flex items-start justify-between gap-2 pe-12">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-xl bg-destructive/10 text-destructive flex items-center justify-center shrink-0">
                    <Receipt className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <h3 className="text-sm sm:text-base font-semibold text-foreground truncate">{getLocalizedExpenseType(expense.type, expense.typeLabel)}</h3>
                      {expense.is_reversed && (
                        <Badge variant="outline" className="bg-warning/15 text-warning border-warning/30 shrink-0">
                          {t('expenses.reversed')}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>

                <div className="text-end shrink-0 whitespace-nowrap">
                  <span dir="ltr" className={cn(
                    "inline-block text-sm md:text-base font-bold font-mono whitespace-nowrap tabular-nums",
                    expense.is_reversed ? "line-through text-muted-foreground" : "text-destructive"
                  )}>
                    -{m.fmt(expense.amount)}
                  </span>
                </div>
              </div>

              {/* Meta Tags Row */}
              <div className="flex flex-wrap items-center gap-1.5 mt-2 text-[10.5px]">
                <span className="text-muted-foreground font-mono bg-muted/60 px-1.5 py-0.5 rounded font-medium" dir="ltr">
                  📅 {expense.date}
                </span>
                {expense.cashierName && (
                  <span className="text-primary font-bold flex items-center gap-0.5 bg-primary/10 px-1.5 py-0.5 rounded">
                    👤 {expense.cashierName}
                  </span>
                )}
              </div>

              {/* Notes */}
              {expense.notes && (
                <p className="mt-2 text-xs text-muted-foreground bg-muted/40 border border-border/40 rounded-xl p-2 leading-relaxed">
                  {expense.notes}
                </p>
              )}

              {/* Partner Distributions */}
              {expense.distributions.length > 0 && (
                <div className="mt-2.5 pt-2 border-t border-dashed border-border">
                  <p className="text-[11px] text-muted-foreground mb-1.5 flex items-center gap-1 font-medium">
                    <Users className="w-3 h-3 text-primary" />
                    <span>{t('expenses.partnerDistribution')}:</span>
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {expense.distributions.map(dist => (
                      <span key={dist.partnerId} className="px-2 py-0.5 bg-muted/70 border border-border/50 rounded-lg text-xs font-mono font-medium text-foreground">
                        {dist.partnerName}: <span dir="ltr" className="inline-block tabular-nums">${dist.amount.toFixed(0)} ({dist.percentage.toFixed(0)}%)</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Add Expense Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent
          className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] rounded-[24px] p-0 overflow-hidden border border-border shadow-2xl modal-dot-expand bg-card text-sm flex flex-col"
          onPointerDownOutside={(e) => { if (isSaving || formData.amount > 0 || formData.notes.trim()) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (isSaving || formData.amount > 0 || formData.notes.trim()) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 bg-muted/40 border-b border-border/60 text-start pe-12">
            <DialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <Receipt className="w-4 h-4" />
              </div>
              <span>{t('expenses.addNewExpense')}</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground ms-10">
              {t('expenses.addNewExpenseDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4 overscroll-contain">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold block text-muted-foreground">{t('expenses.expenseType')}</label>
              <Select
                value={formData.type}
                onValueChange={(value: ExpenseType) => setFormData({ ...formData, type: value })}
              >
                <SelectTrigger className="min-h-11 sm:min-h-10 rounded-[14px]">
                  <SelectValue placeholder={t('expenses.selectExpenseType')} />
                </SelectTrigger>
                <SelectContent className="rounded-2xl max-h-[min(20rem,60dvh)] overflow-y-auto">
                  {expenseTypes.map(type => (
                    <SelectItem key={type.value} value={type.value} className="rounded-xl">
                      {getLocalizedExpenseType(type.value, type.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {formData.type === 'other' && (
              <div>
                <label className="text-xs font-semibold mb-1 block text-muted-foreground">{t('expenses.expenseName')}</label>
                <Input
                  placeholder={t('expenses.expenseNamePlaceholder')}
                  value={formData.customType}
                  onChange={(e) => setFormData({ ...formData, customType: e.target.value })}
                  className="h-10 rounded-xl"
                />
              </div>
            )}

            {/* Currency Selector */}
            <div className="flex items-center justify-between bg-muted/30 px-3 py-1.5 rounded-xl border border-border/60">
              <span className="text-xs font-semibold text-muted-foreground">عملة المصروف:</span>
              <div className="flex items-center gap-1 bg-background p-0.5 rounded-lg border border-border/60">
                {m.enabledCurrencies.map((curr) => (
                  <button
                    key={curr.code}
                    type="button"
                    onClick={() => setExpenseCurrency(curr.code)}
                    className={cn(
                      "px-2.5 py-1 text-xs font-bold rounded-md transition-all flex items-center gap-1",
                      expenseCurrency === curr.code
                        ? "bg-primary text-primary-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <span>{curr.symbol}</span>
                    <span>{curr.code}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold mb-1 block text-muted-foreground">{t('expenses.amount')} ({currentExpenseDef.symbol})</label>
              <div className="relative">
                <span className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-xs font-bold font-mono text-muted-foreground">{currentExpenseDef.symbol}</span>
                <Input
                  dir="ltr"
                  type="number"
                  placeholder="0.00"
                  value={formData.amount || ''}
                  onChange={(e) => setFormData({ ...formData, amount: Number(e.target.value) })}
                  min="0"
                  className="ps-9 font-mono text-sm font-bold tabular-nums"
                />
              </div>
              {expenseCurrency !== 'USD' && formData.amount > 0 && (
                <p className="text-xs text-muted-foreground font-mono mt-1">
                  <span dir="ltr" className="inline-block tabular-nums">≈ ${m.toUsd(formData.amount, expenseCurrency, currentExpenseDef.rate).toFixed(2)} USD</span>
                </p>
              )}
            </div>

            <div>
              <label className="text-xs font-semibold mb-1 block text-muted-foreground">{t('expenses.date')}</label>
              <DatePicker
                value={formData.date}
                onChange={(date) => setFormData({ ...formData, date: date })}
                placeholder={t('common.selectDate')}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold block text-muted-foreground">{t('expenses.notes')}</label>
              <Textarea
                placeholder={t('expenses.notesPlaceholder')}
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                rows={2}
                className="rounded-xl text-xs resize-none"
              />
            </div>
          </DialogBody>
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 bg-muted/30 border-t border-border/60">
            <Button variant="outline" size="default" onClick={() => setShowAddDialog(false)} disabled={isSaving}>
              {t('expenses.cancel')}
            </Button>
            <Button variant="default" size="default" onClick={handleAddExpense} disabled={isSaving}>
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {isSaving ? t('common.saving') : t('expenses.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Recurring Expense Dialog */}
      <Dialog open={showRecurringDialog} onOpenChange={setShowRecurringDialog}>
        <DialogContent
          className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] rounded-[24px] p-0 overflow-hidden border border-border shadow-2xl modal-dot-expand bg-card text-sm flex flex-col"
          onPointerDownOutside={(e) => { if (recurringForm.name.trim() || recurringForm.amount > 0) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (recurringForm.name.trim() || recurringForm.amount > 0) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 bg-muted/40 border-b border-border/60 text-start pe-12">
            <DialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <RefreshCw className="w-4 h-4" />
              </div>
              <span>{t('expenses.addRecurring')}</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground ms-10">
              {t('expenses.addRecurringDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4 overscroll-contain">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold block text-muted-foreground">{t('expenses.expenseName')}</label>
              <Input
                placeholder={t('expenses.expenseNamePlaceholder')}
                value={recurringForm.name}
                onChange={(e) => setRecurringForm({ ...recurringForm, name: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold block text-muted-foreground">{t('expenses.expenseType')}</label>
              <Select
                value={recurringForm.type}
                onValueChange={(value: ExpenseType) => setRecurringForm({ ...recurringForm, type: value })}
              >
                <SelectTrigger className="min-h-11 sm:min-h-10 rounded-[14px]">
                  <SelectValue placeholder={t('expenses.selectExpenseType')} />
                </SelectTrigger>
                <SelectContent className="rounded-2xl max-h-[min(20rem,60dvh)] overflow-y-auto">
                  {expenseTypes.map(type => (
                    <SelectItem key={type.value} value={type.value} className="rounded-xl">
                      {getLocalizedExpenseType(type.value, type.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Currency Selector for Recurring Expense */}
            <div className="flex items-center justify-between bg-muted/30 px-3 py-1.5 rounded-xl border border-border/60">
              <span className="text-xs font-semibold text-muted-foreground">عملة المصروف:</span>
              <div className="flex items-center gap-1 bg-background p-0.5 rounded-lg border border-border/60">
                {m.enabledCurrencies.map((curr) => (
                  <button
                    key={curr.code}
                    type="button"
                    onClick={() => setRecurringForm({ ...recurringForm, currency: curr.code })}
                    className={cn(
                      "px-2.5 py-1 text-xs font-bold rounded-md transition-all flex items-center gap-1",
                      (recurringForm.currency || m.activeCode) === curr.code
                        ? "bg-primary text-primary-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <span>{curr.symbol}</span>
                    <span>{curr.code}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold mb-1 block text-muted-foreground">
                {t('expenses.amount')} ({recurringCurrencyDef.symbol})
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-xs font-bold font-mono text-muted-foreground">
                  {recurringCurrencyDef.symbol}
                </span>
                <Input
                  dir="ltr"
                  type="number"
                  placeholder="0.00"
                  value={recurringForm.amount || ''}
                  onChange={(e) => setRecurringForm({ ...recurringForm, amount: Number(e.target.value) })}
                  min="0"
                  className="ps-9 font-mono text-sm font-bold tabular-nums"
                />
              </div>
              {(recurringForm.currency || m.activeCode) !== 'USD' && recurringForm.amount > 0 && (
                <p className="text-xs text-muted-foreground font-mono mt-1">
                  <span dir="ltr" className="inline-block tabular-nums">≈ ${m.toUsd(recurringForm.amount, recurringForm.currency || m.activeCode, recurringCurrencyDef.rate).toFixed(2)} USD</span>
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold block text-muted-foreground">{t('expenses.repeatEvery')}</label>
              <Select
                value={String(recurringForm.intervalDays)}
                onValueChange={(value) => setRecurringForm({ ...recurringForm, intervalDays: Number(value) })}
              >
                <SelectTrigger className="min-h-11 sm:min-h-10 rounded-[14px]">
                  <SelectValue placeholder={t('expenses.selectRepeatInterval')} />
                </SelectTrigger>
                <SelectContent className="rounded-2xl max-h-[min(20rem,60dvh)] overflow-y-auto">
                  {recurringIntervals.map(interval => (
                    <SelectItem key={interval.value} value={String(interval.value)} className="rounded-xl">
                      {getLocalizedInterval(interval)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs font-semibold mb-1 block text-muted-foreground">{t('expenses.startDate')}</label>
              <Input
                type="date"
                value={recurringForm.startDate}
                onChange={(e) => setRecurringForm({ ...recurringForm, startDate: e.target.value })}
                className="h-10 rounded-xl text-xs"
              />
            </div>

            <div>
              <label className="text-xs font-semibold mb-1 block text-muted-foreground">{t('expenses.notes')}</label>
              <Textarea
                placeholder={t('expenses.notesPlaceholder')}
                value={recurringForm.notes}
                onChange={(e) => setRecurringForm({ ...recurringForm, notes: e.target.value })}
                rows={2}
                className="rounded-xl text-xs resize-none"
              />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="payToday"
                checked={recurringForm.payImmediately}
                onCheckedChange={(checked) => setRecurringForm({ ...recurringForm, payImmediately: !!checked })}
              />
              <label
                htmlFor="payToday"
                className="text-xs font-medium leading-none cursor-pointer select-none text-foreground"
              >
                {t('expenses.payTodayImmediately')}
              </label>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="autoPay"
                checked={recurringForm.autoPay}
                onCheckedChange={(checked) => setRecurringForm({ ...recurringForm, autoPay: !!checked })}
              />
              <label
                htmlFor="autoPay"
                className="text-xs font-medium leading-none cursor-pointer select-none text-foreground"
              >
                {t('expenses.autoPayDescription')}
              </label>
            </div>
          </DialogBody>
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 bg-muted/30 border-t border-border/60">
            <Button variant="outline" size="default" onClick={() => setShowRecurringDialog(false)}>
              {t('expenses.cancel')}
            </Button>
            <Button variant="default" size="default" onClick={handleAddRecurringExpense}>
              <Save className="w-4 h-4" />
              {t('expenses.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Recurring Expenses List Dialog */}
      <Dialog open={showRecurringListDialog} onOpenChange={setShowRecurringListDialog}>
        <DialogContent className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] rounded-[24px] p-0 overflow-hidden border border-border shadow-2xl modal-dot-expand bg-card text-sm flex flex-col">
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 bg-muted/40 border-b border-border/60 text-start pe-12">
            <DialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <Settings2 className="w-4 h-4" />
              </div>
              <span>{t('expenses.manageFixed')}</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground ms-10">
              {t('expenses.recurringSubtitle')}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-2 overscroll-contain">
            {recurringExpenses.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
                <RefreshCw className="w-12 h-12 text-muted-foreground/50 mb-3" />
                <p className="text-sm font-semibold text-foreground">{t('expenses.noFixedExpenses')}</p>
              </div>
            ) : (
              recurringExpenses.map(expense => {
                const todayStr = toLocalDateString(new Date());
                const isPaidToday = expense.lastPaidDate === todayStr;
                const dueDate = new Date(expense.nextDueDate || todayStr);
                dueDate.setHours(0, 0, 0, 0);
                const todayDate = new Date();
                todayDate.setHours(0, 0, 0, 0);
                const isDue = (dueDate <= todayDate || !expense.nextDueDate) && !isPaidToday && (expense.isActive !== false);

                return (
                  <div key={expense.id} className="flex items-center justify-between bg-muted/40 border border-border/50 rounded-2xl p-3 gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-bold text-xs truncate text-foreground">{expense.name}</p>
                        {isPaidToday && (
                          <Badge variant="outline" className="bg-success/15 text-success border-success/30">
                            {t('expenses.paidTodayBadge')}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground font-mono">
                        <span dir="ltr" className="inline-block font-bold text-foreground tabular-nums">{expense.currency && expense.currency !== 'USD' && expense.exchangeRate ? `${m.roundForCurrency(m.fromUsd(expense.amount, expense.currency, expense.exchangeRate), expense.currency)} ${expense.currency} (≈ ${m.fmt(expense.amount)})` : m.fmt(expense.amount)}</span> - {t('expenses.every')} {expense.intervalDays} {t('expenses.days')}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono flex items-center gap-1.5 flex-wrap">
                        <span>{t('expenses.nextDue')}: <span dir="ltr" className="inline-block tabular-nums">{expense.nextDueDate}</span></span>
                        {expense.lastPaidDate && (
                          <span>({t('expenses.lastPaid')}: <span dir="ltr" className="inline-block tabular-nums">{expense.lastPaidDate}</span>)</span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isPaidToday ? (
                        <Button
                          size="sm"
                          disabled
                          className="text-xs bg-muted text-muted-foreground gap-1 rounded-xl font-bold cursor-not-allowed opacity-60"
                          title={t('expenses.paidTodayBadge')}
                        >
                          <Check className="w-3.5 h-3.5" />
                          {t('expenses.paidTodayBadge')}
                        </Button>
                      ) : !isDue ? (
                        <Button
                          size="sm"
                          disabled
                          variant="outline"
                          className="text-xs text-muted-foreground gap-1 rounded-xl font-medium cursor-not-allowed opacity-50"
                          title={t('expenses.notDueYet')}
                        >
                          <Calendar className="w-3.5 h-3.5" />
                          {t('expenses.notDueYet')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          className="text-xs bg-success hover:bg-success/90 text-success-foreground gap-1 rounded-xl font-bold shadow-sm"
                          onClick={() => openPayConfirmDialog(expense)}
                          title={t('expenses.payNow')}
                        >
                          <Check className="w-3.5 h-3.5" />
                          {t('expenses.pay')}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-primary hover:text-primary hover:bg-primary/10"
                        onClick={() => handleOpenEditRecurring(expense)}
                        title={t('common.edit')}
                        aria-label={t('common.edit')}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleDeleteRecurring(expense.id)}
                        title={t('common.delete')}
                        aria-label={t('common.delete')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </DialogBody>
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 bg-muted/30 border-t border-border/60">
            <Button variant="outline" size="default" onClick={() => setShowRecurringListDialog(false)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Recurring Expense Dialog */}
      <Dialog open={showEditRecurringDialog} onOpenChange={setShowEditRecurringDialog}>
        <DialogContent
          className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] rounded-[24px] p-0 overflow-hidden border border-border shadow-2xl modal-dot-expand bg-card text-sm flex flex-col"
          onPointerDownOutside={(e) => { if (editRecurringForm.name.trim() || editRecurringForm.amount > 0) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (editRecurringForm.name.trim() || editRecurringForm.amount > 0) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 bg-muted/40 border-b border-border/60 text-start pe-12">
            <DialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <Pencil className="w-4 h-4" />
              </div>
              <span>{t('expenses.editRecurring')}</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground ms-10">
              {t('expenses.editRecurringDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4 overscroll-contain">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold block text-muted-foreground">{t('expenses.expenseName')}</label>
              <Input
                placeholder={t('expenses.expenseNamePlaceholder')}
                value={editRecurringForm.name}
                onChange={(e) => setEditRecurringForm({ ...editRecurringForm, name: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold block text-muted-foreground">{t('expenses.expenseType')}</label>
              <Select
                value={editRecurringForm.type}
                onValueChange={(value: ExpenseType) => setEditRecurringForm({ ...editRecurringForm, type: value })}
              >
                <SelectTrigger className="min-h-11 sm:min-h-10 rounded-[14px]">
                  <SelectValue placeholder={t('expenses.selectExpenseType')} />
                </SelectTrigger>
                <SelectContent className="rounded-2xl max-h-[min(20rem,60dvh)] overflow-y-auto">
                  {expenseTypes.map(type => (
                    <SelectItem key={type.value} value={type.value} className="rounded-xl">
                      {getLocalizedExpenseType(type.value, type.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Currency Selector for Editing Recurring Expense */}
            <div className="flex items-center justify-between bg-muted/30 px-3 py-1.5 rounded-xl border border-border/60">
              <span className="text-xs font-semibold text-muted-foreground">عملة المصروف:</span>
              <div className="flex items-center gap-1 bg-background p-0.5 rounded-lg border border-border/60">
                {m.enabledCurrencies.map((curr) => (
                  <button
                    key={curr.code}
                    type="button"
                    onClick={() => setEditRecurringForm({ ...editRecurringForm, currency: curr.code })}
                    className={cn(
                      "px-2.5 py-1 text-xs font-bold rounded-md transition-all flex items-center gap-1",
                      (editRecurringForm.currency || m.activeCode) === curr.code
                        ? "bg-primary text-primary-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <span>{curr.symbol}</span>
                    <span>{curr.code}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold mb-1 block text-muted-foreground">
                {t('expenses.amount')} ({editRecurringCurrencyDef.symbol})
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-xs font-bold font-mono text-muted-foreground">
                  {editRecurringCurrencyDef.symbol}
                </span>
                <Input
                  dir="ltr"
                  type="number"
                  placeholder="0.00"
                  value={editRecurringForm.amount || ''}
                  onChange={(e) => setEditRecurringForm({ ...editRecurringForm, amount: Number(e.target.value) })}
                  min="0"
                  className="ps-9 font-mono text-sm font-bold tabular-nums"
                />
              </div>
              {(editRecurringForm.currency || m.activeCode) !== 'USD' && editRecurringForm.amount > 0 && (
                <p className="text-xs text-muted-foreground font-mono mt-1">
                  <span dir="ltr" className="inline-block tabular-nums">≈ ${m.toUsd(editRecurringForm.amount, editRecurringForm.currency || m.activeCode, editRecurringCurrencyDef.rate).toFixed(2)} USD</span>
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold block text-muted-foreground">{t('expenses.repeatEvery')}</label>
              <Select
                value={String(editRecurringForm.intervalDays)}
                onValueChange={(value) => setEditRecurringForm({ ...editRecurringForm, intervalDays: Number(value) })}
              >
                <SelectTrigger className="min-h-11 sm:min-h-10 rounded-[14px]">
                  <SelectValue placeholder={t('expenses.selectRepeatInterval')} />
                </SelectTrigger>
                <SelectContent className="rounded-2xl max-h-[min(20rem,60dvh)] overflow-y-auto">
                  {recurringIntervals.map(interval => (
                    <SelectItem key={interval.value} value={String(interval.value)} className="rounded-xl">
                      {getLocalizedInterval(interval)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs font-semibold mb-1 block text-muted-foreground">{t('expenses.notes')}</label>
              <Textarea
                placeholder={t('expenses.notesPlaceholder')}
                value={editRecurringForm.notes}
                onChange={(e) => setEditRecurringForm({ ...editRecurringForm, notes: e.target.value })}
                rows={2}
                className="rounded-xl text-xs resize-none"
              />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="editAutoPay"
                checked={editRecurringForm.autoPay}
                onCheckedChange={(checked) => setEditRecurringForm({ ...editRecurringForm, autoPay: !!checked })}
              />
              <label
                htmlFor="editAutoPay"
                className="text-xs font-medium leading-none cursor-pointer select-none text-foreground"
              >
                {t('expenses.autoPayDescription')}
              </label>
            </div>
          </DialogBody>
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 bg-muted/30 border-t border-border/60">
            <Button variant="outline" size="default" onClick={() => setShowEditRecurringDialog(false)}>
              {t('expenses.cancel')}
            </Button>
            <Button variant="default" size="default" onClick={handleUpdateRecurringExpense}>
              <Save className="w-4 h-4" />
              {t('expenses.saveChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pay Confirmation Dialog */}
      <AlertDialog open={showPayConfirmDialog} onOpenChange={setShowPayConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader className="text-start">
            <AlertDialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-success/15 text-success flex items-center justify-center shrink-0">
                <Check className="w-4 h-4" />
              </div>
              <span>{t('expenses.confirmPayExpense')}</span>
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground pt-2">
              {t('expenses.payExpenseConfirm').replace('{name}', selectedRecurring?.name || '').replace('{amount}', selectedRecurring ? m.fmt(selectedRecurring.amount) : '0')}
              <span className="block mt-2 font-medium text-success">
                💰 {t('expenses.confirmDeductFromCashbox')}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPaying}>{t('expenses.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handlePayRecurring}
              disabled={isPaying}
              className="bg-success hover:bg-success/90 text-success-foreground disabled:opacity-50"
            >
              {isPaying ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Check className="w-4 h-4" />
              )}
              {isPaying ? t('common.loading') : t('expenses.payNow')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete/Refund Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader className="text-start">
            <AlertDialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-warning/15 text-warning flex items-center justify-center shrink-0">
                <RotateCcw className="w-4 h-4" />
              </div>
              <span>{t('expenses.reverseExpense')}</span>
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground pt-2">
              {t('expenses.deleteConfirmDesc').replace('{name}', selectedExpense ? getLocalizedExpenseType(selectedExpense.type, selectedExpense.typeLabel) : '').replace('{amount}', formatNumber(selectedExpense?.amount || 0))}
              <span className="block mt-2 font-medium text-success">
                💰 {t('expenses.reverseExpenseNote')}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('expenses.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteExpense} className="bg-warning hover:bg-warning/90 text-warning-foreground">
              {t('expenses.confirmReverse')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
