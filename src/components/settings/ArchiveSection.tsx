import { useState, useEffect, useCallback } from 'react';
import {
  Archive, Bell, Package, CreditCard, FileX, Undo2, Trash2,
  AlertTriangle, Loader2, Clock, Receipt, ShoppingBag
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useNotifications, Notification } from '@/hooks/use-notifications';
import { loadProductsCloud } from '@/lib/cloud/products-cloud';
import { loadDebtsCloud } from '@/lib/cloud/debts-cloud';
import { loadInvoicesCloud, Invoice } from '@/lib/cloud/invoices-cloud';
import { loadExpensesCloud, Expense } from '@/lib/cloud/expenses-cloud';
import { loadPurchaseInvoicesCloud, PurchaseInvoice } from '@/lib/cloud/purchase-invoices-cloud';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/hooks/use-language';
import { formatNumber } from '@/lib/utils';

type ArchiveTab = 'general' | 'notifications';
type GeneralSubTab = 'invoices' | 'debts' | 'products' | 'expenses' | 'purchases' | 'deleted';

export function ArchiveSection() {
  const { t, isRTL } = useLanguage();
  const [activeTab, setActiveTab] = useState<ArchiveTab>('general');
  const [generalSubTab, setGeneralSubTab] = useState<GeneralSubTab>('invoices');
  
  const {
    archivedNotifications,
    restoreNotification,
    deleteArchivedNotification,
    clearAllArchived,
  } = useNotifications();

  const [paidDebts, setPaidDebts] = useState<any[]>([]);
  const [writtenOffDebts, setWrittenOffDebts] = useState<any[]>([]);
  const [outOfStockProducts, setOutOfStockProducts] = useState<any[]>([]);
  const [archivedInvoices, setArchivedInvoices] = useState<Invoice[]>([]);
  const [archivedExpenses, setArchivedExpenses] = useState<Expense[]>([]);
  const [archivedPurchases, setArchivedPurchases] = useState<PurchaseInvoice[]>([]);
  const [deletedLogs, setDeletedLogs] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const loadGeneralArchive = useCallback(async () => {
    setIsLoading(true);
    try {
      const [debts, products, invoices, expenses, purchases] = await Promise.all([
        loadDebtsCloud().catch(() => []),
        loadProductsCloud().catch(() => []),
        loadInvoicesCloud().catch(() => []),
        loadExpensesCloud().catch(() => []),
        loadPurchaseInvoicesCloud().catch(() => []),
      ]);

      // 1. الديون المسددة والديون المشطوبة
      setPaidDebts((debts || []).filter((d: any) => d.status === 'fully_paid' || Number(d.remaining_debt || d.remainingDebt || 0) <= 0));
      setWrittenOffDebts((debts || []).filter((d: any) => d.status === 'written_off' || (d as any).is_written_off));

      // 2. الأصناف نافذة الكمية
      setOutOfStockProducts((products || []).filter((p: any) => Number(p.quantity || 0) <= 0));

      // 3. فواتير المبيعات المستردة كلياً أو جزئياً والملغاة
      setArchivedInvoices(invoices.filter((i: any) => 
        i.status === 'refunded' || 
        i.status === 'cancelled' || 
        (i as any).status === 'partially_refunded' ||
        ((i as any).refundedAmount && (i as any).refundedAmount > 0)
      ));

      // 4. المصروفات المستردة والملغاة
      setArchivedExpenses((expenses || []).filter((e: any) => e.is_reversed || (e as any).status === 'reversed'));

      // 5. فواتير الشراء الملغاة أو المرتجعة أو المستبدلة
      setArchivedPurchases((purchases || []).filter((p: any) => p.status === 'cancelled' || p.status === 'superseded' || (p as any).status === 'refunded'));

      // 6. سجل الحذف السحابي الشامل (يقرأ من Supabase أولاً مع fallback للمحلي)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: cloudAuditLogs } = await (supabase as any)
          .from('activity_log')
          .select('*')
          .in('action_type', [
            'invoice_deleted', 'invoice_refunded', 'product_deleted',
            'customer_deleted', 'debt_deleted', 'debt_writeoff',
            'expense_deleted', 'expense_refund', 'partner_deleted'
          ])
          .order('created_at', { ascending: false })
          .limit(100);

        if (cloudAuditLogs && cloudAuditLogs.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setDeletedLogs(cloudAuditLogs.map((l: any) => ({
            id: l.id,
            description: l.description,
            userName: l.actor_name || 'المسؤول',
            timestamp: l.created_at,
            type: l.action_type,
          })));
        } else {
          const { loadActivityLogs } = await import('@/lib/activity-log');
          const localLogs = loadActivityLogs().filter(l => l.type.includes('delete') || l.type.includes('refund'));
          setDeletedLogs(localLogs);
        }
      } catch {
        const { loadActivityLogs } = await import('@/lib/activity-log');
        setDeletedLogs(loadActivityLogs().filter(l => l.type.includes('delete') || l.type.includes('refund')));
      }
    } catch (error) {
      console.error('Error loading comprehensive archive:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGeneralArchive();
  }, [loadGeneralArchive]);

  const formatTimeAgo = (date: Date) => {
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);
    if (diffDays === 0) return t('archive.today') || 'اليوم';
    if (diffDays === 1) return t('archive.yesterday') || 'أمس';
    return (t('archive.daysAgo') || 'منذ {days} يوم').replace('{days}', String(diffDays));
  };

  const totalGeneralCount = archivedInvoices.length + paidDebts.length + writtenOffDebts.length + outOfStockProducts.length + archivedExpenses.length + archivedPurchases.length + deletedLogs.length;

  return (
    <div className="space-y-4 max-w-full overflow-hidden">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Archive className="w-5 h-5 text-primary shrink-0" />
          <h3 className="text-base sm:text-lg font-bold text-foreground">{t('archive.title') || 'الأرشيف والسجلات'}</h3>
        </div>
        <Button variant="outline" size="sm" onClick={loadGeneralArchive} disabled={isLoading} className="h-8 px-2.5 text-xs">
          {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />}
          تحديث
        </Button>
      </div>

      {/* Main Tabs — Unified Capsule */}
      <div className="bg-muted/60 p-1 rounded-2xl flex items-center gap-1 overflow-x-auto scrollbar-none w-full sm:w-fit border border-border/40 shadow-xs select-none">
        <button
          type="button"
          onClick={() => setActiveTab('general')}
          className={cn(
            "rounded-xl px-3.5 py-1.5 text-xs sm:text-sm font-bold flex items-center gap-2 transition-all duration-200 select-none cursor-pointer shrink-0",
            activeTab === 'general'
              ? "bg-gradient-primary text-primary-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground hover:bg-card/60"
          )}
        >
          <Package className="w-4 h-4 shrink-0" />
          <span>{t('archive.general') || 'سجلات العمليات والمخزون'}</span>
          <span className="px-1.5 py-0.2 rounded-full bg-primary-foreground/20 text-[10px]">
            {totalGeneralCount}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('notifications')}
          className={cn(
            "rounded-xl px-3.5 py-1.5 text-xs sm:text-sm font-bold flex items-center gap-2 transition-all duration-200 select-none cursor-pointer shrink-0",
            activeTab === 'notifications'
              ? "bg-gradient-primary text-primary-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground hover:bg-card/60"
          )}
        >
          <Bell className="w-4 h-4 shrink-0" />
          <span>{t('archive.notifications') || 'الإشعارات'}</span>
          {archivedNotifications.length > 0 && (
            <span className="px-1.5 py-0.2 rounded-full bg-primary-foreground/20 text-[10px]">{archivedNotifications.length}</span>
          )}
        </button>
      </div>

      {/* General Archive Sub-tabs */}
      {activeTab === 'general' && (
        <div className="space-y-3">
          <div className="flex gap-1.5 overflow-x-auto pb-1 max-w-full no-scrollbar">
            {[
              { id: 'invoices' as GeneralSubTab, label: 'فواتير مستردة وملغاة', count: archivedInvoices.length, icon: FileX },
              { id: 'debts' as GeneralSubTab, label: t('archive.paidDebts') || 'ديون مسددة ومشطوبة', count: paidDebts.length + writtenOffDebts.length, icon: CreditCard },
              { id: 'products' as GeneralSubTab, label: t('archive.outOfStock') || 'أصناف نفذت', count: outOfStockProducts.length, icon: Package },
              { id: 'expenses' as GeneralSubTab, label: 'مصروفات ملغاة ومستردة', count: archivedExpenses.length, icon: Receipt },
              { id: 'purchases' as GeneralSubTab, label: 'فواتير شراء ملغاة', count: archivedPurchases.length, icon: ShoppingBag },
              { id: 'deleted' as GeneralSubTab, label: 'سجل الحذف السحابي الشامل', count: deletedLogs.length, icon: Trash2 },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setGeneralSubTab(tab.id)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-colors shrink-0",
                  generalSubTab === tab.id
                    ? "bg-primary/15 text-primary border border-primary/30"
                    : "bg-muted/50 text-muted-foreground hover:bg-muted border border-border/40"
                )}
              >
                <tab.icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
                <span className="px-1.5 py-0.5 rounded-full bg-muted text-[10px]">{tab.count}</span>
              </button>
            ))}
          </div>

          {isLoading ? (
            <div className="text-center py-10 text-muted-foreground">
              <Loader2 className="w-6 h-6 mx-auto mb-2 animate-spin text-primary" />
              <p className="text-xs">{t('archive.loading') || 'جاري تحميل الأرشيف...'}</p>
            </div>
          ) : (
            <ScrollArea className="max-h-[30rem]">
              {/* Invoices */}
              {generalSubTab === 'invoices' && (
                archivedInvoices.length === 0 ? (
                  <div className="text-center py-10 text-muted-foreground bg-muted/20 rounded-xl p-4">
                    <FileX className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p className="text-sm font-medium">لا توجد فواتير مستردة أو ملغاة حالياً</p>
                    <p className="text-xs text-muted-foreground mt-1">أي فاتورة يتم استردادها جزئياً أو كلياً تظهر هنا تلقائياً</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {archivedInvoices.map(invoice => (
                      <div key={invoice.id} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-muted/40 border border-border/50">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold text-foreground truncate">{invoice.customerName || 'عميل نقدي'}</p>
                            <span className="text-xs font-mono text-muted-foreground">#{invoice.id.slice(-6)}</span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            المبلغ: {invoice.currencySymbol || '$'}{formatNumber(invoice.totalInCurrency ?? invoice.total)} • {new Date(invoice.createdAt).toLocaleDateString('ar-SA')}
                          </p>
                        </div>
                        <span className={cn(
                          "text-[11px] font-bold px-2.5 py-1 rounded-full shrink-0",
                          invoice.status === 'refunded' ? "bg-orange-500/15 text-orange-600 border border-orange-500/30" :
                          (invoice as any).status === 'partially_refunded' ? "bg-amber-500/15 text-amber-600 border border-amber-500/30" :
                          "bg-destructive/15 text-destructive border border-destructive/30"
                        )}>
                          {invoice.status === 'refunded' ? 'مستردة بالكامل' :
                           (invoice as any).status === 'partially_refunded' ? 'مستردة جزئياً' : 'ملغاة'}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              )}

              {/* Paid & Written-off Debts */}
              {generalSubTab === 'debts' && (
                paidDebts.length === 0 && writtenOffDebts.length === 0 ? (
                  <div className="text-center py-10 text-muted-foreground bg-muted/20 rounded-xl p-4">
                    <CreditCard className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p className="text-sm font-medium">{t('archive.noPaidDebts') || 'لا توجد ديون مسددة أو مشطوبة'}</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {paidDebts.map(debt => (
                      <div key={debt.id} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-muted/40 border border-border/50">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-foreground truncate">{debt.customerName}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">${formatNumber(debt.totalDebt)} - مسدد بالكامل</p>
                        </div>
                        <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-600 border border-emerald-500/30 shrink-0">
                          {t('archive.paid') || 'مسدد'}
                        </span>
                      </div>
                    ))}
                    {writtenOffDebts.map(debt => (
                      <div key={'wo_' + debt.id} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-muted/40 border border-border/50">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-foreground truncate">{debt.customerName}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">${formatNumber(debt.totalDebt)} - دين مشطوب / معدوم</p>
                        </div>
                        <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-purple-500/15 text-purple-600 border border-purple-500/30 shrink-0">
                          مشطوب
                        </span>
                      </div>
                    ))}
                  </div>
                )
              )}

              {/* Out of Stock Products */}
              {generalSubTab === 'products' && (
                outOfStockProducts.length === 0 ? (
                  <div className="text-center py-10 text-muted-foreground bg-muted/20 rounded-xl p-4">
                    <Package className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p className="text-sm font-medium">{t('archive.noOutOfStock') || 'لا توجد أصناف نافذة الكمية'}</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {outOfStockProducts.map(product => (
                      <div key={product.id} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-muted/40 border border-border/50">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-foreground truncate">{product.name}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{product.category || t('archive.noCategory') || 'بدون تصنيف'} • الكمية: 0</p>
                        </div>
                        <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-destructive/15 text-destructive border border-destructive/30 shrink-0">
                          {t('archive.out') || 'نفذ'}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              )}

              {/* Archived Expenses */}
              {generalSubTab === 'expenses' && (
                archivedExpenses.length === 0 ? (
                  <div className="text-center py-10 text-muted-foreground bg-muted/20 rounded-xl p-4">
                    <Receipt className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p className="text-sm font-medium">لا توجد مصروفات مستردة أو ملغاة حالياً</p>
                    <p className="text-xs text-muted-foreground mt-1">المصروفات التي تم التراجع عنها أو إلغاؤها تؤرشف هنا تلقائياً</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {archivedExpenses.map(expense => (
                      <div key={expense.id} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-muted/40 border border-border/50">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-foreground truncate">
                            {expense.notes || expense.typeLabel || expense.type || 'مصروف'}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            المبلغ: ${formatNumber(expense.amount)} • {new Date(expense.date || expense.createdAt).toLocaleDateString('ar-SA')}
                          </p>
                        </div>
                        <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-rose-500/15 text-rose-600 border border-rose-500/30 shrink-0">
                          مسترد / ملغى
                        </span>
                      </div>
                    ))}
                  </div>
                )
              )}

              {/* Archived Purchases */}
              {generalSubTab === 'purchases' && (
                archivedPurchases.length === 0 ? (
                  <div className="text-center py-10 text-muted-foreground bg-muted/20 rounded-xl p-4">
                    <ShoppingBag className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p className="text-sm font-medium">لا توجد فواتير شراء ملغاة أو مرتجعة حالياً</p>
                    <p className="text-xs text-muted-foreground mt-1">فواتير الشراء التي أُلغيت أو استُبدلت تؤرشف هنا تلقائياً</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {archivedPurchases.map(purchase => (
                      <div key={purchase.id} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-muted/40 border border-border/50">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold text-foreground truncate">{purchase.supplier_name || 'مورد'}</p>
                            <span className="text-xs font-mono text-muted-foreground">#{purchase.invoice_number}</span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            الإجمالي: ${formatNumber(purchase.actual_grand_total || purchase.expected_grand_total || 0)} • {new Date(purchase.invoice_date || purchase.created_at).toLocaleDateString('ar-SA')}
                          </p>
                        </div>
                        <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-amber-500/15 text-amber-600 border border-amber-500/30 shrink-0">
                          {purchase.status === 'cancelled' ? 'ملغاة' : purchase.status === 'superseded' ? 'مستبدلة' : 'مرتجعة'}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              )}

              {/* Deleted & Refunded Cloud Audit Logs */}
              {generalSubTab === 'deleted' && (
                deletedLogs.length === 0 ? (
                  <div className="text-center py-10 text-muted-foreground bg-muted/20 rounded-xl p-4">
                    <Trash2 className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p className="text-sm font-medium">لا توجد سجلات حذف أو استرداد مسجلة</p>
                    <p className="text-xs text-muted-foreground mt-1">تسجيلات الحذف متزامنة سحابياً عبر جميع أجهزتك</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {deletedLogs.map(log => (
                      <div key={log.id} className="p-3 rounded-xl bg-muted/40 border border-border/50 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold text-foreground truncate">{log.description}</span>
                          <span className="text-[10px] text-muted-foreground shrink-0 font-mono">
                            {new Date(log.timestamp).toLocaleDateString('ar-SA')}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                          <span>بواسطة: {log.userName || 'المسؤول'}</span>
                          <span className="px-2 py-0.5 rounded-md bg-muted text-[10px]">{log.type}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}
            </ScrollArea>
          )}
        </div>
      )}

      {/* Notification Archive */}
      {activeTab === 'notifications' && (
        <div className="space-y-3">
          {archivedNotifications.length === 0 ? (
            <div className="text-center py-12 bg-muted/20 rounded-xl p-4">
              <Bell className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">{t('archive.noArchivedNotifications') || 'لا توجد إشعارات مؤرشفة'}</p>
            </div>
          ) : (
            <>
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive h-8 px-2 text-xs" onClick={clearAllArchived}>
                  <Trash2 className="w-3.5 h-3.5" />
                  {t('archive.deleteAll') || 'حذف الكل'}
                </Button>
              </div>
              <ScrollArea className="max-h-96">
                <div className="space-y-2">
                  {archivedNotifications.map(notification => (
                    <div key={notification.id} className="flex items-start justify-between gap-3 p-3 rounded-xl bg-muted/40 border border-border/50">
                      <div className="flex-1 min-w-0 space-y-1">
                        <h4 className="text-sm font-bold text-foreground break-words leading-snug">
                          {notification.title}
                        </h4>
                        <p className="text-xs text-muted-foreground break-words whitespace-pre-wrap leading-relaxed select-text">
                          {notification.message}
                        </p>
                        <div className="flex items-center gap-2 pt-1 text-[10px] text-muted-foreground/80">
                          <Clock className="w-3 h-3 shrink-0" />
                          <span>{formatTimeAgo(new Date(notification.timestamp))}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => restoreNotification(notification.id)} title={t('archive.restore') || 'استعادة'}>
                          <Undo2 className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive hover:text-destructive" onClick={() => deleteArchivedNotification(notification.id)} title={t('archive.deletePermanent') || 'حذف نهائي'}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </>
          )}
        </div>
      )}
    </div>
  );
}
