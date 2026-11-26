import { isSyncPendingSubscription, SYNC_PENDING_SUBSCRIPTION_SHORT } from '@/lib/subscription-lock';
import { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ListPageSkeleton } from '@/components/ui/page-skeleton';
import {
  Search,
  Plus,
  Phone,
  Calendar,
  Banknote,
  AlertTriangle,
  Clock,
  CheckCircle,
  Eye,
  CreditCard,
  Save,
  Loader2,
  User,
  Share2,
  Trash2,
  FileX2,
  MoreVertical
} from 'lucide-react';
import { cn, formatNumber, formatCurrency, formatMoney, formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader } from '@/components/layout/PageHeader';
import { DatePicker } from '@/components/ui/date-picker';
import { toast } from '@/lib/sonner-bridge';
import { getEquivalentCurrencies } from '@/lib/currencies';
import { showSmartToast } from '@/hooks/use-smart-toast';
import { useCurrency, formatInCurrency, loadDefaultCurrencyCode, loadEnabledCurrencies } from '@/hooks/use-currency';
import { resolveCurrencyMeta } from '@/lib/currencies';
import { EVENTS, emitEvent } from '@/lib/events';
import {
  loadDebtsCloud,
  addDebtCloud,
  recordPaymentWithInvoiceSyncCloud,
  resolveDebtFxPolicyCloud,
  getDebtsStatsCloud,
  deleteDebtCloud,
  getNextManualDebtId,
  Debt,
  invalidateDebtsCache,
} from '@/lib/cloud/debts-cloud';
import { debtCreditUsd, maxPayableInCurrency, type DebtFxPolicy } from '@/lib/debt-fx';
import { getInvoiceByIdCloud, InvoiceItem } from '@/lib/cloud/invoices-cloud';
import { confirmPendingProfit } from '@/lib/partners-store';
import { updateCustomerStatsCloud } from '@/lib/cloud/customers-cloud';
import { useActionGuard } from '@/hooks/use-action-guard';
import { useUserRole } from '@/hooks/user-role-context';
import { invalidateProfitLedgerCache } from '@/lib/cloud/profit-ledger-cloud';
import { writeOffDebtNowCloud } from '@/lib/cloud/accounting-admin-cloud';
import { invalidatePartnersCache } from '@/lib/cloud/partners-cloud';
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
import { addActivityLog } from '@/lib/activity-log';
import { useAuth } from '@/hooks/auth-context';
import { useLanguage } from '@/hooks/language-context';
import { useMoney } from '@/hooks/use-money';
import { processDebtPayment } from '@/lib/unified-transactions';
import { shareDebt, DebtShareData } from '@/lib/native-share';
import { useSubscriptionLocked } from '@/hooks/use-subscription-lock';
import { SUBSCRIPTION_REQUIRED_MESSAGE } from '@/lib/subscription-lock';

interface DebtsProps {
  embedded?: boolean;
  onAddDebt?: boolean;
  onAddDebtChange?: (open: boolean) => void;
}

