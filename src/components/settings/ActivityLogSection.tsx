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

type FilterCategory = 'all' | 'pricing' | 'sales' | 'debts' | 'partners' | 'expenses' | 'auth';

export function ActivityLogSection() {
  const { isRTL, language } = useLanguage();
  const isAr = language === 'ar';

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

    // 2. مزامنة السجلات السحابية بهدوء في الخلفية
    const fetchCloudLogs = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;

        const { data: cloudLogs, error } = await supabase
          .from('activity_logs')
          .select('*')
          .eq('user_id', user.id)
          .order('timestamp', { ascending: false })
          .limit(150);

        if (!error && cloudLogs && cloudLogs.length > 0) {
          setLogs(prev => {
            const existingIds = new Set(prev.map(l => l.id));
            const merged = [...prev];
            cloudLogs.forEach((item: any) => {
              if (!existingIds.has(item.id)) {
                merged.push({
                  id: item.id,
                  type: item.type as ActivityType,
                  description: item.description,
                  details: typeof item.details === 'string' ? JSON.parse(item.details) : (item.details || {}),
                  timestamp: item.timestamp,
                  userId: item.user_id,
                  userName: item.user_name || 'System'
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

  // تصفية السجلات
  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      // 1. فلتر الفئات السريعة
      if (selectedCategory === 'pricing' && !isPricingLog(log)) return false;
      if (selectedCategory === 'sales' && !isSalesLog(log)) return false;
      if (selectedCategory === 'debts' && !isDebtsLog(log)) return false;
      if (selectedCategory === 'partners' && !isPartnerLog(log)) return false;
      if (selectedCategory === 'expenses' && !isExpenseLog(log)) return false;
      if (selectedCategory === 'auth' && !isAuthLog(log)) return false;

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

    if (isAr) {
      if (minutes < 1) return 'الآن';
      if (minutes < 60) return `منذ ${minutes} دقيقة`;
      if (hours < 24) return `منذ ${hours} ساعات`;
      if (days < 7) return `منذ ${days} أيام`;
      return new Date(timestamp).toLocaleDateString('ar-SA', { month: 'short', day: 'numeric' });
    } else if (language === 'tr') {
      if (minutes < 1) return 'Az önce';
      if (minutes < 60) return `${minutes} dk önce`;
      if (hours < 24) return `${hours} sa önce`;
      if (days < 7) return `${days} gün önce`;
      return new Date(timestamp).toLocaleDateString('tr-TR', { month: 'short', day: 'numeric' });
    } else {
      if (minutes < 1) return 'Just now';
      if (minutes < 60) return `${minutes}m ago`;
      if (hours < 24) return `${hours}h ago`;
      if (days < 7) return `${days}d ago`;
      return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  };

  return (
    <div className="space-y-4 max-w-4xl mx-auto" dir={isRTL ? 'rtl' : 'ltr'}>
      {/* 1. Header & Actions Bar */}
      <header className="bg-white dark:bg-card p-4 rounded-2xl border border-zinc-200/80 dark:border-border/80 shadow-2xs space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 flex items-center justify-center shrink-0">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-bold text-zinc-900 dark:text-foreground">
                {isAr ? 'سجل العمليات والنشاطات' : language === 'tr' ? 'Etkinlik ve İşlem Günlüğü' : 'Audit Activity Log'}
              </h2>
              <p className="text-xs text-zinc-500 dark:text-muted-foreground">
                {isAr ? 'تدقيق كامل لحركات البيع وتعديل الأسعار والديون والمصاريف' : 'Live audit log of sales, pricing, debts and partner transactions'}
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
                <span>{isAr ? 'مسح السجل' : 'Clear Log'}</span>
              </Button>
            )}
          </div>
        </div>

        {/* Search Bar */}
        <div className="relative">
          <Search className={cn("w-4 h-4 text-zinc-400 absolute top-1/2 -translate-y-1/2 pointer-events-none", isRTL ? "right-3" : "left-3")} />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={isAr ? 'بحث في الفواتير، المنتجات، المبالغ، أو أسماء الكاشيرات...' : 'Search logs by invoice, product, amounts or cashier...'}
            className={cn("text-xs h-9 bg-zinc-50/70 dark:bg-muted/40 border-zinc-200 dark:border-border", isRTL ? "pr-9" : "pl-9")}
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
                ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 font-bold"
                : "bg-zinc-100 hover:bg-zinc-200 dark:bg-muted dark:hover:bg-muted/80 text-zinc-600 dark:text-muted-foreground"
            )}
          >
            <span>{isAr ? 'الكل' : 'All'}</span>
            <span className="text-[10px] opacity-70 bg-black/10 dark:bg-white/20 px-1.5 py-0.2 rounded-full">{logs.length}</span>
          </button>

          {/* Pricing Adjustments Pill */}
          <button
            onClick={() => { setSelectedCategory('pricing'); setSpecificFilter(null); }}
            className={cn(
              "px-3 py-1.5 rounded-xl shrink-0 transition flex items-center gap-1 shadow-xs text-xs font-semibold",
              selectedCategory === 'pricing'
                ? "bg-amber-100 text-amber-900 border border-amber-300 dark:bg-amber-950/60 dark:text-amber-200 font-bold"
                : "bg-zinc-100 hover:bg-zinc-200 dark:bg-muted dark:hover:bg-muted/80 text-zinc-600 dark:text-muted-foreground"
            )}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            <span>{isAr ? 'تعديل الأسعار' : language === 'tr' ? 'Fiyat Güncellemeleri' : 'Price Adjustments'}</span>
          </button>

          {/* Sales & Refunds Pill */}
          <button
            onClick={() => { setSelectedCategory('sales'); setSpecificFilter(null); }}
            className={cn(
              "px-3 py-1.5 rounded-xl shrink-0 transition flex items-center gap-1 shadow-xs text-xs font-semibold",
              selectedCategory === 'sales'
                ? "bg-emerald-100 text-emerald-900 border border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-200 font-bold"
                : "bg-zinc-100 hover:bg-zinc-200 dark:bg-muted dark:hover:bg-muted/80 text-zinc-600 dark:text-muted-foreground"
            )}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span>{isAr ? 'المبيعات والمرتجعات' : language === 'tr' ? 'Satış ve İadeler' : 'Sales & Refunds'}</span>
          </button>

          {/* Debts Pill */}
          <button
            onClick={() => { setSelectedCategory('debts'); setSpecificFilter(null); }}
            className={cn(
              "px-3 py-1.5 rounded-xl shrink-0 transition flex items-center gap-1 shadow-xs text-xs font-semibold",
              selectedCategory === 'debts'
                ? "bg-blue-100 text-blue-900 border border-blue-300 dark:bg-blue-950/60 dark:text-blue-200 font-bold"
                : "bg-zinc-100 hover:bg-zinc-200 dark:bg-muted dark:hover:bg-muted/80 text-zinc-600 dark:text-muted-foreground"
            )}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
            <span>{isAr ? 'الديون والتحصيل' : language === 'tr' ? 'Borç ve Tahsilat' : 'Debts & Collections'}</span>
          </button>

          {/* Partners Pill */}
          <button
            onClick={() => { setSelectedCategory('partners'); setSpecificFilter(null); }}
            className={cn(
              "px-3 py-1.5 rounded-xl shrink-0 transition flex items-center gap-1 shadow-xs text-xs font-semibold",
              selectedCategory === 'partners'
                ? "bg-indigo-100 text-indigo-900 border border-indigo-300 dark:bg-indigo-950/60 dark:text-indigo-200 font-bold"
                : "bg-zinc-100 hover:bg-zinc-200 dark:bg-muted dark:hover:bg-muted/80 text-zinc-600 dark:text-muted-foreground"
            )}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
            <span>{isAr ? 'الشركاء ورأس المال' : language === 'tr' ? 'Ortaklar ve Sermaye' : 'Partners & Capital'}</span>
          </button>

          {/* Expenses Pill */}
          <button
            onClick={() => { setSelectedCategory('expenses'); setSpecificFilter(null); }}
            className={cn(
              "px-3 py-1.5 rounded-xl shrink-0 transition flex items-center gap-1 shadow-xs text-xs font-semibold",
              selectedCategory === 'expenses'
                ? "bg-rose-100 text-rose-900 border border-rose-300 dark:bg-rose-950/60 dark:text-rose-200 font-bold"
                : "bg-zinc-100 hover:bg-zinc-200 dark:bg-muted dark:hover:bg-muted/80 text-zinc-600 dark:text-muted-foreground"
            )}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
            <span>{isAr ? 'المصاريف' : language === 'tr' ? 'Giderler' : 'Expenses'}</span>
          </button>

          {/* Auth */}
          <button
            onClick={() => { setSelectedCategory('auth'); setSpecificFilter(null); }}
            className={cn(
              "px-3 py-1.5 rounded-xl shrink-0 transition flex items-center gap-1 shadow-xs text-xs font-semibold",
              selectedCategory === 'auth'
                ? "bg-purple-100 text-purple-900 border border-purple-300 dark:bg-purple-950/60 dark:text-purple-200 font-bold"
                : "bg-zinc-100 hover:bg-zinc-200 dark:bg-muted dark:hover:bg-muted/80 text-zinc-600 dark:text-muted-foreground"
            )}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
            <span>{isAr ? 'الأمان والجلسات' : 'Auth & Sessions'}</span>
          </button>

          {/* Custom Filter Selector */}
          <button
            onClick={() => setCustomFilterOpen(true)}
            className={cn(
              "px-3 py-1.5 rounded-xl shrink-0 transition flex items-center gap-1.5 border text-xs font-semibold",
              specificFilter
                ? "bg-primary/10 text-primary border-primary font-bold"
                : "bg-white dark:bg-card border-zinc-200 dark:border-border text-zinc-700 dark:text-foreground"
            )}
            title={isAr ? 'تصفية مخصصة' : 'Custom Filter'}
          >
            <Filter className="w-3.5 h-3.5" />
            <span>{specificFilter ? getActivityTypeLabel(specificFilter, language) : (isAr ? 'تصفية مخصصة' : language === 'tr' ? 'Özel Filtre' : 'Custom')}</span>
          </button>
        </div>
      </header>

      {/* 3. Activity Cards Feed */}
      <div className="space-y-2.5">
        {filteredLogs.length === 0 ? (
          <div className="p-8 text-center bg-white dark:bg-card rounded-2xl border border-zinc-200/80 dark:border-border/80">
            <Activity className="w-8 h-8 text-zinc-300 dark:text-zinc-600 mx-auto mb-2 opacity-50" />
            <p className="text-xs font-bold text-zinc-600 dark:text-zinc-300">
              {isAr ? 'لا توجد عمليات تطابق هذا الفلتر' : 'No activity logs matching this filter'}
            </p>
            <p className="text-[11px] text-zinc-400 mt-0.5">
              {isAr ? 'جرّب تغيير التصنيف أو كلمات البحث' : 'Try changing category or search query'}
            </p>
          </div>
        ) : (
          filteredLogs.map(log => (
            <ActivityCard
              key={log.id}
              log={log}
              isAr={isAr}
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
            <DialogTitle className="text-base font-bold text-zinc-900 dark:text-foreground">
              {isAr ? 'تأكيد مسح سجل النشاطات' : 'Clear Activity Log?'}
            </DialogTitle>
            <DialogDescription className="text-xs text-zinc-500 dark:text-muted-foreground mt-1">
              {isAr
                ? 'هل أنت متأكد من مسح جميع السجلات المحلية والتدقيقات الحالية؟ لا يمكن التراجع عن هذا الإجراء.'
                : 'Are you sure you want to clear all local activity logs? This action cannot be undone.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="grid grid-cols-2 gap-2 mt-4 sm:space-x-0">
            <Button variant="outline" size="sm" onClick={() => setClearDialogOpen(false)} className="w-full text-xs">
              {isAr ? 'إلغاء' : 'Cancel'}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleClearLogs} className="w-full text-xs">
              {isAr ? 'نعم، مسح السجل' : 'Yes, Clear'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 5. Custom Filter Selection Modal */}
      <Dialog open={customFilterOpen} onOpenChange={setCustomFilterOpen}>
        <DialogContent className="max-w-md rounded-2xl max-h-[85vh] overflow-y-auto" dir={isRTL ? 'rtl' : 'ltr'}>
          <DialogHeader>
            <DialogTitle className="text-sm font-bold">
              {isAr ? 'اختر نوع العملية للتصفية الدقيقة' : 'Select Exact Activity Type'}
            </DialogTitle>
            <DialogDescription className="text-xs text-zinc-500">
              {isAr ? 'عرض الحركات المرتبطة بنوع محدد فقط' : 'Filter feed by a single exact operation type'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-1.5 py-2">
            <button
              onClick={() => { setSpecificFilter(null); setCustomFilterOpen(false); }}
              className={cn(
                "p-2 rounded-xl text-xs font-medium text-start border transition",
                specificFilter === null ? "border-primary bg-primary/10 text-primary font-bold" : "border-zinc-200 dark:border-border hover:bg-zinc-50 dark:hover:bg-muted/40"
              )}
            >
              {isAr ? 'عرض الكل (إلغاء الفلتر)' : 'All Types (Reset)'}
            </button>
            {Object.keys(activityTypeLabels).map((key) => {
              const type = key as ActivityType;
              const isSelected = specificFilter === type;
              return (
                <button
                  key={type}
                  onClick={() => { setSpecificFilter(type); setCustomFilterOpen(false); }}
                  className={cn(
                    "p-2 rounded-xl text-xs font-medium text-start border transition truncate",
                    isSelected ? "border-primary bg-primary/10 text-primary font-bold" : "border-zinc-200 dark:border-border hover:bg-zinc-50 dark:hover:bg-muted/40"
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
  isAr: boolean;
  isRTL: boolean;
  language?: string;
  timeText: string;
  isExpanded: boolean;
  onToggle: () => void;
}

function ActivityCard({ log, isAr, isRTL, language: propLanguage, timeText, isExpanded, onToggle }: ActivityCardProps) {
  // حماية مزدوجة: أخذ اللغة من الـ Props مع fallback من useLanguage
  const { language: hookLanguage } = useLanguage();
  const language = propLanguage || hookLanguage || (isAr ? 'ar' : 'en');

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
  let iconClass = 'bg-zinc-50 border-zinc-200 text-zinc-700 dark:bg-muted dark:border-border';
  let badgeLabel = getActivityTypeLabel(log.type, language);
  let badgeClass = 'bg-zinc-50 text-zinc-800 border-zinc-200 dark:bg-muted dark:text-foreground dark:border-border';
  
  let leftAmount: string | null = null;
  let leftStatus: string | null = null;
  let leftClass = 'text-zinc-900 dark:text-foreground';

  if (isPricing) {
    iconEmoji = '🏷️';
    iconClass = 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950/40 dark:border-amber-800/60 dark:text-amber-300';
    badgeLabel = isAr ? 'تعديل تسعيرة منتج' : 'Price Adjustment';
    badgeClass = 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-200 dark:border-amber-800/60';
  } else if (isDebt) {
    iconEmoji = '📝';
    iconClass = 'bg-purple-50 border-purple-200 text-purple-700 dark:bg-purple-950/40 dark:border-purple-800/60 dark:text-purple-300';
    badgeLabel = isAr ? 'إنشاء دين / فاتورة آجل' : 'Credit Sale';
    badgeClass = 'bg-purple-50 text-purple-800 border-purple-200 dark:bg-purple-950/50 dark:text-purple-200 dark:border-purple-800/60';
    const amountVal = Number(details.total || details.debtRemaining || details.amount || 0);
    leftAmount = formatMoney(amountVal);
    leftStatus = isAr ? 'ذمة معلقة' : 'Pending Debt';
    leftClass = 'text-rose-600 dark:text-rose-400';
  } else if (isCash) {
    iconEmoji = '🛒';
    iconClass = 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950/40 dark:border-emerald-800/60 dark:text-emerald-300';
    badgeLabel = isAr ? 'عملية بيع نقدي' : 'Cash Sale';
    badgeClass = 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-200 dark:border-emerald-800/60';
    const amountVal = Number(details.total || details.amount || 0);
    leftAmount = formatMoney(amountVal);
    leftStatus = isAr ? 'مسدد نقداً ✓' : 'Paid in Cash ✓';
    leftClass = 'text-emerald-700 dark:text-emerald-400';
  } else if (isDebtPay) {
    iconEmoji = '💳';
    iconClass = 'bg-blue-50 border-blue-200 text-blue-700 dark:bg-blue-950/40 dark:border-blue-800/60 dark:text-blue-300';
    badgeLabel = isAr ? 'تسديد دين' : 'Debt Payment';
    badgeClass = 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950/50 dark:text-blue-200 dark:border-blue-800/60';
    const amountVal = Number(details.amount || details.total || 0);
    leftAmount = formatMoney(amountVal);
    leftStatus = isAr ? 'تم القبض ✓' : 'Collected ✓';
    leftClass = 'text-blue-700 dark:text-blue-400';
  } else if (isRefund) {
    iconEmoji = '↩️';
    iconClass = 'bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-950/40 dark:border-rose-800/60 dark:text-rose-300';
    badgeLabel = isAr ? (log.type === 'partial_refund' ? 'استرداد جزئي' : 'استرداد فاتورة') : 'Refund';
    badgeClass = 'bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/50 dark:text-rose-200 dark:border-rose-800/60';
    const refundVal = Number(details.refund_amount || details.refundAmount || details.amount || details.total || 0);
    if (refundVal > 0) {
      leftAmount = formatMoney(refundVal);
      leftStatus = isAr ? 'مسترد من الصندوق' : language === 'tr' ? 'Kasadan İade' : 'Refunded';
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
        ? (isAr ? 'إيداع رصيد/رأس مال' : language === 'tr' ? 'Giriş' : 'Deposit')
        : (isAr ? 'سحب رصيد/أرباح' : language === 'tr' ? 'Çekim' : 'Withdrawal');
      leftClass = isDeposit ? 'text-indigo-600 dark:text-indigo-400' : 'text-amber-600 dark:text-amber-400';
    }
  }

  // استخراج العنوان الأنيق
  const cardTitle = useMemo(() => {
    if (details.name && typeof details.name === 'string') return details.name;
    return log.description;
  }, [details.name, log.description]);

  return (
    <div className="bg-white dark:bg-card rounded-2xl border border-zinc-200 dark:border-border/80 p-3 shadow-card space-y-2.5 transition">
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
              <span className="text-[10px] text-zinc-400 font-mono">
                {timeText}
              </span>
            </div>

            <h3 className="text-xs font-bold text-zinc-900 dark:text-foreground mt-1 leading-snug">
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
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 bg-zinc-50 dark:bg-muted px-2 py-0.5 rounded-md border border-zinc-200/70 dark:border-border/70">
              <User className="w-3 h-3 text-zinc-400" />
              <span>{isAr ? `المستخدم: ${log.userName}` : log.userName}</span>
            </span>
          )}
        </div>
      </div>

      {/* 2. Show/Hide Details Toggle Button */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between text-xs font-semibold text-blue-700 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 pt-1.5 border-t border-zinc-100 dark:border-border/50 transition cursor-pointer"
      >
        <span>{isExpanded ? (isAr ? 'إخفاء التفاصيل' : 'Hide details') : (isAr ? 'عرض التفاصيل' : 'Show details')}</span>
        <ChevronDown className={cn("w-3.5 h-3.5 transform transition-transform duration-200", isExpanded && "rotate-180")} />
      </button>

      {/* 3. Expanded Details Section */}
      {isExpanded && (
        <div className="space-y-2 text-xs overflow-hidden pt-1 animate-in fade-in-50 duration-200">
          {isPricing ? (
            <PriceComparisonTable changes={changes} isAr={isAr} />
          ) : isDebt ? (
            <DebtDetailsGrid details={details} userName={log.userName} isAr={isAr} />
          ) : isCash ? (
            <CashDetailsBox details={details} isAr={isAr} />
          ) : isDebtPay ? (
            <DebtPaymentDetailsBox details={details} isAr={isAr} />
          ) : isRefund ? (
            <RefundDetailsBox details={details} isAr={isAr} />
          ) : isPartner ? (
            <PartnerFinancialDetailsBox details={details} isAr={isAr} language={language} />
          ) : (
            <GenericDetailsBox details={details} isAr={isAr} />
          )}
        </div>
      )}
    </div>
  );
}

// ==========================================
// 📊 1. Price Comparison Table
// ==========================================
function PriceComparisonTable({ changes, isAr }: { changes: Record<string, unknown>; isAr: boolean }) {
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
      <div className="flex items-center justify-between bg-zinc-50 dark:bg-muted/40 px-2.5 py-1.5 rounded-lg border border-zinc-200/60 dark:border-border/60 text-[11px]">
        <span className="text-zinc-500 font-medium">{isAr ? 'مصدر التعديل:' : 'Source:'}</span>
        <span className="font-bold text-zinc-800 dark:text-foreground">
          {isAr ? 'تعديل يدوي مباشر من بطاقة الصنف' : 'Direct manual edit from product card'}
        </span>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-border overflow-hidden">
        <div className="bg-zinc-100 dark:bg-muted px-3 py-1.5 grid grid-cols-3 text-[11px] font-bold text-zinc-500 dark:text-muted-foreground text-center">
          <div className="text-start">{isAr ? 'نوع السعر' : 'Price Type'}</div>
          <div>{isAr ? 'السابق (القديم)' : 'Old (Previous)'}</div>
          <div>{isAr ? 'المعتمد (الجديد)' : 'New (Confirmed)'}</div>
        </div>

        <div className="px-3 py-2 grid grid-cols-3 text-xs items-center text-center border-t border-zinc-100 dark:border-border/40 bg-white dark:bg-card">
          <div className="text-start font-medium text-zinc-700 dark:text-foreground flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 shrink-0" />
            <span>{isAr ? 'رأس المال (الشراء)' : 'Cost Price'}</span>
          </div>
          <div className="font-mono text-zinc-500 line-through numeric-tabular">
            {oldCost !== null ? formatMoney(oldCost) : '—'}
          </div>
          <div className="font-mono font-bold text-zinc-900 dark:text-foreground numeric-tabular flex items-center justify-center gap-1 text-emerald-700 dark:text-emerald-400">
            <span>{formatMoney(newCost)}</span>
            {costDiff !== 0 && (
              <span className="text-[10px] text-zinc-400 font-normal">
                ({costDiff > 0 ? `+${formatMoney(costDiff)}` : `-${formatMoney(Math.abs(costDiff))}`})
              </span>
            )}
          </div>
        </div>

        <div className="px-3 py-2 grid grid-cols-3 text-xs items-center text-center border-t border-zinc-100 dark:border-border/40 bg-blue-50/30 dark:bg-blue-950/20">
          <div className="text-start font-bold text-blue-900 dark:text-blue-300 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-600 shrink-0" />
            <span>{isAr ? 'سعر البيع (المعتمد)' : 'Sale Price'}</span>
          </div>
          <div className="font-mono text-zinc-500 line-through numeric-tabular">
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

        <div className="px-3 py-2 grid grid-cols-3 text-xs items-center text-center border-t border-zinc-100 dark:border-border/40 bg-emerald-50/30 dark:bg-emerald-950/20">
          <div className="text-start font-bold text-emerald-900 dark:text-emerald-300 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 shrink-0" />
            <span>{isAr ? 'هامش الربح المتوقع' : 'Expected Margin'}</span>
          </div>
          <div className="font-mono text-zinc-500 numeric-tabular">
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
function DebtDetailsGrid({ details, userName, isAr }: { details: Record<string, unknown>; userName?: string; isAr: boolean }) {
  const total = Number(details.total || details.amount || 0);
  const itemsCount = Number(details.itemsCount || 1);
  const downPayment = Number(details.downPayment || 0);
  const debtRemaining = Number(details.debtRemaining || (total - downPayment));

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="p-2 rounded-xl bg-zinc-50 dark:bg-muted/40 border border-zinc-200/80 dark:border-border/80">
          <span className="text-[10px] text-zinc-500 block">{isAr ? 'إجمالي الفاتورة:' : 'Invoice Total:'}</span>
          <span className="font-bold text-zinc-900 dark:text-foreground font-mono numeric-tabular text-xs">${total.toFixed(2)}</span>
        </div>

        <div className="p-2 rounded-xl bg-zinc-50 dark:bg-muted/40 border border-zinc-200/80 dark:border-border/80">
          <span className="text-[10px] text-zinc-500 block">{isAr ? 'عدد المنتجات المباعة:' : 'Sold Items Count:'}</span>
          <span className="font-bold text-zinc-900 dark:text-foreground font-mono numeric-tabular text-xs">
            {isAr ? `${itemsCount} صنف (قطعة)` : `${itemsCount} item(s)`}
          </span>
        </div>

        <div className="p-2 rounded-xl bg-emerald-50/60 dark:bg-emerald-950/30 border border-emerald-200/80 dark:border-emerald-800/60">
          <span className="text-[10px] text-emerald-700 dark:text-emerald-400 block font-medium">
            {isAr ? 'الدفعة المستلمة نقداً:' : 'Cash Received:'}
          </span>
          <span className="font-bold text-emerald-800 dark:text-emerald-300 font-mono numeric-tabular text-xs">${downPayment.toFixed(2)}</span>
        </div>

        <div className="p-2 rounded-xl bg-rose-50/60 dark:bg-rose-950/30 border border-rose-200/80 dark:border-rose-800/60">
          <span className="text-[10px] text-rose-700 dark:text-rose-400 block font-medium">
            {isAr ? 'المتبقي كدين على العميل:' : 'Remaining Customer Debt:'}
          </span>
          <span className="font-bold text-rose-800 dark:text-rose-300 font-mono numeric-tabular text-xs">${debtRemaining.toFixed(2)}</span>
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px] text-zinc-500 px-1 pt-1 border-t border-zinc-100 dark:border-border/50">
        <span>{isAr ? 'طريقة السداد: ' : 'Payment Method: '}<strong className="text-zinc-800 dark:text-foreground">{isAr ? 'حساب آجل (دين)' : 'Credit (Debt)'}</strong></span>
        {userName && <span>{isAr ? 'الكاشير: ' : 'Cashier: '}<strong className="text-zinc-800 dark:text-foreground">{userName}</strong></span>}
      </div>
    </div>
  );
}

// ==========================================
// 🛒 3. Cash Sale Details Box
// ==========================================
function CashDetailsBox({ details, isAr }: { details: Record<string, unknown>; isAr: boolean }) {
  const total = Number(details.total || details.amount || 0);
  const invoiceNumber = (details.invoiceNumber || details.invoiceId || '') as string;
  const customerName = (details.customerName || (isAr ? 'عميل نقدي مباشر' : 'Direct Cash Customer')) as string;

  return (
    <div className="p-2.5 rounded-xl bg-zinc-50 dark:bg-muted/40 border border-zinc-200/80 dark:border-border/80 space-y-1.5 text-xs">
      {invoiceNumber && (
        <div className="flex justify-between">
          <span className="text-zinc-500">{isAr ? 'رقم الفاتورة:' : 'Invoice No:'}</span>
          <span className="font-mono font-bold text-zinc-800 dark:text-foreground">#{invoiceNumber}</span>
        </div>
      )}
      <div className="flex justify-between">
        <span className="text-zinc-500">{isAr ? 'العميل:' : 'Customer:'}</span>
        <span className="font-bold text-zinc-800 dark:text-foreground">{customerName}</span>
      </div>
      <div className="flex justify-between border-t border-zinc-200/60 dark:border-border/50 pt-1">
        <span className="text-zinc-500">{isAr ? 'حالة الصندوق:' : 'Drawer Status:'}</span>
        <span className="text-emerald-700 dark:text-emerald-400 font-bold">
          + ${total.toFixed(2)} {isAr ? 'تم إيداعها في الدرج' : 'deposited in drawer'}
        </span>
      </div>
    </div>
  );
}

// ==========================================
// 💳 4. Debt Payment Details Box
// ==========================================
function DebtPaymentDetailsBox({ details, isAr }: { details: Record<string, unknown>; isAr: boolean }) {
  const amount = Number(details.amount || details.total || 0);
  const customerName = (details.customerName as string) || (isAr ? 'أحمد' : 'Customer');
  const remaining = Number(details.remainingAfter || details.debtRemaining || 0);

  return (
    <div className="p-2.5 rounded-xl bg-blue-50/40 dark:bg-blue-950/30 border border-blue-200/80 dark:border-blue-800/60 space-y-1 text-xs">
      <div className="flex justify-between">
        <span className="text-zinc-600 dark:text-muted-foreground">{isAr ? 'العميل المسدد:' : 'Paying Customer:'}</span>
        <span className="font-bold text-zinc-900 dark:text-foreground">{customerName}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-zinc-600 dark:text-muted-foreground">{isAr ? 'المبلغ المسدد:' : 'Paid Amount:'}</span>
        <span className="font-mono font-bold text-blue-800 dark:text-blue-300">${amount.toFixed(2)} {isAr ? 'نقداً' : 'Cash'}</span>
      </div>
      <div className="flex justify-between border-t border-blue-200/60 dark:border-blue-800/40 pt-1">
        <span className="text-zinc-600 dark:text-muted-foreground">{isAr ? 'الرصيد المتبقي على العميل:' : 'Remaining Balance:'}</span>
        <span className={cn("font-mono font-bold", remaining <= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400")}>
          ${remaining.toFixed(2)} {remaining <= 0 ? (isAr ? '(تمت التصفية)' : '(Cleared)') : ''}
        </span>
      </div>
    </div>
  );
}

// ==========================================
// ↩️ 5. Invoice Refund Box
// ==========================================
function RefundDetailsBox({ details, isAr }: { details: Record<string, unknown>; isAr: boolean }) {
  const invoiceNumber = String(details.invoice_number || details.invoiceNumber || details.invoiceId || '');
  const refundAmount = Number(details.refund_amount || details.refundAmount || details.amount || 0);
  const invoiceTotal = Number(details.invoice_total || details.invoiceTotal || details.total || 0);
  const restoredUnits = Number(details.restored_units || details.restoredUnits || details.quantity || 0);
  const deletedDebt = Number(details.deleted_debt_amount || details.deletedDebt || details.debtReduced || 0);

  return (
    <div className="p-2.5 rounded-xl bg-rose-50/40 dark:bg-rose-950/20 border border-rose-200/80 dark:border-rose-900/60 space-y-1.5 text-xs">
      {invoiceNumber && (
        <div className="flex justify-between">
          <span className="text-zinc-500">{isAr ? 'رقم الفاتورة المستردة:' : 'Refunded Invoice:'}</span>
          <span className="font-mono font-bold text-zinc-900 dark:text-foreground">#{invoiceNumber}</span>
        </div>
      )}
      {refundAmount > 0 && (
        <div className="flex justify-between">
          <span className="text-zinc-600 dark:text-muted-foreground">{isAr ? 'المبلغ المسترد للزبون:' : 'Refunded Amount:'}</span>
          <span className="font-mono font-bold text-rose-700 dark:text-rose-400">${refundAmount.toFixed(2)}</span>
        </div>
      )}
      {invoiceTotal > 0 && (
        <div className="flex justify-between">
          <span className="text-zinc-500">{isAr ? 'إجمالي الفاتورة الأصلية:' : 'Original Total:'}</span>
          <span className="font-mono font-semibold text-zinc-800 dark:text-foreground">${invoiceTotal.toFixed(2)}</span>
        </div>
      )}
      {restoredUnits > 0 && (
        <div className="flex justify-between">
          <span className="text-zinc-500">{isAr ? 'القطع المرجعة للمخزون:' : 'Restored Stock Units:'}</span>
          <span className="font-bold text-emerald-700 dark:text-emerald-400 font-mono">
            {isAr ? `${restoredUnits} قطعة` : `${restoredUnits} unit(s)`}
          </span>
        </div>
      )}
      {deletedDebt > 0 && (
        <div className="flex justify-between">
          <span className="text-zinc-500">{isAr ? 'تخفيض الدين المسترد:' : 'Debt Deducted:'}</span>
          <span className="font-mono font-bold text-blue-700 dark:text-blue-400">${deletedDebt.toFixed(2)}</span>
        </div>
      )}
      <div className="border-t border-rose-200/60 dark:border-rose-900/40 pt-1 text-[11px] text-zinc-500 flex items-center justify-between">
        <span>{isAr ? 'حالة الحركة:' : 'Status:'}</span>
        <span className="font-semibold text-rose-700 dark:text-rose-400">
          {isAr ? 'تم استرجاع البضاعة وتعديل قيود الصندوق' : 'Goods returned and balance adjusted'}
        </span>
      </div>
    </div>
  );
}

// ==========================================
// 💼 6. Partner Financial Details Box
// ==========================================
function PartnerFinancialDetailsBox({ details, isAr, language }: { details: Record<string, unknown>; isAr: boolean; language: string }) {
  const partnerName = String(details.partnerName || (isAr ? 'شريك' : language === 'tr' ? 'Ortak' : 'Partner'));
  const amountUsd = Number(details.amount || 0);
  const origAmount = Number(details.originalAmount || amountUsd);
  const currency = String(details.currency || 'USD');
  const notes = details.notes ? String(details.notes) : null;

  return (
    <div className="p-2.5 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/30 border border-indigo-200/80 dark:border-indigo-800/60 space-y-1.5 text-xs">
      <div className="flex justify-between items-center">
        <span className="text-zinc-500">{isAr ? 'اسم الشريك المعني:' : language === 'tr' ? 'İlgili Ortak:' : 'Partner:'}</span>
        <span className="font-bold text-zinc-900 dark:text-foreground">{partnerName}</span>
      </div>

      <div className="flex justify-between items-center">
        <span className="text-zinc-500">{isAr ? 'المبلغ بالدولار (الأساس):' : language === 'tr' ? 'Dolar Tutarı (Baz):' : 'Amount (USD):'}</span>
        <span className="font-mono font-bold text-indigo-700 dark:text-indigo-300">${amountUsd.toFixed(2)}</span>
      </div>

      {currency !== 'USD' && (
        <div className="flex justify-between items-center">
          <span className="text-zinc-500">{isAr ? 'المعادل بالعملة المحصلة:' : language === 'tr' ? 'Tahsil Edilen Para Birimi:' : 'Local Currency:'}</span>
          <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
            {origAmount.toLocaleString()} {currency}
          </span>
        </div>
      )}

      {notes && (
        <div className="pt-1 border-t border-indigo-200/50 dark:border-indigo-800/40 text-[11px]">
          <span className="text-zinc-500 block mb-0.5">{isAr ? 'البيان / الملاحظة:' : language === 'tr' ? 'Açıklama / Not:' : 'Notes:'}</span>
          <p className="text-zinc-700 dark:text-zinc-300 italic bg-white/60 dark:bg-black/20 p-1.5 rounded-md">
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
function GenericDetailsBox({ details, isAr }: { details: Record<string, unknown>; isAr: boolean }) {
  const HIDDEN_KEYS = new Set([
    'id', 'userId', 'user_id', 'timestamp', 'created_at', 'updated_at', 
    'device_id', 'deviceId', 'session_id', 'token'
  ]);

  const entries = Object.entries(details).filter(
    ([key, val]) => !HIDDEN_KEYS.has(key) && val !== undefined && val !== null && val !== ''
  );

  if (entries.length === 0) return null;

  return (
    <div className="p-2.5 rounded-xl bg-zinc-50 dark:bg-muted/30 border border-zinc-200/60 dark:border-border/60 space-y-1 text-xs">
      {entries.map(([key, val]) => {
        let displayVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
        return (
          <div key={key} className="flex justify-between items-center">
            <span className="text-zinc-500 capitalize">{key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')}:</span>
            <span className="font-medium text-zinc-800 dark:text-foreground font-mono truncate max-w-[200px]">{displayVal}</span>
          </div>
        );
      })}
    </div>
  );
}

export default ActivityLogSection;
