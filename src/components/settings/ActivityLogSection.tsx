import { useState, useEffect, useMemo } from 'react';
import { 
  Activity, 
  Trash2, 
  Filter, 
  Search, 
  ChevronDown, 
  User, 
  AlertTriangle 
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { loadActivityLogs, clearActivityLogs, ActivityLog, ActivityType, activityTypeLabels, getActivityTypeLabel } from '@/lib/activity-log';
import { cn, formatMoney } from '@/lib/utils';
import { useLanguage } from '@/hooks/use-language';
import { supabase } from '@/integrations/supabase/client';

type FilterCategory = 'all' | 'sales' | 'invoices' | 'invoiceEdits' | 'debts' | 'shifts' | 'expenses' | 'partners' | 'pricing' | 'auth';

export function ActivityLogSection() {
  const { t, isRTL, language } = useLanguage();

  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<FilterCategory>('all');
  const [specificFilter, setSpecificFilter] = useState<ActivityType | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [customFilterOpen, setCustomFilterOpen] = useState(false);

  // 1. تحميل السجلات المحلية أولاً للعرض الفوري
  useEffect(() => {
    try {
      const localLogs = loadActivityLogs();
      setLogs(localLogs || []);
    } catch (e) {
      console.warn('[ActivityLogSection] Error loading local logs:', e);
      setLogs([]);
    }

    // 2. مزامنة السجلات السحابية بهدوء في الخلفية ومطابقة الحقول الحقيقية لقاعدة البيانات
    const fetchCloudLogs = async () => {
      try {
        const { getOwnerIdForInsert } = await import('@/lib/supabase-store');
        let ownerId = await getOwnerIdForInsert();
        if (!ownerId) {
          const { data: { user } } = await supabase.auth.getUser();
          ownerId = user?.id || null;
        }
        if (!ownerId) return;

        // جلب الأرشيف المحفوظ على السحابة ومطابقة الحقول الحقيقية
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: cloudLogs, error } = await (supabase as any)
          .from('activity_log')
          .select('*')
          .eq('user_id', ownerId)
          .order('created_at', { ascending: false })
          .limit(150);

        if (!error && cloudLogs && cloudLogs.length > 0) {
          setLogs(prev => {
            const existingIds = new Set(prev.map(l => l.id));
            const merged = [...prev];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            cloudLogs.forEach((item: any) => {
              if (!existingIds.has(item.id)) {
                merged.push({
                  id: item.id,
                  type: item.action_type as ActivityType,
                  description: item.description || '',
                  details: typeof item.metadata === 'string'
                    ? JSON.parse(item.metadata)
                    : (item.metadata || {}),
                  timestamp: item.created_at,
                  userId: item.actor_id || item.user_id,
                  userName: item.actor_name || 'System'
                });
              }
            });
            return merged.sort(
              (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );
          });
        }
      } catch (err) {
        console.warn('[ActivityLogSection] Failed to load cloud logs:', err);
      }
    };

    fetchCloudLogs();
  }, []);

  const handleClearLogs = () => {
    try {
      clearActivityLogs();
      setLogs([]);
      setClearDialogOpen(false);
    } catch (e) {
      console.error('[ActivityLogSection] Failed to clear logs:', e);
    }
  };

  // دوال التحقق من الفئات
  const isPricingLog = (log: ActivityLog) => {
    if (log.type === 'product_updated') {
      const details = (log.details as Record<string, unknown>) || {};
      const changes = (details.changes as Record<string, unknown>) || {};
      return !!(changes.salePrice || changes.costPrice || changes.price);
    }
    return false;
  };

  const isSalesLog = (log: ActivityLog) => {
    return ['sale', 'invoice_created', 'invoice_refunded', 'invoice_refund', 'partial_refund', 'refund'].includes(log.type);
  };

  const isDebtsLog = (log: ActivityLog) => {
    return ['debt_created', 'debt_paid', 'debt_payment', 'debt_writeoff', 'debt_deleted'].includes(log.type);
  };

  const isPartnerLog = (log: ActivityLog) => {
    return [
      'partner_investment', 'partner_withdrawal', 'capital_added',
      'capital_withdrawn', 'partner_added', 'partner_updated', 'partner_deleted'
    ].includes(log.type);
  };

  const isExpenseLog = (log: ActivityLog) => {
    return ['expense_added', 'expense_deleted', 'expense_refund', 'expense'].includes(log.type);
  };

  const isAuthLog = (log: ActivityLog) => {
    return ['login', 'logout', 'shift_opened', 'shift_closed', 'password_changed', 'user_added', 'user_deleted'].includes(log.type);
  };

  const isInvoiceLog = (log: ActivityLog) => ['invoice_created', 'invoice_deleted', 'invoice_refunded'].includes(log.type);
  const isInvoiceEditLog = (log: ActivityLog) => log.type === 'invoice_updated';
  const isShiftLog = (log: ActivityLog) => ['shift_opened', 'shift_closed'].includes(log.type);

  const CATEGORY_TESTS: Record<Exclude<FilterCategory, 'all'>, (l: ActivityLog) => boolean> = {
    sales: (l) => ['sale', 'partial_refund', 'refund'].includes(l.type),
    invoices: isInvoiceLog,
    invoiceEdits: isInvoiceEditLog,
    debts: isDebtsLog,
    shifts: isShiftLog,
    expenses: isExpenseLog,
    partners: isPartnerLog,
    pricing: isPricingLog,
    auth: (l) => ['login', 'logout', 'password_changed', 'user_added', 'user_deleted'].includes(l.type),
  };

  const CATEGORY_PILLS: { id: Exclude<FilterCategory, 'all'>; labelKey: string; dot: string; on: string }[] = [
    { id: 'sales', labelKey: 'activity.cat.sales', dot: 'bg-emerald-500', on: 'bg-emerald-100 text-emerald-900 border border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-200' },
    { id: 'invoices', labelKey: 'activity.cat.invoices', dot: 'bg-sky-500', on: 'bg-sky-100 text-sky-900 border border-sky-300 dark:bg-sky-950/60 dark:text-sky-200' },
    { id: 'invoiceEdits', labelKey: 'activity.cat.invoiceEdits', dot: 'bg-orange-500', on: 'bg-orange-100 text-orange-900 border border-orange-300 dark:bg-orange-950/60 dark:text-orange-200' },
    { id: 'debts', labelKey: 'activity.cat.debts', dot: 'bg-blue-500', on: 'bg-blue-100 text-blue-900 border border-blue-300 dark:bg-blue-950/60 dark:text-blue-200' },
    { id: 'shifts', labelKey: 'activity.cat.shifts', dot: 'bg-teal-500', on: 'bg-teal-100 text-teal-900 border border-teal-300 dark:bg-teal-950/60 dark:text-teal-200' },
    { id: 'expenses', labelKey: 'activity.cat.expenses', dot: 'bg-rose-500', on: 'bg-rose-100 text-rose-900 border border-rose-300 dark:bg-rose-950/60 dark:text-rose-200' },
    { id: 'partners', labelKey: 'activity.cat.partners', dot: 'bg-indigo-500', on: 'bg-indigo-100 text-indigo-900 border border-indigo-300 dark:bg-indigo-950/60 dark:text-indigo-200' },
    { id: 'pricing', labelKey: 'activity.cat.pricing', dot: 'bg-amber-500', on: 'bg-amber-100 text-amber-900 border border-amber-300 dark:bg-amber-950/60 dark:text-amber-200' },
    { id: 'auth', labelKey: 'activity.cat.auth', dot: 'bg-purple-500', on: 'bg-purple-100 text-purple-900 border border-purple-300 dark:bg-purple-950/60 dark:text-purple-200' },
  ];

  // تصفية السجلات
  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      // 1. فلتر الفئات السريعة
      if (selectedCategory !== 'all' && !CATEGORY_TESTS[selectedCategory](log)) return false;

      // 2. فلتر مخصص للنوع
      if (specificFilter && log.type !== specificFilter) return false;

      // 3. فلتر البحث النصي
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const descMatch = (log.description || '').toLowerCase().includes(query);
        const userMatch = (log.userName || '').toLowerCase().includes(query);
        const detailsStr = JSON.stringify(log.details || {}).toLowerCase();
        const detailsMatch = detailsStr.includes(query);
        return descMatch || userMatch || detailsMatch;
      }

      return true;
    });
  }, [logs, selectedCategory, specificFilter, searchQuery]);

  // صياغة الوقت النسبي الذكي
  const formatRelativeTime = (timestamp: string) => {
    const diff = Date.now() - new Date(timestamp).getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (minutes < 1) return t('activity.time.justNow' as any);
    if (minutes < 60) return t('activity.time.minutesAgo' as any).replace('{n}', String(minutes));
    if (hours < 24) return t('activity.time.hoursAgo' as any).replace('{n}', String(hours));
    if (days < 7) return t('activity.time.daysAgo' as any).replace('{n}', String(days));
    const locale = language === 'ar' ? 'ar-EG' : language === 'tr' ? 'tr-TR' : 'en-US';
    return new Date(timestamp).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  };

  return (
    <div className="space-y-4 max-w-4xl mx-auto" dir={isRTL ? 'rtl' : 'ltr'}>
      {/* 1. Header & Actions Bar */}
      <header className="bg-card p-4 rounded-2xl border border-border shadow-2xs space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-bold text-foreground">
                {t('activity.headerTitle' as any)}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t('activity.headerSubtitle' as any)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {logs.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setClearDialogOpen(true)}
                className="gap-1.5 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30 border-rose-200 dark:border-rose-900/50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{t('activity.clearLog' as any)}</span>
              </Button>
            )}
          </div>
        </div>

        {/* Search Bar */}
        <div className="relative">
          <Search className={cn("w-4 h-4 text-muted-foreground absolute top-1/2 -translate-y-1/2 pointer-events-none", isRTL ? "right-3" : "left-3")} />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('activity.searchPlaceholder' as any)}
            className={cn("text-xs h-9 bg-muted/40 border-border", isRTL ? "pr-9" : "pl-9")}
          />
        </div>

        {/* 2. Fast Filter Capsules (Pills) */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 pt-0.5 no-scrollbar scroll-smooth">
          {/* All */}
          <button
            onClick={() => { setSelectedCategory('all'); setSpecificFilter(null); }}
            className={cn(
              "px-3 py-1.5 rounded-xl shrink-0 transition flex items-center gap-1 shadow-xs text-xs font-semibold",
              selectedCategory === 'all' && !specificFilter
                ? "bg-primary text-primary-foreground font-bold"
                : "bg-muted hover:bg-muted/80 text-muted-foreground"
            )}
          >
            <span>{t('activity.filterAll' as any)}</span>
            <span className="text-[10px] opacity-70 bg-black/10 dark:bg-card/20 px-1.5 py-0.2 rounded-full">{logs.length}</span>
          </button>

          {CATEGORY_PILLS.map((c) => (
            <button
              key={c.id}
              onClick={() => { setSelectedCategory(c.id); setSpecificFilter(null); }}
              className={cn(
                "px-3 py-1.5 rounded-xl shrink-0 transition flex items-center gap-1 shadow-xs text-xs font-semibold",
                selectedCategory === c.id
                  ? c.on + " font-bold"
                  : "bg-muted hover:bg-muted/80 text-muted-foreground"
              )}
            >
              <span className={cn("w-1.5 h-1.5 rounded-full", c.dot)} />
              <span>{t(c.labelKey as any)}</span>
            </button>
          ))}

          {/* Custom Filter Selector */}
          <button
            onClick={() => setCustomFilterOpen(true)}
            className={cn(
              "px-3 py-1.5 rounded-xl shrink-0 transition flex items-center gap-1.5 border text-xs font-semibold",
              specificFilter
                ? "bg-primary/10 text-primary border-primary font-bold"
                : "bg-card border-border text-foreground"
            )}
            title={t('activity.customFilter' as any)}
          >
            <Filter className="w-3.5 h-3.5" />
            <span>{specificFilter ? getActivityTypeLabel(specificFilter, language) : t('activity.customFilterShort' as any)}</span>
          </button>
        </div>
      </header>

      {/* 3. Activity Cards Feed */}
      <div className="space-y-2.5">
        {filteredLogs.length === 0 ? (
          <div className="p-8 text-center bg-card rounded-2xl border border-border">
            <Activity className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-50" />
            <p className="text-xs font-bold text-muted-foreground ">
              {t('activity.emptyTitle' as any)}
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {t('activity.emptyHint' as any)}
            </p>
          </div>
        ) : (
          filteredLogs.map(log => (
            <ActivityCard
              key={log.id}
              log={log}
              isRTL={isRTL}
              language={language}
              timeText={formatRelativeTime(log.timestamp)}
              isExpanded={expandedLogId === log.id}
              onToggle={() => setExpandedLogId(expandedLogId === log.id ? null : log.id)}
            />
          ))
        )}
      </div>

      {/* 4. Clear Confirmation Modal */}
      <Dialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
        <DialogContent className="max-w-sm rounded-2xl" dir={isRTL ? 'rtl' : 'ltr'}>
          <div className="w-10 h-10 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center mx-auto text-lg mt-2">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <DialogHeader className="text-center pt-1">
            <DialogTitle className="text-base font-bold text-foreground">
              {t('activity.clearConfirmTitle' as any)}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground mt-1">
              {t('activity.clearConfirmDesc' as any)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="grid grid-cols-2 gap-2 mt-4 sm:space-x-0">
            <Button variant="outline" size="sm" onClick={() => setClearDialogOpen(false)} className="w-full text-xs">
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleClearLogs} className="w-full text-xs">
              {t('activity.clearConfirmBtn' as any)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 5. Custom Filter Selection Modal */}
      <Dialog open={customFilterOpen} onOpenChange={setCustomFilterOpen}>
        <DialogContent className="max-w-md rounded-2xl max-h-[85vh] overflow-y-auto" dir={isRTL ? 'rtl' : 'ltr'}>
          <DialogHeader>
            <DialogTitle className="text-sm font-bold">
              {t('activity.selectTypeTitle' as any)}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {t('activity.selectTypeDesc' as any)}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-1.5 py-2">
            <button
              onClick={() => { setSpecificFilter(null); setCustomFilterOpen(false); }}
              className={cn(
                "p-2 rounded-xl text-xs font-medium text-start border transition",
                specificFilter === null ? "border-primary bg-primary/10 text-primary font-bold" : "border-border hover:bg-muted/40 dark:hover:bg-muted/40"
              )}
            >
              {t('activity.allTypesReset' as any)}
            </button>
            {Object.keys(activityTypeLabels).map((key) => {
              const type = key as ActivityType;
              const isSelected = specificFilter === type;
              return (
                <button
                  key={type}
                  onClick={() => { setSpecificFilter(type); setCustomFilterOpen(false); }}
                  className={cn(
                    "p-2 rounded-xl text-xs font-medium text-start border transition break-words",
                    isSelected ? "border-primary bg-primary/10 text-primary font-bold" : "border-border hover:bg-muted/40 dark:hover:bg-muted/40"
                  )}
                >
                  {getActivityTypeLabel(type, language)}
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ==========================================
// 🎨 Activity Card Component
// ==========================================
interface ActivityCardProps {
  log: ActivityLog;
  isRTL: boolean;
  language?: string;
  timeText: string;
  isExpanded: boolean;
  onToggle: () => void;
}

function ActivityCard({ log, isRTL, language: propLanguage, timeText, isExpanded, onToggle }: ActivityCardProps) {
  const { t, language: hookLanguage } = useLanguage();
  const language = propLanguage || hookLanguage || 'ar';

  const details = (log.details as Record<string, unknown>) || {};
  const changes = (details.changes as Record<string, unknown>) || {};

  // تصنيف نوع النشاط بدقة
  const isPricing = log.type === 'product_updated' && !!(changes.salePrice || changes.costPrice || changes.price);
  const isDebt = log.type === 'debt_created' || (log.type === 'sale' && (details.paymentType === 'debt' || details.paymentType === 'split'));
  const isCash = log.type === 'sale' && details.paymentType !== 'debt' && details.paymentType !== 'split';
  const isDebtPay = log.type === 'debt_paid' || log.type === 'debt_payment';
  const isRefund = ['invoice_refunded', 'invoice_refund', 'refund', 'partial_refund'].includes(log.type) ||
                   (details.refund_amount !== undefined || details.restored_units !== undefined);
  const isPartner = [
    'partner_investment', 'partner_withdrawal', 'capital_added',
    'capital_withdrawn', 'partner_added', 'partner_updated', 'partner_deleted'
  ].includes(log.type) || !!(details.partnerId || details.partnerName);

  // إعدادات المظهر المالي والأيقونات
  let iconEmoji = '📄';
  let iconClass = 'bg-muted/40 border-border text-muted-foreground dark:bg-muted dark:border-border';
  let badgeLabel = getActivityTypeLabel(log.type, language);
  let badgeClass = 'bg-muted/40 text-foreground border-border dark:bg-muted dark:text-foreground dark:border-border';
  
  let leftAmount: string | null = null;
  let leftStatus: string | null = null;
  let leftClass = 'text-foreground';

  if (isPricing) {
    iconEmoji = '🏷️';
    iconClass = 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950/40 dark:border-amber-800/60 dark:text-amber-300';
    badgeLabel = t('activity.badge.priceAdjustment' as any);
    badgeClass = 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-200 dark:border-amber-800/60';
  } else if (isDebt) {
    iconEmoji = '📝';
    iconClass = 'bg-purple-50 border-purple-200 text-purple-700 dark:bg-purple-950/40 dark:border-purple-800/60 dark:text-purple-300';
    badgeLabel = t('activity.badge.creditSale' as any);
    badgeClass = 'bg-purple-50 text-purple-800 border-purple-200 dark:bg-purple-950/50 dark:text-purple-200 dark:border-purple-800/60';
    const amountVal = Number(details.total || details.debtRemaining || details.amount || 0);
    leftAmount = formatMoney(amountVal);
    leftStatus = t('activity.status.pendingDebt' as any);
    leftClass = 'text-rose-600 dark:text-rose-400';
  } else if (isCash) {
    iconEmoji = '🛒';
    iconClass = 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950/40 dark:border-emerald-800/60 dark:text-emerald-300';
    badgeLabel = t('activity.badge.cashSale' as any);
    badgeClass = 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-200 dark:border-emerald-800/60';
    const amountVal = Number(details.total || details.amount || 0);
    leftAmount = formatMoney(amountVal);
    leftStatus = t('activity.status.paidCash' as any);
    leftClass = 'text-emerald-700 dark:text-emerald-400';
  } else if (isDebtPay) {
    iconEmoji = '💳';
    iconClass = 'bg-blue-50 border-blue-200 text-blue-700 dark:bg-blue-950/40 dark:border-blue-800/60 dark:text-blue-300';
    badgeLabel = t('activity.badge.debtPayment' as any);
    badgeClass = 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950/50 dark:text-blue-200 dark:border-blue-800/60';
    const amountVal = Number(details.amount || details.total || 0);
    leftAmount = formatMoney(amountVal);
    leftStatus = t('activity.status.collected' as any);
    leftClass = 'text-blue-700 dark:text-blue-400';
  } else if (isRefund) {
    iconEmoji = '↩️';
    iconClass = 'bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-950/40 dark:border-rose-800/60 dark:text-rose-300';
    badgeLabel = log.type === 'partial_refund' ? t('activity.badge.partialRefund' as any) : t('activity.badge.invoiceRefund' as any);
    badgeClass = 'bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/50 dark:text-rose-200 dark:border-rose-800/60';
    const refundVal = Number(details.refund_amount || details.refundAmount || details.amount || details.total || 0);
    if (refundVal > 0) {
      leftAmount = formatMoney(refundVal);
      leftStatus = t('activity.status.refundedFromBox' as any);
      leftClass = 'text-rose-600 dark:text-rose-400';
    }
  } else if (isPartner) {
    iconEmoji = '💼';
    iconClass = 'bg-indigo-50 border-indigo-200 text-indigo-700 dark:bg-indigo-950/40 dark:border-indigo-800/60 dark:text-indigo-300';
    badgeLabel = getActivityTypeLabel(log.type, language);
    badgeClass = 'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-950/50 dark:text-indigo-200 dark:border-indigo-800/60';
    const amountVal = Number(details.amount || details.originalAmount || 0);
    if (amountVal > 0) {
      leftAmount = `${amountVal.toFixed(2)}`;
      const isDeposit = log.type === 'partner_investment' || log.type === 'capital_added';
      leftStatus = isDeposit
        ? t('activity.status.partnerDeposit' as any)
        : t('activity.status.partnerWithdrawal' as any);
      leftClass = isDeposit ? 'text-indigo-600 dark:text-indigo-400' : 'text-amber-600 dark:text-amber-400';
    }
  }

  // استخراج العنوان الأنيق
  const cardTitle = useMemo(() => {
    if (details.name && typeof details.name === 'string') return details.name;
    return log.description;
  }, [details.name, log.description]);

  return (
    <div className="bg-card rounded-2xl border border-border/80 p-3 shadow-card space-y-2.5 transition">
      {/* 1. Header of the Card */}
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-2.5">
          <div className={cn("w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 text-sm font-bold", iconClass)}>
            {iconEmoji}
          </div>

          <div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={cn("px-2 py-0.5 rounded text-[10px] font-bold border", badgeClass)}>
                {badgeLabel}
              </span>
              <span className="text-[10px] text-muted-foreground font-mono">
                {timeText}
              </span>
            </div>

            <h3 className="text-xs font-bold text-foreground mt-1 leading-snug">
              {cardTitle}
            </h3>
          </div>
        </div>

        {/* User Identity or Top Amount */}
        <div className={cn("shrink-0", isRTL ? "text-left" : "text-right")}>
          {leftAmount ? (
            <div>
              <span className={cn("text-xs font-black font-mono numeric-tabular block", leftClass)}>
                {leftAmount}
              </span>
              {leftStatus && (
                <span className={cn("text-[10px] font-semibold", leftClass)}>
                  {leftStatus}
                </span>
              )}
            </div>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground  bg-muted/40 dark:bg-muted px-2 py-0.5 rounded-md border border-border">
              <User className="w-3 h-3 text-muted-foreground" />
              <span>{t('activity.userPrefix' as any).replace('{name}', log.userName || '')}</span>
            </span>
          )}
        </div>
      </div>

      {/* 2. Show/Hide Details Toggle Button */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between text-xs font-semibold text-blue-700 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 pt-1.5 border-t border-border dark:border-border/50 transition cursor-pointer"
      >
        <span>{isExpanded ? t('activity.hideDetails' as any) : t('activity.showDetails' as any)}</span>
        <ChevronDown className={cn("w-3.5 h-3.5 transform transition-transform duration-200", isExpanded && "rotate-180")} />
      </button>

      {/* 3. Expanded Details Section */}
      {isExpanded && (
        <div className="space-y-2 text-xs overflow-hidden pt-1 animate-in fade-in-50 duration-200">
          {isPricing ? (
            <PriceComparisonTable changes={changes} />
          ) : isDebt ? (
            <DebtDetailsGrid details={details} userName={log.userName} />
          ) : isCash ? (
            <CashDetailsBox details={details} />
          ) : isDebtPay ? (
            <DebtPaymentDetailsBox details={details} />
          ) : isRefund ? (
            <RefundDetailsBox details={details} />
          ) : isPartner ? (
            <PartnerFinancialDetailsBox details={details} />
          ) : (
            <GenericDetailsBox details={details} />
          )}
        </div>
      )}
    </div>
  );
}

// ==========================================
// 📊 1. Price Comparison Table
// ==========================================
function PriceComparisonTable({ changes }: { changes: Record<string, unknown> }) {
  const { t } = useLanguage();
  const saleChange = (changes.salePrice || changes.price) as any;
  const costChange = changes.costPrice as any;

  const oldCost = costChange?.from !== undefined ? Number(costChange.from) : null;
  const newCost = costChange?.to !== undefined ? Number(costChange.to) : (oldCost ?? 0);

  const oldSale = saleChange?.from !== undefined ? Number(saleChange.from) : null;
  const newSale = saleChange?.to !== undefined ? Number(saleChange.to) : (oldSale ?? 0);

  const costDiff = oldCost !== null && newCost !== null ? newCost - oldCost : 0;
  const saleDiff = oldSale !== null && newSale !== null ? newSale - oldSale : 0;

  const oldProfit = oldSale !== null && oldCost !== null ? oldSale - oldCost : 0;
  const newProfit = newSale !== null && newCost !== null ? newSale - newCost : 0;

  const oldMargin = oldSale && oldSale > 0 ? (oldProfit / oldSale) * 100 : 0;
  const newMargin = newSale && newSale > 0 ? (newProfit / newSale) * 100 : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between bg-muted/40 dark:bg-muted/40 px-2.5 py-1.5 rounded-lg border border-border text-[11px]">
        <span className="text-muted-foreground font-medium">{t('activity.price.source' as any)}</span>
        <span className="font-bold text-foreground dark:text-foreground">
          {t('activity.price.manualEdit' as any)}
        </span>
      </div>

      <div className="rounded-xl border border-border overflow-hidden">
        <div className="bg-muted dark:bg-muted px-3 py-1.5 grid grid-cols-3 text-[11px] font-bold text-muted-foreground text-center">
          <div className="text-start">{t('activity.price.type' as any)}</div>
          <div>{t('activity.price.old' as any)}</div>
          <div>{t('activity.price.new' as any)}</div>
        </div>

        <div className="px-3 py-2 grid grid-cols-3 text-xs items-center text-center border-t border-border dark:border-border/40 bg-card">
          <div className="text-start font-medium text-foreground flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground shrink-0" />
            <span>{t('activity.price.cost' as any)}</span>
          </div>
          <div className="font-mono text-muted-foreground line-through numeric-tabular">
            {oldCost !== null ? formatMoney(oldCost) : '—'}
          </div>
          <div className="font-mono font-bold text-foreground numeric-tabular flex items-center justify-center gap-1 text-emerald-700 dark:text-emerald-400">
            <span>{formatMoney(newCost)}</span>
            {costDiff !== 0 && (
              <span className="text-[10px] text-muted-foreground font-normal">
                ({costDiff > 0 ? `+${formatMoney(costDiff)}` : `-${formatMoney(Math.abs(costDiff))}`})
              </span>
            )}
          </div>
        </div>

        <div className="px-3 py-2 grid grid-cols-3 text-xs items-center text-center border-t border-border dark:border-border/40 bg-blue-50/30 dark:bg-blue-950/20">
          <div className="text-start font-bold text-blue-900 dark:text-blue-300 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-600 shrink-0" />
            <span>{t('activity.price.sale' as any)}</span>
          </div>
          <div className="font-mono text-muted-foreground line-through numeric-tabular">
            {oldSale !== null ? formatMoney(oldSale) : '—'}
          </div>
          <div className="font-mono font-black text-blue-700 dark:text-blue-400 numeric-tabular flex items-center justify-center gap-1">
            <span>{formatMoney(newSale)}</span>
            {saleDiff !== 0 && (
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold">
                ({saleDiff > 0 ? `+${formatMoney(saleDiff)} ↗` : `-${formatMoney(Math.abs(saleDiff))} ↘`})
              </span>
            )}
          </div>
        </div>

        <div className="px-3 py-2 grid grid-cols-3 text-xs items-center text-center border-t border-border dark:border-border/40 bg-emerald-50/30 dark:bg-emerald-950/20">
          <div className="text-start font-bold text-emerald-900 dark:text-emerald-300 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 shrink-0" />
            <span>{t('activity.price.margin' as any)}</span>
          </div>
          <div className="font-mono text-muted-foreground numeric-tabular">
            {oldCost !== null && oldSale !== null ? `${formatMoney(oldProfit)} (${oldMargin.toFixed(0)}%)` : '—'}
          </div>
          <div className="font-mono font-bold text-emerald-700 dark:text-emerald-400 numeric-tabular">
            {formatMoney(newProfit)} ({newMargin.toFixed(1)}%)
          </div>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// 📝 2. Debt Sale Grid
// ==========================================
function DebtDetailsGrid({ details, userName }: { details: Record<string, unknown>; userName?: string }) {
  const { t } = useLanguage();
  const total = Number(details.total || details.amount || 0);
  const itemsCount = Number(details.itemsCount || 1);
  const downPayment = Number(details.downPayment || 0);
  const debtRemaining = Number(details.debtRemaining || (total - downPayment));

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="p-2 rounded-xl bg-muted/40 dark:bg-muted/40 border border-border">
          <span className="text-[10px] text-muted-foreground block">{t('activity.debt.invoiceTotal' as any)}</span>
          <span className="font-bold text-foreground font-mono numeric-tabular text-xs">${total.toFixed(2)}</span>
        </div>

        <div className="p-2 rounded-xl bg-muted/40 dark:bg-muted/40 border border-border">
          <span className="text-[10px] text-muted-foreground block">{t('activity.debt.soldItemsCount' as any)}</span>
          <span className="font-bold text-foreground font-mono numeric-tabular text-xs">
            {t('activity.debt.itemsCountUnit' as any).replace('{count}', String(itemsCount))}
          </span>
        </div>

        <div className="p-2 rounded-xl bg-emerald-50/60 dark:bg-emerald-950/30 border border-emerald-200/80 dark:border-emerald-800/60">
          <span className="text-[10px] text-emerald-700 dark:text-emerald-400 block font-medium">
            {t('activity.debt.cashReceived' as any)}
          </span>
          <span className="font-bold text-emerald-800 dark:text-emerald-300 font-mono numeric-tabular text-xs">${downPayment.toFixed(2)}</span>
        </div>

        <div className="p-2 rounded-xl bg-rose-50/60 dark:bg-rose-950/30 border border-rose-200/80 dark:border-rose-800/60">
          <span className="text-[10px] text-rose-700 dark:text-rose-400 block font-medium">
            {t('activity.debt.remainingDebt' as any)}
          </span>
          <span className="font-bold text-rose-800 dark:text-rose-300 font-mono numeric-tabular text-xs">${debtRemaining.toFixed(2)}</span>
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground px-1 pt-1 border-t border-border dark:border-border/50">
        <span>{t('activity.debt.paymentMethod' as any)} <strong className="text-foreground dark:text-foreground">{t('activity.debt.creditMethod' as any)}</strong></span>
        {userName && <span>{t('activity.debt.cashier' as any)} <strong className="text-foreground dark:text-foreground">{userName}</strong></span>}
      </div>
    </div>
  );
}

// ==========================================
// 🛒 3. Cash Sale Details Box
// ==========================================
function CashDetailsBox({ details }: { details: Record<string, unknown> }) {
  const { t } = useLanguage();
  const total = Number(details.total || details.amount || 0);
  const invoiceNumber = (details.invoiceNumber || details.invoiceId || '') as string;
  const customerName = (details.customerName || t('activity.cash.directCustomer' as any)) as string;

  return (
    <div className="p-2.5 rounded-xl bg-muted/40 dark:bg-muted/40 border border-border space-y-1.5 text-xs">
      {invoiceNumber && (
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t('activity.cash.invoiceNo' as any)}</span>
          <span className="font-mono font-bold text-foreground dark:text-foreground">#{invoiceNumber}</span>
        </div>
      )}
      <div className="flex justify-between">
        <span className="text-muted-foreground">{t('activity.cash.customer' as any)}</span>
        <span className="font-bold text-foreground dark:text-foreground">{customerName}</span>
      </div>
      <div className="flex justify-between border-t border-border dark:border-border/50 pt-1">
        <span className="text-muted-foreground">{t('activity.cash.drawerStatus' as any)}</span>
        <span className="text-emerald-700 dark:text-emerald-400 font-bold">
          + ${total.toFixed(2)} {t('activity.cash.depositedInDrawer' as any)}
        </span>
      </div>
    </div>
  );
}

// ==========================================
// 💳 4. Debt Payment Details Box
// ==========================================
function DebtPaymentDetailsBox({ details }: { details: Record<string, unknown> }) {
  const { t } = useLanguage();
  const amount = Number(details.amount || details.total || 0);
  const customerName = (details.customerName as string) || t('activity.debtPay.customerFallback' as any);
  const remaining = Number(details.remainingAfter || details.debtRemaining || 0);

  return (
    <div className="p-2.5 rounded-xl bg-blue-50/40 dark:bg-blue-950/30 border border-blue-200/80 dark:border-blue-800/60 space-y-1 text-xs">
      <div className="flex justify-between">
        <span className="text-muted-foreground dark:text-muted-foreground">{t('activity.debtPay.payingCustomer' as any)}</span>
        <span className="font-bold text-foreground">{customerName}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground dark:text-muted-foreground">{t('activity.debtPay.paidAmount' as any)}</span>
        <span className="font-mono font-bold text-blue-800 dark:text-blue-300">${amount.toFixed(2)} {t('activity.debtPay.cash' as any)}</span>
      </div>
      <div className="flex justify-between border-t border-blue-200/60 dark:border-blue-800/40 pt-1">
        <span className="text-muted-foreground dark:text-muted-foreground">{t('activity.debtPay.remainingBalance' as any)}</span>
        <span className={cn("font-mono font-bold", remaining <= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400")}>
          ${remaining.toFixed(2)} {remaining <= 0 ? t('activity.debtPay.cleared' as any) : ''}
        </span>
      </div>
    </div>
  );
}

// ==========================================
// ↩️ 5. Invoice Refund Box
// ==========================================
function RefundDetailsBox({ details }: { details: Record<string, unknown> }) {
  const { t } = useLanguage();
  const invoiceNumber = String(details.invoice_number || details.invoiceNumber || details.invoiceId || '');
  const refundAmount = Number(details.refund_amount || details.refundAmount || details.amount || 0);
  const invoiceTotal = Number(details.invoice_total || details.invoiceTotal || details.total || 0);
  const restoredUnits = Number(details.restored_units || details.restoredUnits || details.quantity || 0);
  const deletedDebt = Number(details.deleted_debt_amount || details.deletedDebt || details.debtReduced || 0);

  return (
    <div className="p-2.5 rounded-xl bg-rose-50/40 dark:bg-rose-950/20 border border-rose-200/80 dark:border-rose-900/60 space-y-1.5 text-xs">
      {invoiceNumber && (
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t('activity.refund.invoiceNo' as any)}</span>
          <span className="font-mono font-bold text-foreground">#{invoiceNumber}</span>
        </div>
      )}
      {refundAmount > 0 && (
        <div className="flex justify-between">
          <span className="text-muted-foreground dark:text-muted-foreground">{t('activity.refund.amount' as any)}</span>
          <span className="font-mono font-bold text-rose-700 dark:text-rose-400">${refundAmount.toFixed(2)}</span>
        </div>
      )}
      {invoiceTotal > 0 && (
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t('activity.refund.originalTotal' as any)}</span>
          <span className="font-mono font-semibold text-foreground dark:text-foreground">${invoiceTotal.toFixed(2)}</span>
        </div>
      )}
      {restoredUnits > 0 && (
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t('activity.refund.restoredUnits' as any)}</span>
          <span className="font-bold text-emerald-700 dark:text-emerald-400 font-mono">
            {t('activity.refund.unitsCount' as any).replace('{count}', String(restoredUnits))}
          </span>
        </div>
      )}
      {deletedDebt > 0 && (
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t('activity.refund.debtDeducted' as any)}</span>
          <span className="font-mono font-bold text-blue-700 dark:text-blue-400">${deletedDebt.toFixed(2)}</span>
        </div>
      )}
      <div className="border-t border-rose-200/60 dark:border-rose-900/40 pt-1 text-[11px] text-muted-foreground flex items-center justify-between">
        <span>{t('activity.refund.status' as any)}</span>
        <span className="font-semibold text-rose-700 dark:text-rose-400">
          {t('activity.refund.statusDesc' as any)}
        </span>
      </div>
    </div>
  );
}

// ==========================================
// 💼 6. Partner Financial Details Box
// ==========================================
function PartnerFinancialDetailsBox({ details }: { details: Record<string, unknown> }) {
  const { t } = useLanguage();
  const partnerName = String(details.partnerName || t('activity.partner.fallback' as any));
  const amountUsd = Number(details.amount || 0);
  const origAmount = Number(details.originalAmount || amountUsd);
  const currency = String(details.currency || 'USD');
  const notes = details.notes ? String(details.notes) : null;

  return (
    <div className="p-2.5 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/30 border border-indigo-200/80 dark:border-indigo-800/60 space-y-1.5 text-xs">
      <div className="flex justify-between items-center">
        <span className="text-muted-foreground">{t('activity.partner.name' as any)}</span>
        <span className="font-bold text-foreground">{partnerName}</span>
      </div>

      <div className="flex justify-between items-center">
        <span className="text-muted-foreground">{t('activity.partner.amountUsd' as any)}</span>
        <span className="font-mono font-bold text-indigo-700 dark:text-indigo-300">${amountUsd.toFixed(2)}</span>
      </div>

      {currency !== 'USD' && (
        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">{t('activity.partner.localCurrency' as any)}</span>
          <span className="font-mono font-semibold text-muted-foreground ">
            {origAmount.toLocaleString()} {currency}
          </span>
        </div>
      )}

      {notes && (
        <div className="pt-1 border-t border-indigo-200/50 dark:border-indigo-800/40 text-[11px]">
          <span className="text-muted-foreground block mb-0.5">{t('activity.partner.notes' as any)}</span>
          <p className="text-muted-foreground  italic bg-card/60 dark:bg-black/20 p-1.5 rounded-md">
            "{notes}"
          </p>
        </div>
      )}
    </div>
  );
}

// ==========================================
// 📦 7. Generic Details Box
// ==========================================
function GenericDetailsBox({ details }: { details: Record<string, unknown> }) {
  const HIDDEN_KEYS = new Set([
    'id', 'userId', 'user_id', 'timestamp', 'created_at', 'updated_at', 
    'device_id', 'deviceId', 'session_id', 'token'
  ]);

  const entries = Object.entries(details).filter(
    ([key, val]) => !HIDDEN_KEYS.has(key) && val !== undefined && val !== null && val !== ''
  );

  if (entries.length === 0) return null;

  return (
    <div className="p-2.5 rounded-xl bg-muted/40 dark:bg-muted/30 border border-border space-y-1 text-xs">
      {entries.map(([key, val]) => {
        let displayVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
        return (
          <div key={key} className="flex justify-between items-center">
            <span className="text-muted-foreground capitalize">{key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')}:</span>
            <span className="font-medium text-foreground dark:text-foreground font-mono truncate max-w-[200px]">{displayVal}</span>
          </div>
        );
      })}
    </div>
  );
}

export default ActivityLogSection;