export default function Debts({ embedded, onAddDebt, onAddDebtChange }: DebtsProps) {
  // التجربة المجانية: الديون للعرض فقط (لا إضافة ولا تعديل ولا تسديد ولا حذف)
  const subscriptionLocked = useSubscriptionLocked();
  const rejectIfLocked = (): boolean => {
    if (!subscriptionLocked) return false;
    toast.error(SUBSCRIPTION_REQUIRED_MESSAGE);
    return true;
  };
  const { user, profile } = useAuth();
  const { t, language } = useLanguage();
  const isEn = language === 'en';
  const m = useMoney();
  const [searchParams, setSearchParams] = useSearchParams();
  const [debts, setDebts] = useState<Debt[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFilter, setSelectedFilter] = useState('active');
  const { currencyCode, currencySymbol, exchangeRate } = useCurrency();
  const isNonUsd = currencyCode !== 'USD';

  // Dialogs
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [showViewDialog, setShowViewDialog] = useState(false);
  const [showAddDebtDialog, setShowAddDebtDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  // شطب الدين كدين معدوم: لمالك المتجر فقط (والخادم يتحقق أيضاً)
  const [showWriteoffDialog, setShowWriteoffDialog] = useState(false);
  const [writeoffReason, setWriteoffReason] = useState('');
  const [selectedDebt, setSelectedDebt] = useState<Debt | null>(null);
  const paymentBusyRef = useRef(false);
  const paymentOpIdRef = useRef(`debtpay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const autoOpenProcessedRef = useRef<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const deleteGuard = useActionGuard();
  const writeoffGuard = useActionGuard();
  const { isAdmin: isStoreOwnerRole, isBoss: isBossRole } = useUserRole();
  const canWriteOffDebts = isStoreOwnerRole || isBossRole;
  const isSavingRef = useRef(false);
  const [paymentAmount, setPaymentAmount] = useState(0);
  const [paymentCurrency, setPaymentCurrency] = useState<string>(() => loadDefaultCurrencyCode());
  // F-27: policy for crediting a foreign-currency payment at the invoice's original rate (null = legacy)
  const [fxPolicy, setFxPolicy] = useState<DebtFxPolicy | null>(null);
  const [paymentAmountInput, setPaymentAmountInput] = useState<string>('');
  const enabledCurrencies = useMemo(() => loadEnabledCurrencies(), []);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [debtItems, setDebtItems] = useState<InvoiceItem[]>([]);
  const [isLoadingItems, setIsLoadingItems] = useState(false);

  // Form for adding cash debt
  const [newDebtForm, setNewDebtForm] = useState({
    customerName: '',
    customerPhone: '',
    amount: 0,
    dueDate: '',
    notes: '',
  });

  const statusConfig: Record<string, { label: string; icon: typeof Clock; color: string }> = {
    pending: { label: isEn ? 'Syncing' : 'قيد المزامنة', icon: Clock, color: 'badge-warning' },
    due: { label: t('debts.statusDue'), icon: Clock, color: 'badge-info' },
    partially_paid: { label: t('debts.statusPartiallyPaid'), icon: Banknote, color: 'badge-warning' },
    overdue: { label: t('debts.statusOverdue'), icon: AlertTriangle, color: 'badge-danger' },
    fully_paid: { label: t('debts.statusFullyPaid'), icon: CheckCircle, color: 'badge-success' },
  };

  const filterOptions = [
    { key: 'active', label: isEn ? 'Active Debts' : 'الديون النشطة' },
    { key: 'fully_paid', label: isEn ? 'Paid Debts' : 'الديون المسددة' },
    { key: 'all', label: t('common.all') },
    { key: 'due', label: t('debts.statusDue') },
    { key: 'partially_paid', label: t('debts.statusPartiallyPaid') },
    { key: 'overdue', label: t('debts.statusOverdue') },
  ];

  // Load debts from store
  useEffect(() => {
    const loadData = async () => {
      try {
        const debtsData = await loadDebtsCloud();
        setDebts(debtsData);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();

    // Listen for updates
    const handleUpdate = () => loadData();
    window.addEventListener(EVENTS.DEBTS_UPDATED, handleUpdate);
    window.addEventListener(EVENTS.APP_REFRESH, handleUpdate);

    return () => {
      window.removeEventListener(EVENTS.DEBTS_UPDATED, handleUpdate);
      window.removeEventListener(EVENTS.APP_REFRESH, handleUpdate);
    };
  }, []);

  // Sync embedded add debt dialog (runs only when the onAddDebt prop changes; reads the latest callbacks)
  const addDebtSyncRef = useRef({ rejectIfLocked, onAddDebtChange });
  addDebtSyncRef.current = { rejectIfLocked, onAddDebtChange };
  useEffect(() => {
    if (onAddDebt !== undefined) {
      if (onAddDebt && addDebtSyncRef.current.rejectIfLocked()) {
        addDebtSyncRef.current.onAddDebtChange?.(false);
        return;
      }
      setShowAddDebtDialog(onAddDebt);
    }
  }, [onAddDebt]);

  // Notify parent when dialog closes
  const handleAddDebtDialogChange = (open: boolean) => {
    if (open && rejectIfLocked()) return;
    setShowAddDebtDialog(open);
    onAddDebtChange?.(open);
  };

  // Fetch items for selected debt
  useEffect(() => {
    const fetchItems = async () => {
      if (!selectedDebt || selectedDebt.isCashDebt || !selectedDebt.invoiceId) {
        setDebtItems([]);
        return;
      }

      setIsLoadingItems(true);
      try {
        const invoice = await getInvoiceByIdCloud(selectedDebt.invoiceId);
        if (invoice && invoice.items) {
          setDebtItems(invoice.items);
        } else {
          setDebtItems([]);
        }
      } catch (error) {
        console.error('Error fetching debt items:', error);
        setDebtItems([]);
      } finally {
        setIsLoadingItems(false);
      }
    };

    fetchItems();
  }, [selectedDebt]);

  // Auto-open payment dialog when coming from invoices page
  useEffect(() => {
    const invoiceId = searchParams.get('invoiceId');
    const autoOpen = searchParams.get('autoOpenPayment');

    if (!invoiceId || autoOpen !== 'true') return;
    if (autoOpenProcessedRef.current === invoiceId) return;

    let isMounted = true;

    const findAndOpenPayment = async () => {
      let list = debts;
      if (list.length === 0) {
        list = await loadDebtsCloud();
        if (isMounted && list.length > 0) {
          setDebts(list);
        }
      }

      if (!isMounted) return;

      const targetDebt = list.find(d => d.invoiceId === invoiceId || d.id === invoiceId);
      if (targetDebt && targetDebt.remainingDebt > 0) {
        autoOpenProcessedRef.current = invoiceId;
        openPaymentDialogRef.current(targetDebt);
        setSearchParams({}, { replace: true });
      }
    };

    findAndOpenPayment();

    return () => {
      isMounted = false;
    };
  }, [debts, searchParams, setSearchParams]);

  const filteredDebts = debts.filter(debt => {
    const matchesSearch = debt.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      debt.customerPhone.includes(searchQuery) ||
      debt.invoiceId.toLowerCase().includes(searchQuery.toLowerCase());
    
    let matchesFilter = true;
    if (selectedFilter === 'active') {
      matchesFilter = debt.remainingDebt > 0 && debt.status !== 'fully_paid';
    } else if (selectedFilter === 'fully_paid') {
      matchesFilter = debt.remainingDebt <= 0 || debt.status === 'fully_paid';
    } else if (selectedFilter !== 'all') {
      matchesFilter = debt.status === selectedFilter;
    }

    return matchesSearch && matchesFilter;
  });

  const [stats, setStats] = useState({ total: 0, remaining: 0, paid: 0, overdue: 0, count: 0, activeCount: 0 });

  useEffect(() => {
    getDebtsStatsCloud().then(setStats);
  }, [debts]);

  const availableCurrencies = m.enabledCurrencies;
  const currentDef = m.getCurrencyDef(paymentCurrency);
  const currentRate = paymentCurrency === 'USD' ? 1 : (currentDef.rate > 0 ? currentDef.rate : 1);

  const currencySymbols = useMemo(() => {
    const map: Record<string, string> = {};
    availableCurrencies.forEach(c => { map[c.code] = c.symbol; });
    return map;
  }, [availableCurrencies]);

  const currencyNames = useMemo(() => {
    const map: Record<string, string> = {};
    availableCurrencies.forEach(c => { map[c.code] = c.name; });
    return map;
  }, [availableCurrencies]);

  const amountUSD = useMemo(() => {
    const val = parseFloat(paymentAmountInput) || 0;
    if (val <= 0) return 0;
    return m.toUsd(val, paymentCurrency, currentRate);
  }, [paymentAmountInput, paymentCurrency, currentRate, m]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedDebt) { setFxPolicy(null); return; }
    resolveDebtFxPolicyCloud(selectedDebt, paymentCurrency).then(p => { if (!cancelled) setFxPolicy(p); });
    return () => { cancelled = true; };
  }, [selectedDebt, paymentCurrency]);

  const maxInCurrency = useMemo(() => {
    if (!selectedDebt) return 0;
    if (fxPolicy) return m.roundForCurrency(maxPayableInCurrency(selectedDebt.remainingDebt, fxPolicy, currentRate), paymentCurrency);
    const raw = m.fromUsd(selectedDebt.remainingDebt, paymentCurrency, currentRate);
    return m.roundForCurrency(raw, paymentCurrency);
  }, [selectedDebt, paymentCurrency, currentRate, m, fxPolicy]);

  const openPaymentDialog = async (debt: Debt) => {
    if (rejectIfLocked()) return;
    // ✅ منع تسديد دين مرتبط بفاتورة مستردة
    if (debt.invoiceId && !debt.isCashDebt) {
      try {
        const { getInvoiceByIdCloud } = await import('@/lib/cloud/invoices-cloud');
        const invoice = await getInvoiceByIdCloud(debt.invoiceId);
        if (invoice && invoice.status === 'refunded') {
          toast.warning(isEn ? '⚠️ This debt is linked to a refunded invoice' : '⚠️ هذا الدين مرتبط بفاتورة مستردة', {
            description: isEn ? `Invoice #${debt.invoiceId} has already been refunded. This debt cannot be paid.` : `الفاتورة رقم ${debt.invoiceId} تم استردادها مسبقاً. لا يمكن تسديد هذا الدين.`,
            duration: 5000,
          });
          return;
        }
      } catch (err) {
        console.warn('[openPaymentDialog] Could not verify invoice status:', err);
      }
    }
    let fresh = debt;
    try {
      invalidateDebtsCache();
      const list = await loadDebtsCloud();
      setDebts(list);
      fresh = list.find(d => d.id === debt.id) || debt;
    } catch { /* use cached */ }
    paymentOpIdRef.current = `debtpay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setSelectedDebt(fresh);
    setPaymentCurrency(loadDefaultCurrencyCode());
    setPaymentAmountInput('');
    setPaymentAmount(0);
    setShowPaymentDialog(true);
  };
  // The auto-open effect above calls the latest version without re-running on every render
  const openPaymentDialogRef = useRef(openPaymentDialog);
  openPaymentDialogRef.current = openPaymentDialog;

  const openViewDialog = (debt: Debt) => {
    setSelectedDebt(debt);
    setShowViewDialog(true);
  };

  // Share debt via native share (works on Android)
  const handleShareDebt = async (debt: Debt) => {
    // Load store settings
    let storeName = 'PosFlow';
    let storePhone = '';
    let currencySymbol = '$';
    try {
      const settingsRaw = localStorage.getItem('posflow_settings_v1');
      if (settingsRaw) {
        const settings = JSON.parse(settingsRaw);
        storeName = settings.storeSettings?.name || storeName;
        storePhone = settings.storeSettings?.phone || '';
        currencySymbol = settings.currencySymbol || '$';
      }
    } catch { /* intentionally empty */ }

    const shareData: DebtShareData = {
      customerName: debt.customerName,
      customerPhone: debt.customerPhone,
      totalDebt: debt.totalDebt,
      remainingDebt: debt.remainingDebt,
      currencySymbol: currencySymbol || '$',
      currency: currencyCode,
      exchangeRate: exchangeRate,
      invoiceId: debt.invoiceId,
      dueDate: debt.dueDate ? new Date(debt.dueDate).toLocaleDateString(language === 'ar' ? 'ar-SA' : language === 'tr' ? 'tr-TR' : language === 'fa' ? 'fa-IR' : language === 'ku' ? 'ckb-IQ' : 'en-US') : undefined,
    };

    await shareDebt(shareData);
  };

  const handlePayment = async () => {
    if (rejectIfLocked()) return;
    if (paymentBusyRef.current || isSubmitting) return;
    if (!selectedDebt || amountUSD <= 0) {
      toast.error(t('debts.enterValidAmount'));
      return;
    }

    setIsSubmitting(true);
    paymentBusyRef.current = true;

    try {
      // ط§ظ‚ط±ط£ ط§ظ„ط±طµظٹط¯ ط§ظ„ط­ظ‚ظٹظ‚ظٹ ظ…ظ† ط§ظ„ط®ط§ط¯ظ… ظ‚ط¨ظ„ ط§ظ„طھط­ظ‚ظ‚
      invalidateDebtsCache();
      const latestList = await loadDebtsCloud();
      const latest = latestList.find(d => d.id === selectedDebt.id) || selectedDebt;
      const remainingNow = Number(latest.remainingDebt) || 0; // 8 decimals as stored (F-02)

      // F-27: same foreign currency as the invoice -> credit at the invoice rate; cash stays valued at today's rate
      const policy = await resolveDebtFxPolicyCloud(latest, paymentCurrency);
      const foreignPaid = parseFloat(paymentAmountInput) || 0;
      let finalPaymentUSD = amountUSD;
      let creditUsd: number | undefined;
      if (policy) {
        creditUsd = debtCreditUsd(policy, foreignPaid, amountUSD);
        if (creditUsd > remainingNow + 0.05) {
          setDebts(latestList);
          setSelectedDebt(latest);
          toast.error(t('debts.amountExceedsRemaining'));
          return;
        }
      } else if (finalPaymentUSD > remainingNow) {
        // F-26: a difference up to 0.05 USD is absorbed and noted by the SERVER (rounding_adjustment); the client sends the real amount.
        if (finalPaymentUSD - remainingNow <= 0.05) {
          // keep finalPaymentUSD as entered
        } else {
          setDebts(latestList);
          setSelectedDebt(latest);
          toast.error(t('debts.amountExceedsRemaining'));
          return;
        }
      }

      const paymentRatio = remainingNow > 0 ? Math.min(1, (creditUsd ?? finalPaymentUSD) / remainingNow) : 1;

      const { getActiveShift } = await import('@/lib/cashbox-store');
      const activeShift = getActiveShift();
      const currentShiftId = activeShift?.id || undefined;

      await recordPaymentWithInvoiceSyncCloud(
        selectedDebt.id,
        finalPaymentUSD,
        paymentOpIdRef.current,
        paymentCurrency,
        parseFloat(paymentAmountInput) || finalPaymentUSD,
        currentDef.rate,
        'cash',
        currentShiftId,
        creditUsd
      );
      paymentOpIdRef.current = `debtpay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // ✅ إضافة المبلغ للصندوق وتحديث الوردية بالعملة
      processDebtPayment(
        finalPaymentUSD,
        selectedDebt.customerId,
        user?.id,
        profile?.full_name || user?.email || t('common.user'),
        paymentCurrency,
        parseFloat(paymentAmountInput) || finalPaymentUSD,
        'cash'
      );

      // Confirm pending profits proportionally to payment (ظ…ط­ظ„ظٹط§ظ‹ + ط³ط­ط§ط¨ظٹط§ظ‹)
      confirmPendingProfit(selectedDebt.invoiceId, paymentRatio);

      // ✅ إعادة احتساب أرقام العميل من الفواتير النشطة بعد السداد فورياً
      try {
        const { loadCustomersCloud, updateCustomerStatsCloud, invalidateCustomersCache } = await import('@/lib/cloud/customers-cloud');
        const { invalidateInvoicesCache } = await import('@/lib/cloud/invoices-cloud');
        const { invalidatePartnersCache } = await import('@/lib/cloud/partners-cloud');
        invalidateInvoicesCache();
        invalidateCustomersCache();
        invalidatePartnersCache();
        const customers = await loadCustomersCloud();
        const customer = customers.find(c =>
          c.name.trim().toLowerCase() === (selectedDebt.customerName || '').trim().toLowerCase() ||
          (selectedDebt.customerPhone && c.phone === selectedDebt.customerPhone)
        );
        if (customer) await updateCustomerStatsCloud(customer.id);
      } catch (err) {
        console.warn('[Debts] Failed to update customer stats cloud:', err);
      }
      emitEvent(EVENTS.CUSTOMERS_UPDATED, null);

      // Log activity
      if (user) {
        const currDesc = paymentCurrency !== 'USD'
          ? (isEn ? `${paymentAmountInput} ${paymentCurrency} (equivalent to ${formatMoney(finalPaymentUSD, 'USD')} at rate ${currentRate})` : `${paymentAmountInput} ${paymentCurrency} (يعادل ${formatMoney(finalPaymentUSD, 'USD')} بسعر صرف ${currentRate})`)
          : formatMoney(finalPaymentUSD, paymentCurrency);
        addActivityLog(
          'debt_paid',
          user.id,
          profile?.full_name || user.email || t('common.user'),
          `${t('debts.paymentRecorded')} ${currDesc} - ${selectedDebt.customerName}`,
          {
            debtId: selectedDebt.id,
            invoiceId: selectedDebt.invoiceId,
            customerName: selectedDebt.customerName,
            amountUSD: finalPaymentUSD,
            amountInCurrency: parseFloat(paymentAmountInput) || finalPaymentUSD,
            currency: paymentCurrency,
            rate: currentRate,
            paymentMethod: 'cash',
            totalDebt: latest.totalDebt,
            remainingBefore: remainingNow,
            remainingAfter: Math.max(0, Math.round((remainingNow - finalPaymentUSD) * 100) / 100),
          }
        );
      }

      const debtsData = await loadDebtsCloud();
      setDebts(debtsData);

      setShowPaymentDialog(false);
      const paidAmountSnapshot = finalPaymentUSD;
      const customerSnapshot = selectedDebt?.customerName;
      setSelectedDebt(null);
      setPaymentAmountInput('');
      setPaymentAmount(0);
      showSmartToast({
        type: 'debt_sale',
        title: isEn ? 'Debt payment recorded successfully' : 'تم تسجيل دفعة الدين بنجاح',
        subtitle: customerSnapshot ? (isEn ? `Customer: ${customerSnapshot}` : `العميل: ${customerSnapshot}`) : undefined,
        primaryLabel: isEn ? 'Amount Paid' : 'المبلغ المدفوع',
        primaryValue: `${paidAmountSnapshot} ${paymentCurrency}`,
        operation: isEn ? 'Debt Payment' : 'سداد دين',
        duration: 4000,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Failed to record payment' : 'فشل تسجيل الدفعة'));
    } finally {
      paymentBusyRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleAddCashDebt = async () => {
    if (rejectIfLocked()) return;
    // ✅ حماية من التكرارات
    if (isSavingRef.current) return;

    if (!newDebtForm.customerName || !newDebtForm.customerPhone || newDebtForm.amount <= 0) {
      toast.error(t('debts.fillRequiredFields'));
      return;
    }

    if (!newDebtForm.dueDate) {
      toast.error(t('debts.selectDueDate'));
      return;
    }

    isSavingRef.current = true;

    try {
      const manualDebtId = await getNextManualDebtId();
      await addDebtCloud({
        invoiceId: manualDebtId,
        customerName: newDebtForm.customerName,
        customerPhone: newDebtForm.customerPhone,
        totalDebt: newDebtForm.amount,
        dueDate: newDebtForm.dueDate,
        notes: newDebtForm.notes,
        isCashDebt: true,
      });

      // Log activity
      if (user) {
        addActivityLog(
          'debt_created',
          user.id,
          profile?.full_name || user.email || t('common.user'),
          `${t('debts.cashDebtCreated')} ${newDebtForm.customerName} - ${formatCurrency(newDebtForm.amount)}`,
          { amount: newDebtForm.amount, customerName: newDebtForm.customerName, isCashDebt: true }
        );
      }

      const debtsData = await loadDebtsCloud();
      setDebts(debtsData);
      handleAddDebtDialogChange(false);
      const addedDebtCustomer = newDebtForm.customerName;
      const addedDebtAmount = newDebtForm.amount;
      const addedDebtCurrency = 'USD';
      setNewDebtForm({
        customerName: '',
        customerPhone: '',
        amount: 0,
        dueDate: '',
        notes: '',
      });
      showSmartToast({
        type: 'debt_sale',
        title: t('debts.debtAddedSuccess') || (isEn ? 'Debt added successfully' : 'تمت إضافة الدين بنجاح'),
        subtitle: isEn ? `Customer: ${addedDebtCustomer}` : `العميل: ${addedDebtCustomer}`,
        primaryLabel: isEn ? 'Debt Amount' : 'قيمة الدين',
        primaryValue: `${addedDebtAmount} ${currencySymbols?.[addedDebtCurrency] || addedDebtCurrency}`,
        operation: isEn ? 'New Debt' : 'دين جديد',
        duration: 4000,
      });
    } finally {
      isSavingRef.current = false;
    }
  };

  return (
    <div className={cn(!embedded && "p-3 sm:p-4 md:p-6", "space-y-4 md:space-y-6")}>
      {!embedded && (
        <PageHeader
          title={t('debts.title') || (isEn ? 'Debts' : 'الديون')}
          icon={<CreditCard className="w-5 h-5" />}
          actions={
            <Button variant="default" size="default" onClick={() => handleAddDebtDialogChange(true)}>
              <Plus className="w-4 h-4 shrink-0" />
              <span>{t('debts.addCashDebt')}</span>
            </Button>
          }
        />
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 text-center select-none">
        <div className="bg-card py-2.5 px-2 rounded-xl border border-border shadow-xs">
          <span className="text-xs text-muted-foreground font-medium block truncate">{t('debts.total')}</span>
          <span dir="ltr" className="inline-block tabular-nums text-sm font-bold text-foreground font-mono whitespace-nowrap">{formatInCurrency(stats.total, currencyCode, exchangeRate).formatted}</span>
          {isNonUsd && <span dir="ltr" className="inline-block tabular-nums text-[11px] text-muted-foreground font-mono block">{formatInCurrency(stats.total, currencyCode, exchangeRate).usdEquivalent}</span>}
        </div>
        <div className="bg-card py-2.5 px-2 rounded-xl border border-border shadow-xs">
          <span className="text-xs text-destructive font-medium block truncate">{t('debts.remaining')}</span>
          <span dir="ltr" className="inline-block tabular-nums text-sm font-bold text-destructive font-mono whitespace-nowrap">{formatInCurrency(stats.remaining, currencyCode, exchangeRate).formatted}</span>
          {isNonUsd && <span dir="ltr" className="inline-block tabular-nums text-[11px] text-muted-foreground font-mono block">{formatInCurrency(stats.remaining, currencyCode, exchangeRate).usdEquivalent}</span>}
        </div>
        <div className="bg-card py-2.5 px-2 rounded-xl border border-border shadow-xs">
          <span className="text-xs text-success font-medium block truncate">{t('debts.paid')}</span>
          <span dir="ltr" className="inline-block tabular-nums text-sm font-bold text-success font-mono whitespace-nowrap">{formatInCurrency(stats.paid, currencyCode, exchangeRate).formatted}</span>
          {isNonUsd && <span dir="ltr" className="inline-block tabular-nums text-[11px] text-muted-foreground font-mono block">{formatInCurrency(stats.paid, currencyCode, exchangeRate).usdEquivalent}</span>}
        </div>
        <div className="bg-card py-2.5 px-2 rounded-xl border border-border shadow-xs">
          <span className="text-xs text-warning font-medium block truncate">{t('debts.overdue')}</span>
          <span dir="ltr" className="inline-block tabular-nums text-sm font-bold text-warning font-mono whitespace-nowrap">{formatInCurrency(stats.overdue, currencyCode, exchangeRate).formatted}</span>
          {isNonUsd && <span dir="ltr" className="inline-block tabular-nums text-[11px] text-muted-foreground font-mono block">{formatInCurrency(stats.overdue, currencyCode, exchangeRate).usdEquivalent}</span>}
        </div>
      </div>

      {/* Filters */}
      <div className="space-y-2">
        <div className="relative flex-1 min-w-0">
          <Search className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder={t('debts.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ps-9 pe-3 bg-card border-border shadow-xs"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {filterOptions.map((filter) => (
            <Button
              key={filter.key}
              type="button"
              size="sm"
              variant={selectedFilter === filter.key ? 'default' : 'outline'}
              onClick={() => setSelectedFilter(filter.key)}
              className="rounded-xl shrink-0"
            >
              {filter.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center justify-between text-muted-foreground text-xs px-1 font-semibold">
          <span>{isEn ? 'Debts List' : 'قائمة الديون'}</span>
          <span className="font-mono"><span dir="ltr" className="inline-block tabular-nums">{filteredDebts.length}</span> {isEn ? "debts shown" : "ديون معروضة"}</span>
        </div>
      </div>

      {/* Debts List */}
      <div className="space-y-2.5">
        {isLoading && debts.length === 0 ? (
          <ListPageSkeleton rows={5} />
        ) : filteredDebts.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
            <CreditCard className="w-12 h-12 text-muted-foreground/50 mb-3" />
            <p className="text-sm sm:text-base font-semibold text-foreground">{isEn ? "No matching debts found" : "لا توجد ديون مطابقة"}</p>
          </div>
        ) : (
          filteredDebts.map((debt) => {
            const status = statusConfig[debt.status] || statusConfig.due;
            const StatusIcon = status.icon || Clock;
            const progress = debt.totalDebt > 0 ? Math.min(100, Math.round((debt.totalPaid / debt.totalDebt) * 100)) : 0;

            return (
              <div
                key={debt.id}
                onClick={() => openViewDialog(debt)}
                className="bg-card rounded-2xl p-3 border border-border shadow-xs relative hover:border-primary/40 active:scale-[0.99] transition-[border-color,transform] cursor-pointer select-none"
              >
                {/* Top-End Options Dropdown */}
                <div className="absolute end-2 top-2 z-10" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={isEn ? 'Options' : 'خيارات'}>
                        <MoreVertical className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-44 text-xs font-bold">
                      {debt.remainingDebt > 0 && (
                        <DropdownMenuItem onClick={() => openPaymentDialog(debt)} className="justify-between cursor-pointer">
                          <span>{isEn ? 'Record Payment' : 'تسديد دفعة'}</span>
                          <Banknote className="w-4 h-4 text-success" />
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => openViewDialog(debt)} className="justify-between cursor-pointer">
                        <span>{isEn ? 'Debt Details' : 'تفاصيل الدين'}</span>
                        <Eye className="w-4 h-4 text-muted-foreground" />
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleShareDebt(debt)} className="justify-between cursor-pointer">
                        <span>{isEn ? 'Share Debt Statement' : 'مشاركة كشف الدين'}</span>
                        <Share2 className="w-4 h-4 text-muted-foreground" />
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {canWriteOffDebts && debt.remainingDebt > 0 && (debt.status as string) !== 'written_off' && (
                        <DropdownMenuItem
                          onClick={() => {
                            setSelectedDebt(debt);
                            if (rejectIfLocked()) return;
                            setWriteoffReason('');
                            setShowWriteoffDialog(true);
                          }}
                          className="justify-between text-warning cursor-pointer"
                        >
                          <span>{isEn ? 'Write Off as Bad Debt' : 'شطب كدين معدوم'}</span>
                          <FileX2 className="w-4 h-4 text-warning" />
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={() => {
                          setSelectedDebt(debt);
                          if (rejectIfLocked()) return;
                          setShowDeleteDialog(true);
                        }}
                        className="justify-between text-destructive cursor-pointer"
                      >
                        <span>{isEn ? 'Delete Debt' : 'حذف الدين'}</span>
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* Header Row: Customer Name & Badges */}
                <div className="flex items-center gap-2 pe-12 flex-wrap min-w-0">
                  <span className="font-bold text-foreground text-sm truncate max-w-full" title={debt.customerName}>{debt.customerName}</span>
                  <Badge variant="outline" className={cn(
                    "gap-1",
                    debt.status === 'fully_paid' ? "bg-success/15 text-success border-success/30" :
                    debt.status === 'overdue' ? "bg-destructive/15 text-destructive border-destructive/30" :
                    debt.status === 'partially_paid' ? "bg-warning/15 text-warning border-warning/30" :
                    "bg-info/15 text-info border-info/30"
                  )}>
                    <StatusIcon className="w-3 h-3" />
                    <span>{status.label}</span>
                  </Badge>
                  {debt.isCashDebt && (
                    <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20">
                      {isEn ? "Cash Advance" : "سلفة نقدية"}
                    </Badge>
                  )}
                  {debt.pending_sync && (
                    <Badge variant="outline" className={cn(
                      debt.sync_failed ? "bg-destructive/15 text-destructive border-destructive/30" : "bg-primary/10 text-primary border-primary/20"
                    )}>
                      {isSyncPendingSubscription() ? SYNC_PENDING_SUBSCRIPTION_SHORT : debt.sync_failed ? (isEn ? 'Sync Failed' : 'فشل المزامنة') : (isEn ? 'Unsynced' : 'غير متزامنة')}
                    </Badge>
                  )}
                </div>

                {/* Meta Tags Row */}
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5 text-xs">
                  <span className="bg-muted text-muted-foreground font-mono px-1.5 py-0.5 rounded font-semibold inline-block tabular-nums" dir="ltr">
                    📞 {debt.customerPhone}
                  </span>
                  {debt.dueDate && (
                    <span className="text-muted-foreground font-medium flex items-center gap-1">
                      📅 {isEn ? "Due:" : "استحقاق:"} <span dir="ltr" className="inline-block tabular-nums">{debt.dueDate}</span>
                    </span>
                  )}
                  {debt.invoiceId && (
                    <span dir="ltr" className="inline-block tabular-nums bg-muted/70 text-muted-foreground font-mono px-1.5 py-0.5 rounded font-semibold">
                      #{debt.invoiceId}
                    </span>
                  )}
                  {debt.cashierName && (
                    <span className="text-primary font-semibold flex items-center gap-0.5 bg-primary/10 px-1.5 py-0.5 rounded ms-auto">
                      👤 {debt.cashierName}
                    </span>
                  )}
                </div>

                {/* Progress Line */}
                <div className="mt-2 space-y-1">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{isEn ? "Repayment:" : "نسبة السداد:"} <b dir="ltr" className="inline-block tabular-nums text-foreground font-mono">{progress}%</b></span>
                    <span>{isEn ? "Principal:" : "الأصل:"} <b dir="ltr" className="inline-block tabular-nums text-foreground font-mono">{formatInCurrency(debt.totalDebt, currencyCode, exchangeRate).formatted}</b>{isNonUsd && <span dir="ltr" className="inline-block tabular-nums text-xs text-muted-foreground font-mono ms-1">({formatInCurrency(debt.totalDebt, currencyCode, exchangeRate).usdEquivalent})</span>}</span>
                  </div>
                  <div className="h-1 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-[width] duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>

                {/* Financial Box */}
                <div className="mt-2.5 pt-2 border-t border-dashed border-border flex items-end justify-between">
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    <div className="font-medium">
                      {isEn ? "Paid:" : "المسدد:"} <span dir="ltr" className="inline-block tabular-nums font-mono font-bold text-success whitespace-nowrap">{formatInCurrency(debt.totalPaid, currencyCode, exchangeRate).formatted}</span>{isNonUsd && <span dir="ltr" className="inline-block tabular-nums text-xs text-muted-foreground font-mono ms-1">({formatInCurrency(debt.totalPaid, currencyCode, exchangeRate).usdEquivalent})</span>}
                    </div>
                  </div>
                  <div className="text-end whitespace-nowrap shrink-0">
                    <span className="text-xs text-muted-foreground block font-sans">{isEn ? "Remaining" : "المتبقي"}</span>
                    <div className="flex flex-col items-end gap-0.5">
                      <span
                        dir="ltr"
                        className={cn(
                          "inline-block tabular-nums text-base font-bold font-mono whitespace-nowrap",
                          debt.remainingDebt > 0 ? "text-destructive" : "text-success"
                        )}
                      >
                        ${Number(debt.remainingDebt || 0).toFixed(2)}
                      </span>
                      {debt.remainingDebt > 0 && (
                        <div className="flex items-center gap-1 mt-0.5 flex-wrap justify-end">
                          {getEquivalentCurrencies(debt.remainingDebt).equivalents.map(eq => (
                            <span key={eq.code} dir="ltr" className="inline-block tabular-nums text-[11px] font-mono px-1.5 py-0.5 bg-muted/80 text-muted-foreground rounded font-semibold">
                              ≈ {eq.formatted}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Add Cash Debt Dialog */}
      <Dialog open={showAddDebtDialog} onOpenChange={handleAddDebtDialogChange}>
        <DialogContent
          className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px] gap-0 border border-border shadow-2xl modal-dot-expand bg-card"
          onPointerDownOutside={(e) => { if (newDebtForm.customerName || newDebtForm.customerPhone || newDebtForm.amount > 0) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (newDebtForm.customerName || newDebtForm.customerPhone || newDebtForm.amount > 0) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 bg-muted/40 border-b border-border/60 text-start pe-12">
            <DialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <Plus className="w-4 h-4" />
              </div>
              <span>{t('debts.addCashDebt')}</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground ms-10">
              {t('debts.addDebtWithoutInvoice')}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold block text-muted-foreground">{t('debts.customerName')} *</label>
              <div className="relative">
                <User className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder={t('debts.customerName')}
                  value={newDebtForm.customerName}
                  onChange={(e) => setNewDebtForm({ ...newDebtForm, customerName: e.target.value })}
                  className="ps-9"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold block text-muted-foreground">{t('common.phone')} *</label>
              <div className="relative">
                <Phone className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="+963 xxx xxx xxx"
                  value={newDebtForm.customerPhone}
                  onChange={(e) => setNewDebtForm({ ...newDebtForm, customerPhone: e.target.value })}
                  className="ps-9 font-mono tabular-nums"
                  dir="ltr"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold block text-muted-foreground">{t('debts.amount')} ($) *</label>
              <div className="relative">
                <Banknote className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type="number"
                  dir="ltr"
                  placeholder="0.00"
                  value={newDebtForm.amount || ''}
                  onChange={(e) => setNewDebtForm({ ...newDebtForm, amount: Number(e.target.value) })}
                  className="ps-9 font-mono tabular-nums font-bold"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold block text-muted-foreground">{t('debts.dueDate')} *</label>
              <DatePicker
                value={newDebtForm.dueDate}
                onChange={(date) => setNewDebtForm({ ...newDebtForm, dueDate: date })}
                placeholder={t('debts.selectDueDate')}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold block text-muted-foreground">{t('common.notes')}</label>
              <Input
                placeholder={t('debts.notesPlaceholder')}
                value={newDebtForm.notes}
                onChange={(e) => setNewDebtForm({ ...newDebtForm, notes: e.target.value })}
              />
            </div>
          </DialogBody>
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 bg-muted/20 border-t border-border/60">
            <Button variant="outline" size="default" onClick={() => handleAddDebtDialogChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="default" size="default" onClick={handleAddCashDebt}>
              <Save className="w-4 h-4" />
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Payment Dialog */}
      <Dialog
        open={showPaymentDialog}
        onOpenChange={(open) => {
          if (!isSubmitting) setShowPaymentDialog(open);
        }}
      >
        <DialogContent
          className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px] gap-0 border border-border shadow-2xl modal-dot-expand bg-card"
          onPointerDownOutside={(e) => { if (isSubmitting || paymentAmountInput) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (isSubmitting || paymentAmountInput) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 bg-muted/40 border-b border-border/60 text-start pe-12">
            <DialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-success/15 text-success flex items-center justify-center shrink-0">
                <Banknote className="w-4 h-4" />
              </div>
              <span>{t('debts.recordPayment')}</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground ms-10">
              {t('debts.recordPaymentFor')} <strong className="text-foreground">{selectedDebt?.customerName}</strong>
            </DialogDescription>
          </DialogHeader>
          {selectedDebt && (
            <DialogBody className="space-y-4">
              <div className="bg-muted/40 border border-border/60 rounded-2xl p-3 space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{t('debts.totalDebt')}</span>
                  <span dir="ltr" className="inline-block tabular-nums font-bold font-mono">{formatCurrency(selectedDebt.totalDebt)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{t('debts.paidSoFar')}</span>
                  <span dir="ltr" className="inline-block tabular-nums font-bold font-mono text-success">{formatCurrency(selectedDebt.totalPaid)}</span>
                </div>
                <div className="flex justify-between pt-2 border-t border-border/60 text-xs">
                  <span className="text-muted-foreground font-semibold">{t('debts.remaining')}</span>
                  <div className="text-end">
                    <span dir="ltr" className="inline-block tabular-nums font-bold font-mono text-sm text-destructive block whitespace-nowrap">{formatCurrency(selectedDebt.remainingDebt)}</span>
                    {paymentCurrency !== 'USD' && (
                      <span dir="ltr" className="inline-block tabular-nums text-[11px] text-muted-foreground block font-mono">
                        ≈ {formatNumber(maxInCurrency)} {currencySymbols[paymentCurrency as keyof typeof currencySymbols] || paymentCurrency}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* اختيار عملة السداد */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground block">{isEn ? "Received Payment Currency" : "عملة الدفع المستلمة"}</label>
                <div className="flex gap-2 flex-wrap">
                  {availableCurrencies.map((curr) => (
                    <button
                      key={curr.code}
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => {
                        setPaymentCurrency(curr.code);
                        setPaymentAmountInput('');
                      }}
                      className={cn(
                        "flex-1 min-w-[5rem] min-h-[3.7rem] p-2 rounded-xl border transition-colors flex flex-col items-center justify-center gap-0.5 leading-tight text-center",
                        isSubmitting && "opacity-50 cursor-not-allowed",
                        paymentCurrency === curr.code
                          ? "bg-primary text-primary-foreground border-primary shadow-sm"
                          : "bg-muted/50 text-muted-foreground border-border hover:bg-muted"
                      )}
                    >
                      <span className="text-xs font-bold">{curr.symbol} {curr.name}</span>
                      <span className="text-[11px] opacity-80">({curr.code})</span>
                    </button>
                  ))}
                </div>
                {paymentCurrency !== 'USD' && (
                  <p className="text-xs text-muted-foreground pt-1 px-1 flex items-center justify-between">
                    <span>{isEn ? "Exchange Rate:" : "سعر الصرف المعتمد:"}</span>
                    <span dir="ltr" className="inline-block tabular-nums font-mono font-bold text-foreground">1 $ = {currentRate} {currencySymbols[paymentCurrency] || paymentCurrency}</span>
                  </p>
                )}
              </div>

              {/* حقل إدخال المبلغ */}
              <div className="space-y-1.5">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-semibold text-muted-foreground">
                    {isEn ? 'Payment Amount' : 'مبلغ الدفعة'} ({currencySymbols[paymentCurrency] || (paymentCurrency === 'USD' ? '$' : paymentCurrency)})
                  </label>
                  {paymentCurrency !== 'USD' && amountUSD > 0 && (
                    <span dir="ltr" className="inline-block tabular-nums text-xs font-bold text-success font-mono">
                      ≈ {currencySymbols.USD}{formatNumber(amountUSD)}
                    </span>
                  )}
                </div>
                <Input
                  type="number"
                  dir="ltr"
                  placeholder="0.00"
                  value={paymentAmountInput}
                  onChange={(e) => setPaymentAmountInput(e.target.value)}
                  max={maxInCurrency}
                  step={paymentCurrency === 'USD' ? "0.01" : "1"}
                  className="text-base font-bold font-mono tabular-nums"
                  disabled={isSubmitting}
                />

                {/* المعادل بالدولار إذا كانت العملة أجنبية */}
                {paymentCurrency !== 'USD' && (
                  <div className="mt-2 p-2.5 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{isEn ? "Amount Deducted from Debt:" : "المبلغ المخصوم من الدين:"}</span>
                    <span dir="ltr" className="inline-block tabular-nums font-bold text-primary font-mono">${formatNumber(amountUSD)}</span>
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 min-h-10 text-xs rounded-xl font-medium"
                    disabled={isSubmitting}
                    onClick={() => setPaymentAmountInput(String(maxInCurrency))}
                  >
                    {t('debts.payFull')} (<span dir="ltr" className="inline-block tabular-nums">{maxInCurrency} {currencySymbols[paymentCurrency] || paymentCurrency}</span>)
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 min-h-10 text-xs rounded-xl font-medium"
                    disabled={isSubmitting}
                    onClick={() => setPaymentAmountInput(String(Math.round((maxInCurrency / 2) * 100) / 100))}
                  >
                    {t('debts.payHalf')}
                  </Button>
                </div>
              </div>
            </DialogBody>
          )}
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 bg-muted/20 border-t border-border/60">
            <Button
              variant="outline"
              size="default"
              disabled={isSubmitting}
              onClick={() => setShowPaymentDialog(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="default"
              size="default"
              onClick={handlePayment}
              disabled={isSubmitting || amountUSD <= 0}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{isEn ? "Processing payment..." : "جاري الدفع..."}</span>
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  <span>{t('debts.confirmPayment')}</span>
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Dialog */}
      <Dialog open={showViewDialog} onOpenChange={setShowViewDialog}>
        <DialogContent className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px] gap-0 border border-border shadow-2xl modal-dot-expand bg-card">
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 bg-muted/40 border-b border-border/60 text-start pe-12">
            <DialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <Eye className="w-4 h-4" />
              </div>
              <span>{t('debts.debtDetails')}</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground ms-10">
              {isEn ? `Debt Details — ${selectedDebt?.customerName || ""}` : `تفاصيل دين ${selectedDebt?.customerName || ""}`}
            </DialogDescription>
          </DialogHeader>
          {selectedDebt && (
            <DialogBody className="space-y-4">
              <div className="flex items-center gap-3 bg-muted/30 p-3 rounded-2xl border border-border/50">
                <div className="w-11 h-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-bold text-base shrink-0">
                  {selectedDebt.customerName.charAt(0)}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm sm:text-base font-semibold truncate text-foreground">{selectedDebt.customerName}</h3>
                  <p className="text-xs text-muted-foreground font-mono"><span dir="ltr" className="inline-block tabular-nums">{selectedDebt.customerPhone}</span></p>
                </div>
              </div>

              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between py-1.5 border-b border-border/50">
                  <span className="text-muted-foreground">{t('debts.invoiceId')}</span>
                  <span dir="ltr" className="inline-block tabular-nums font-semibold font-mono">{selectedDebt.invoiceId}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-border/50">
                  <span className="text-muted-foreground">{t('debts.createdAt')}</span>
                  <span className="inline-block tabular-nums font-semibold" dir="ltr">
                    {formatDateTime(new Date(selectedDebt.createdAt))}
                  </span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-border/50">
                  <span className="text-muted-foreground">{t('debts.dueDate')}</span>
                  <span dir="ltr" className="inline-block tabular-nums font-semibold">{selectedDebt.dueDate}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-border/50">
                  <span className="text-muted-foreground">{t('debts.totalDebt')}</span>
                  <span dir="ltr" className="inline-block tabular-nums font-bold font-mono">{formatCurrency(selectedDebt.totalDebt)}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-border/50">
                  <span className="text-muted-foreground">{t('debts.paid')}</span>
                  <span dir="ltr" className="inline-block tabular-nums font-bold font-mono text-success">{formatCurrency(selectedDebt.totalPaid)}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-border/50">
                  <span className="text-muted-foreground font-bold">{t('debts.remaining')}</span>
                  <span dir="ltr" className="inline-block tabular-nums font-bold font-mono text-sm text-destructive">{formatCurrency(selectedDebt.remainingDebt)}</span>
                </div>
              </div>

              {/* Items Table */}
              {!selectedDebt.isCashDebt && (
                <div className="space-y-1.5 pt-1">
                  <span className="text-xs font-semibold text-muted-foreground">{t('invoices.products')}:</span>
                  {isLoadingItems ? (
                    <div className="py-3 text-center text-xs text-muted-foreground">
                      {isEn ? "Loading..." : "جاري التحميل..."}
                    </div>
                  ) : debtItems.length > 0 ? (
                    <div className="bg-muted/40 rounded-xl p-2.5 space-y-1.5 max-h-36 overflow-y-auto border border-border/50">
                      {debtItems.map((item, idx) => (
                        <div key={idx} className="flex justify-between text-xs py-1 border-b border-border/40 last:border-0">
                          <span className="truncate max-w-[65%]">{item.name} <span dir="ltr" className="inline-block tabular-nums text-muted-foreground font-mono">×{item.quantity}</span></span>
                          <span dir="ltr" className="inline-block tabular-nums font-bold font-mono shrink-0">{formatCurrency(item.total)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-2 text-center text-xs text-muted-foreground italic">
                      {isEn ? "No items found" : "لا توجد أصناف"}
                    </div>
                  )}
                </div>
              )}

              {selectedDebt.notes && (
                <div className="bg-muted/40 rounded-xl p-2.5 border border-border/50">
                  <p className="text-xs text-muted-foreground font-semibold">{t('common.notes')}:</p>
                  <p className="text-xs text-foreground mt-0.5">{selectedDebt.notes}</p>
                </div>
              )}
            </DialogBody>
          )}
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 bg-muted/20 border-t border-border/60">
            <Button
              variant="outline"
              size="default"
              onClick={() => setShowViewDialog(false)}
            >
              {t('common.close') || (isEn ? 'Close' : 'إغلاق')}
            </Button>
            {selectedDebt && selectedDebt.remainingDebt > 0 && (
              <Button
                variant="default"
                size="default"
                onClick={() => {
                  setShowViewDialog(false);
                  openPaymentDialog(selectedDebt);
                }}
              >
                <Banknote className="w-4 h-4" />
                {t('debts.recordPayment')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      {/* شطب الدين كدين معدوم (لمالك المتجر) */}
      <AlertDialog open={showWriteoffDialog} onOpenChange={setShowWriteoffDialog}>
        <AlertDialogContent className="modal-dot-expand">
          <AlertDialogHeader className="text-start">
            <AlertDialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-warning/15 text-warning flex items-center justify-center shrink-0">
                <FileX2 className="w-4 h-4" />
              </div>
              <span>{isEn ? "Write Off Debt as Bad Debt" : "شطب الدين كدين معدوم"}</span>
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground pt-2 leading-relaxed">
              {selectedDebt && (
                <>
                  {isEn ? (<>The remaining debt of <strong>{selectedDebt.customerName}</strong> (<strong dir="ltr" className="inline-block tabular-nums font-mono text-destructive">{formatCurrency(selectedDebt.remainingDebt)}</strong>) will be written off.</>) : (<>سيُشطب المتبقي من دين <strong>{selectedDebt.customerName}</strong> وقيمته <strong dir="ltr" className="inline-block tabular-nums font-mono text-destructive">{formatCurrency(selectedDebt.remainingDebt)}</strong>.</>)}
                  <br />
                  {isEn ? "Pending profit is cancelled and the loss is recorded in the written-off debts log. Invoice debts are distributed among partners by share; cash debts are borne by the owner." : "يُلغى ربحه المعلّق وتُسجَّل الخسارة في سجل الديون المشطوبة. إن كان الدين من فاتورة توزَّع خسارته على الشركاء بنسبهم، وإن كان ديناً نقدياً فكلها على المالك."}
                  <span className="text-destructive font-medium mt-1 block">{isEn ? "Once written off, no further payments or invoice refunds are allowed, and this action cannot be undone." : "بعد الشطب لا يقبل الدين دفعات ولا تُسترد فاتورته، ولا يمكن التراجع."}</span>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={writeoffReason}
            onChange={(e) => setWriteoffReason(e.target.value)}
            placeholder={isEn ? "Write-off reason (required)" : "سبب الشطب (إلزامي)"}
            maxLength={200}
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={writeoffGuard.isRunning}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={writeoffGuard.isRunning || writeoffReason.trim().length < 3}
              className="bg-warning text-warning-foreground hover:bg-warning/90"
              onClick={() => writeoffGuard.run(async () => {
                if (!selectedDebt) return;
                const debtSnapshot = selectedDebt;
                const reason = writeoffReason.trim();
                const toastId = `writeoff-debt-${debtSnapshot.id}`;
                setShowWriteoffDialog(false);
                setSelectedDebt(null);
                toast.loading(isEn ? 'Writing off debt...' : 'جاري شطب الدين...', { id: toastId });
                try {
                  // يُنفَّذ على الخادم مباشرة ولا يوضع في طابور: الخسارة وحصص الشركاء تُحسب هناك لحظتها
                  const outcome = await writeOffDebtNowCloud(debtSnapshot.id, reason);
                  if (outcome.ok) {
                    invalidateProfitLedgerCache();
                    invalidateDebtsCache();
                    invalidatePartnersCache();
                    emitEvent(EVENTS.DEBTS_UPDATED, null);
                    emitEvent(EVENTS.CUSTOMERS_UPDATED, null);
                    emitEvent(EVENTS.PARTNERS_UPDATED, null);
                    toast.success(isEn ? 'Debt written off and recorded in the written-off debts log' : 'تم شطب الدين وتسجيله في سجل الديون المشطوبة', { id: toastId });
                    setDebts(await loadDebtsCloud());
                  } else {
                    toast.error(outcome.message, { id: toastId, duration: 9000 });
                  }
                } catch (error) {
                  console.error('Write-off debt error:', error);
                  toast.error(error instanceof Error && error.message ? error.message : (isEn ? 'Failed to write off debt' : 'تعذّر شطب الدين'), { id: toastId, duration: 8000 });
                }
              })}
            >
              {writeoffGuard.isRunning && <Loader2 className="w-4 h-4 animate-spin" />}
              {writeoffGuard.isRunning ? (isEn ? 'Writing off...' : 'جاري الشطب...') : (isEn ? 'Write Off Debt' : 'شطب الدين')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="modal-dot-expand">
          <AlertDialogHeader className="text-start">
            <AlertDialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-destructive/10 text-destructive flex items-center justify-center shrink-0">
                <Trash2 className="w-4 h-4" />
              </div>
              <span>{t('common.confirmDelete')}</span>
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground pt-2">
              {selectedDebt && (
                <>
                  {isEn ? (<>Are you sure you want to delete the debt for <strong>{selectedDebt.customerName}</strong> (<strong dir="ltr" className="inline-block tabular-nums font-mono text-destructive">{formatCurrency(selectedDebt.totalDebt)}</strong>)?</>) : (<>هل أنت متأكد من حذف دين <strong>{selectedDebt.customerName}</strong> بقيمة <strong dir="ltr" className="inline-block tabular-nums font-mono text-destructive">{formatCurrency(selectedDebt.totalDebt)}</strong>؟</>)}
                  <br />
                  <span className="text-destructive font-medium mt-1 block">{isEn ? "This action cannot be undone." : "هذا الإجراء لا يمكن التراجع عنه."}</span>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteGuard.isRunning}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteGuard.isRunning}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
              onClick={() => deleteGuard.run(async () => {
                if (!selectedDebt) return;
                const debtSnapshot = selectedDebt;
                const toastId = `delete-debt-${debtSnapshot.id}`;
                // Close dialog immediately for responsive UX
                setShowDeleteDialog(false);
                setSelectedDebt(null);
                toast.loading(isEn ? 'Deleting...' : 'جاري الحذف...', { id: toastId });
                try {
                  const success = await deleteDebtCloud(debtSnapshot.id);
                  if (success) {
                    toast.success(t('debts.deleteSuccess'), { id: toastId });
                    const debtsData = await loadDebtsCloud();
                    setDebts(debtsData);
                  } else {
                    toast.error(t('debts.deleteFailed'), { id: toastId });
                  }
                } catch (error) {
                  console.error('Delete debt error:', error);
                  toast.error(error instanceof Error && error.message ? error.message : t('common.deleteError'), { id: toastId, duration: 8000 });
                }
              })}
            >
              {deleteGuard.isRunning && <Loader2 className="w-4 h-4 animate-spin" />}
              {deleteGuard.isRunning ? (isEn ? 'Deleting...' : 'جاري الحذف...') : t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
