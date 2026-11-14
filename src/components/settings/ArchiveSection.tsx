import { useState, useEffect, useCallback } from 'react';
import {
  Package, CreditCard, FileX, Undo2, Trash2, Loader2, Receipt, ShoppingBag
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { getActivityTypeLabel } from '@/lib/activity-log';
import { loadProductsCloud } from '@/lib/cloud/products-cloud';
import { loadDebtsCloud } from '@/lib/cloud/debts-cloud';
import { loadInvoicesCloud, Invoice } from '@/lib/cloud/invoices-cloud';
import { loadReversedExpensesCloud, Expense } from '@/lib/cloud/expenses-cloud';
import { loadPurchaseInvoicesCloud, PurchaseInvoice } from '@/lib/cloud/purchase-invoices-cloud';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/hooks/use-language';
import { formatNumber } from '@/lib/utils';

type GeneralSubTab = 'invoices' | 'debts' | 'products' | 'expenses' | 'purchases' | 'deleted';

export function ArchiveSection() {
  const { t, isRTL } = useLanguage();
  const [generalSubTab, setGeneralSubTab] = useState<GeneralSubTab>('invoices');
  
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
        loadReversedExpensesCloud(),
        loadPurchaseInvoicesCloud().catch(() => []),
      ]);

      // 1. الديون المسددة والديون المشطوبة
      setPaidDebts((debts || []).filter((d: any) => !(d.isWrittenOff || d.status === 'written_off') && (d.status === 'fully_paid' || Number(d.remaining_debt || d.remainingDebt || 0) <= 0)));
      setWrittenOffDebts((debts || []).filter((d: any) => d.isWrittenOff || d.status === 'written_off' || d.is_written_off));

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
      setArchivedExpenses(expenses || []);

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

  const totalGeneralCount = archivedInvoices.length + paidDebts.length + writtenOffDebts.length + outOfStockProducts.length + archivedExpenses.length + archivedPurchases.length + deletedLogs.length;


  type Row = { id: string; title: string; sub: string; badge: string; badgeClass: string };
  const fmtDate = (d?: string | Date) => { try { return d ? new Date(d).toLocaleDateString('ar-SA') : ''; } catch { return ''; } };

  const sections: { id: GeneralSubTab; label: string; icon: typeof Package; emptyTitle: string; emptyHint: string; rows: Row[] }[] = [
    {
      id: 'invoices', label: 'فواتير مستردة وملغاة', icon: FileX,
      emptyTitle: 'لا توجد فواتير مستردة أو ملغاة', emptyHint: 'أي فاتورة تُسترد أو تُلغى تظهر هنا تلقائياً',
      rows: archivedInvoices.map(inv => ({
        id: inv.id,
        title: `${inv.customerName || 'عميل نقدي'} #${inv.id.slice(-6)}`,
        sub: `${inv.currencySymbol || '$'}${formatNumber(inv.totalInCurrency ?? inv.total)} • ${fmtDate(inv.createdAt)}`,
        badge: inv.status === 'refunded' ? 'مستردة بالكامل' : (inv as any).status === 'partially_refunded' ? 'مستردة جزئياً' : 'ملغاة',
        badgeClass: inv.status === 'refunded' ? 'bg-orange-500/15 text-orange-600 border-orange-500/30' : (inv as any).status === 'partially_refunded' ? 'bg-amber-500/15 text-amber-600 border-amber-500/30' : 'bg-destructive/15 text-destructive border-destructive/30',
      })),
    },
    {
      id: 'debts', label: 'ديون مسددة ومشطوبة', icon: CreditCard,
      emptyTitle: 'لا توجد ديون مسددة أو مشطوبة', emptyHint: 'الديون المسددة بالكامل أو المشطوبة تظهر هنا',
      rows: [
        ...paidDebts.map(d => ({ id: d.id, title: d.customerName, sub: `$${formatNumber(d.totalDebt)} • مسدد بالكامل`, badge: 'مسدد', badgeClass: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30' })),
        ...writtenOffDebts.map(d => ({ id: 'wo_' + d.id, title: d.customerName, sub: `$${formatNumber(d.totalDebt)} • دين مشطوب / معدوم`, badge: 'مشطوب', badgeClass: 'bg-purple-500/15 text-purple-600 border-purple-500/30' })),
      ],
    },
    {
      id: 'products', label: 'أصناف نفذت', icon: Package,
      emptyTitle: 'لا توجد أصناف نافذة الكمية', emptyHint: 'الأصناف التي وصلت كميتها إلى صفر تظهر هنا',
      rows: outOfStockProducts.map(p => ({ id: p.id, title: p.name, sub: `${p.category || 'بدون تصنيف'} • الكمية: 0`, badge: 'نفذ', badgeClass: 'bg-destructive/15 text-destructive border-destructive/30' })),
    },
    {
      id: 'expenses', label: 'مصروفات ملغاة ومستردة', icon: Receipt,
      emptyTitle: 'لا توجد مصروفات مستردة أو ملغاة', emptyHint: 'المصروفات التي تم التراجع عنها تظهر هنا',
      rows: archivedExpenses.map(e => ({ id: e.id, title: e.notes || e.typeLabel || e.type || 'مصروف', sub: `$${formatNumber(e.amount)} • ${fmtDate(e.date || e.createdAt)}`, badge: 'مسترد / ملغى', badgeClass: 'bg-rose-500/15 text-rose-600 border-rose-500/30' })),
    },
    {
      id: 'purchases', label: 'فواتير شراء ملغاة', icon: ShoppingBag,
      emptyTitle: 'لا توجد فواتير شراء ملغاة أو مستبدلة', emptyHint: 'فواتير الشراء الملغاة أو المستبدلة تظهر هنا',
      rows: archivedPurchases.map(p => ({
        id: p.id, title: `${p.supplier_name || 'مورد'} #${p.invoice_number}`,
        sub: `$${formatNumber(p.actual_grand_total || p.expected_grand_total || 0)} • ${fmtDate(p.invoice_date || p.created_at)}`,
        badge: p.status === 'cancelled' ? 'ملغاة' : p.status === 'superseded' ? 'مستبدلة' : 'مرتجعة',
        badgeClass: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
      })),
    },
    {
      id: 'deleted', label: 'سجل الحذف السحابي', icon: Trash2,
      emptyTitle: 'لا توجد سجلات حذف أو استرداد', emptyHint: 'عمليات الحذف والاسترداد متزامنة سحابياً',
      rows: deletedLogs.map(l => ({ id: l.id, title: l.description || '—', sub: `بواسطة: ${l.userName || 'المسؤول'} • ${fmtDate(l.timestamp)}`, badge: getActivityTypeLabel(l.type, 'ar') || l.type, badgeClass: 'bg-muted text-muted-foreground border-border' })),
    },
  ];
  const current = sections.find(s => s.id === generalSubTab) || sections[0];

  return (
    <div className="space-y-3 max-w-4xl mx-auto" dir={isRTL ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 bg-card p-3 rounded-2xl border border-border shadow-2xs">
        <div className="min-w-0">
          <h2 className="text-sm sm:text-base font-bold text-foreground">الأرشيف والمحذوفات</h2>
          <p className="text-xs text-muted-foreground">{totalGeneralCount} سجل</p>
        </div>
        <Button variant="outline" size="sm" onClick={loadGeneralArchive} disabled={isLoading} className="h-8 px-2.5 text-xs shrink-0">
          {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />}
          تحديث
        </Button>
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar">
        {sections.map(sec => (
          <button
            key={sec.id}
            type="button"
            onClick={() => setGeneralSubTab(sec.id)}
            className={cn(
              'px-3 py-1.5 rounded-xl shrink-0 transition flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap',
              generalSubTab === sec.id ? 'bg-primary text-primary-foreground font-bold shadow-xs' : 'bg-muted hover:bg-muted/80 text-muted-foreground'
            )}
          >
            <sec.icon className="w-3.5 h-3.5" />
            <span>{sec.label}</span>
            <span className={cn('px-1.5 rounded-full text-[10px]', generalSubTab === sec.id ? 'bg-primary-foreground/20' : 'bg-background/70')}>{sec.rows.length}</span>
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center py-10 text-muted-foreground">
          <Loader2 className="w-6 h-6 mx-auto mb-2 animate-spin text-primary" />
          <p className="text-xs">جاري تحميل الأرشيف...</p>
        </div>
      ) : current.rows.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground bg-card rounded-2xl border border-border p-4">
          <current.icon className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm font-medium text-foreground">{current.emptyTitle}</p>
          <p className="text-xs mt-1">{current.emptyHint}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {current.rows.map(row => (
            <div key={row.id} className="bg-card rounded-2xl border border-border shadow-2xs p-3 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-bold text-foreground break-words leading-snug">{row.title}</p>
                <p className="text-xs text-muted-foreground break-words leading-relaxed">{row.sub}</p>
              </div>
              <span className={cn('text-[11px] font-bold px-2.5 py-1 rounded-full border shrink-0 max-w-[45%] text-center break-words', row.badgeClass)}>
                {row.badge}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
