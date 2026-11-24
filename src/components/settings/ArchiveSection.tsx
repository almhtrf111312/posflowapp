import { useState, useEffect, useCallback } from 'react';
import {
  Package, CreditCard, FileX, Undo2, Trash2, Loader2, Receipt, ShoppingBag
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { getActivityTypeLabel, type ActivityLog } from '@/lib/activity-log';
import { loadProductsCloud } from '@/lib/cloud/products-cloud';
import { loadDebtsCloud } from '@/lib/cloud/debts-cloud';
import { loadInvoicesCloud, Invoice } from '@/lib/cloud/invoices-cloud';
import { loadReversedExpensesCloud, Expense } from '@/lib/cloud/expenses-cloud';
import { loadPurchaseInvoicesCloud, PurchaseInvoice } from '@/lib/cloud/purchase-invoices-cloud';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/hooks/use-language';
import { formatNumber } from '@/lib/utils';

type GeneralSubTab = 'invoices' | 'debts' | 'products' | 'expenses' | 'purchases' | 'deleted';
// Row types come from the loaders themselves, so they always match the data the screen receives.
type DebtRow = Awaited<ReturnType<typeof loadDebtsCloud>>[number];
type ProductRow = Awaited<ReturnType<typeof loadProductsCloud>>[number];
// The fields this screen reads; both the cloud audit rows and the local activity log provide them.
type AuditLogRow = Pick<ActivityLog, 'id' | 'description' | 'timestamp' | 'type'> & { userName?: string };

export function ArchiveSection() {
  const { t, isRTL, language } = useLanguage();
  const [generalSubTab, setGeneralSubTab] = useState<GeneralSubTab>('invoices');

  const [paidDebts, setPaidDebts] = useState<DebtRow[]>([]);
  const [writtenOffDebts, setWrittenOffDebts] = useState<DebtRow[]>([]);
  const [outOfStockProducts, setOutOfStockProducts] = useState<ProductRow[]>([]);
  const [archivedInvoices, setArchivedInvoices] = useState<Invoice[]>([]);
  const [archivedExpenses, setArchivedExpenses] = useState<Expense[]>([]);
  const [archivedPurchases, setArchivedPurchases] = useState<PurchaseInvoice[]>([]);
  const [deletedLogs, setDeletedLogs] = useState<AuditLogRow[]>([]);
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

      // 1. Paid and written-off debts
      setPaidDebts((debts || []).filter((d) => !(d.isWrittenOff || d.status === 'written_off') && (d.status === 'fully_paid' || Number(d.remaining_debt || d.remainingDebt || 0) <= 0)));
      setWrittenOffDebts((debts || []).filter((d) => d.isWrittenOff || d.status === 'written_off' || d.is_written_off));

      // 2. Out-of-stock products
      setOutOfStockProducts((products || []).filter((p) => Number(p.quantity || 0) <= 0));

      // 3. Refunded (full/partial) and cancelled sales invoices
      setArchivedInvoices(invoices.filter((i) =>
        i.status === 'refunded' ||
        i.status === 'cancelled' ||
        (i.status as string) === 'partially_refunded' ||
        ((i as { refundedAmount?: number }).refundedAmount && (i as { refundedAmount?: number }).refundedAmount! > 0)
      ));

      // 4. Reversed and cancelled expenses
      setArchivedExpenses(expenses || []);

      // 5. Cancelled, superseded, or refunded purchase invoices
      setArchivedPurchases((purchases || []).filter((p) => p.status === 'cancelled' || p.status === 'superseded' || (p.status as string) === 'refunded'));

      // 6. Cloud deletion audit log (reads from Supabase first with local fallback)
      try {
        const { data: cloudAuditLogs } = await supabase
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
          setDeletedLogs(cloudAuditLogs.map((l: Record<string, unknown>): AuditLogRow => ({
            id: String(l.id ?? ''),
            description: typeof l.description === 'string' ? l.description : '',
            userName: typeof l.actor_name === 'string' ? l.actor_name : '',
            timestamp: String(l.created_at ?? ''),
            type: l.action_type as ActivityLog['type'],
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
  const dateLocale = language === 'ar' ? 'ar-EG' : 'en-US';
  const fmtDate = (d?: string | Date) => { try { return d ? new Date(d).toLocaleDateString(dateLocale) : ''; } catch { return ''; } };

  const sections: { id: GeneralSubTab; label: string; icon: typeof Package; emptyTitle: string; emptyHint: string; rows: Row[] }[] = [
    {
      id: 'invoices', label: t('archive.tabInvoices' as Parameters<typeof t>[0]), icon: FileX,
      emptyTitle: t('archive.emptyInvoicesTitle' as Parameters<typeof t>[0]), emptyHint: t('archive.emptyInvoicesHint' as Parameters<typeof t>[0]),
      rows: archivedInvoices.map(inv => ({
        id: inv.id,
        title: `${inv.customerName || t('archive.cashCustomer' as Parameters<typeof t>[0])} #${inv.id.slice(-6)}`,
        sub: `${inv.currencySymbol || '$'}${formatNumber(inv.totalInCurrency ?? inv.total)} • ${fmtDate(inv.createdAt)}`,
        badge: inv.status === 'refunded'
          ? t('archive.badgeRefundedFull' as Parameters<typeof t>[0])
          : (inv.status as string) === 'partially_refunded'
            ? t('archive.badgeRefundedPartial' as Parameters<typeof t>[0])
            : t('archive.badgeCancelled' as Parameters<typeof t>[0]),
        badgeClass: inv.status === 'refunded' ? 'bg-orange-500/15 text-orange-600 border-orange-500/30' : (inv.status as string) === 'partially_refunded' ? 'bg-amber-500/15 text-amber-600 border-amber-500/30' : 'bg-destructive/15 text-destructive border-destructive/30',
      })),
    },
    {
      id: 'debts', label: t('archive.tabDebts' as Parameters<typeof t>[0]), icon: CreditCard,
      emptyTitle: t('archive.emptyDebtsTitle' as Parameters<typeof t>[0]), emptyHint: t('archive.emptyDebtsHint' as Parameters<typeof t>[0]),
      rows: [
        ...paidDebts.map(d => ({ id: d.id, title: d.customerName, sub: `$${formatNumber(d.totalDebt)} • ${t('archive.debtFullyPaid' as Parameters<typeof t>[0])}`, badge: t('archive.badgePaid' as Parameters<typeof t>[0]), badgeClass: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30' })),
        ...writtenOffDebts.map(d => ({ id: 'wo_' + d.id, title: d.customerName, sub: `$${formatNumber(d.totalDebt)} • ${t('archive.debtWrittenOff' as Parameters<typeof t>[0])}`, badge: t('archive.badgeWrittenOff' as Parameters<typeof t>[0]), badgeClass: 'bg-purple-500/15 text-purple-600 border-purple-500/30' })),
      ],
    },
    {
      id: 'products', label: t('archive.tabProducts' as Parameters<typeof t>[0]), icon: Package,
      emptyTitle: t('archive.emptyProductsTitle' as Parameters<typeof t>[0]), emptyHint: t('archive.emptyProductsHint' as Parameters<typeof t>[0]),
      rows: outOfStockProducts.map(p => ({ id: p.id, title: p.name, sub: `${p.category || t('archive.uncategorized' as Parameters<typeof t>[0])} • ${t('archive.qtyZero' as Parameters<typeof t>[0])}`, badge: t('archive.badgeOutOfStock' as Parameters<typeof t>[0]), badgeClass: 'bg-destructive/15 text-destructive border-destructive/30' })),
    },
    {
      id: 'expenses', label: t('archive.tabExpenses' as Parameters<typeof t>[0]), icon: Receipt,
      emptyTitle: t('archive.emptyExpensesTitle' as Parameters<typeof t>[0]), emptyHint: t('archive.emptyExpensesHint' as Parameters<typeof t>[0]),
      rows: archivedExpenses.map(e => ({ id: e.id, title: e.notes || e.typeLabel || e.type || t('archive.expenseFallback' as Parameters<typeof t>[0]), sub: `$${formatNumber(e.amount)} • ${fmtDate(e.date || e.createdAt)}`, badge: t('archive.badgeExpenseReversed' as Parameters<typeof t>[0]), badgeClass: 'bg-rose-500/15 text-rose-600 border-rose-500/30' })),
    },
    {
      id: 'purchases', label: t('archive.tabPurchases' as Parameters<typeof t>[0]), icon: ShoppingBag,
      emptyTitle: t('archive.emptyPurchasesTitle' as Parameters<typeof t>[0]), emptyHint: t('archive.emptyPurchasesHint' as Parameters<typeof t>[0]),
      rows: archivedPurchases.map(p => ({
        id: p.id, title: `${p.supplier_name || t('archive.supplierFallback' as Parameters<typeof t>[0])} #${p.invoice_number}`,
        sub: `$${formatNumber(p.actual_grand_total || p.expected_grand_total || 0)} • ${fmtDate(p.invoice_date || p.created_at)}`,
        badge: p.status === 'cancelled'
          ? t('archive.badgeCancelled' as Parameters<typeof t>[0])
          : p.status === 'superseded'
            ? t('archive.badgeSuperseded' as Parameters<typeof t>[0])
            : t('archive.badgeReturned' as Parameters<typeof t>[0]),
        badgeClass: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
      })),
    },
    {
      id: 'deleted', label: t('archive.tabDeleted' as Parameters<typeof t>[0]), icon: Trash2,
      emptyTitle: t('archive.emptyDeletedTitle' as Parameters<typeof t>[0]), emptyHint: t('archive.emptyDeletedHint' as Parameters<typeof t>[0]),
      rows: deletedLogs.map(l => ({ id: l.id, title: l.description || '—', sub: `${t('archive.byActor' as Parameters<typeof t>[0])} ${l.userName || t('archive.adminFallback' as Parameters<typeof t>[0])} • ${fmtDate(l.timestamp)}`, badge: getActivityTypeLabel(l.type, language) || l.type, badgeClass: 'bg-muted text-muted-foreground border-border' })),
    },
  ];
  const current = sections.find(s => s.id === generalSubTab) || sections[0];

  return (
    <div className="space-y-3 max-w-4xl mx-auto" dir={isRTL ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 bg-card p-3 rounded-2xl border border-border shadow-2xs">
        <div className="min-w-0">
          <h2 className="text-base sm:text-lg font-bold text-foreground tracking-tight">{t('archive.headerTitle' as Parameters<typeof t>[0])}</h2>
          <p className="text-xs text-muted-foreground">{t('archive.recordCount' as Parameters<typeof t>[0]).replace('{count}', String(totalGeneralCount))}</p>
        </div>
        <Button variant="outline" size="sm" onClick={loadGeneralArchive} disabled={isLoading} className="h-8 px-2.5 text-xs shrink-0">
          {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />}
          {t('archive.refresh' as Parameters<typeof t>[0])}
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
          <p className="text-xs">{t('archive.loadingArchive' as Parameters<typeof t>[0])}</p>
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
