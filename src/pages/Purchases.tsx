import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { useState, useEffect, useCallback } from 'react';
import { FileText, Plus, Truck, Calendar, DollarSign, Loader2, ShoppingBag, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/hooks/use-language';
import { useMoney } from '@/hooks/use-money';
import { formatNumber } from '@/lib/utils';
import { loadPurchaseInvoicesCloud, PurchaseInvoice } from '@/lib/cloud/purchase-invoices-cloud';
import { PurchaseInvoiceDialog } from '@/components/products/PurchaseInvoiceDialog';
import { QuickPurchaseDialog } from '@/components/products/QuickPurchaseDialog';
import { SuppliersDialog } from '@/components/purchases/SuppliersDialog';
import { PurchaseInvoiceViewDialog } from '@/components/purchases/PurchaseInvoiceViewDialog';
import { EVENTS } from '@/lib/events';
import { format } from 'date-fns';
import { ar, enUS, tr } from 'date-fns/locale';
import { useDeferWhileHidden } from '@/contexts/PageActivityContext';

export default function Purchases() {
  const deferWhileHidden = useDeferWhileHidden();
  const { t, language } = useLanguage();
  const isEn = language === 'en';
  const m = useMoney();
  const [invoices, setInvoices] = useState<PurchaseInvoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [showQuickDialog, setShowQuickDialog] = useState(false);
  const [showSuppliers, setShowSuppliers] = useState(false);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [showViewDialog, setShowViewDialog] = useState(false);

  const dateLocale = language === 'ar' ? ar : language === 'tr' ? tr : enUS;

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await loadPurchaseInvoicesCloud();
      setInvoices(data);
    } catch (error) {
      console.error('Error loading purchases:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const handler = () => deferWhileHidden('purchases', loadData);
    window.addEventListener(EVENTS.PRODUCTS_UPDATED, handler);
    window.addEventListener(EVENTS.PURCHASES_UPDATED, handler);
    return () => {
      window.removeEventListener(EVENTS.PRODUCTS_UPDATED, handler);
      window.removeEventListener(EVENTS.PURCHASES_UPDATED, handler);
    };
  }, [loadData]);

  const totalPurchases = invoices.reduce((sum, invoice) => {
    const isPosted = ['finalized', 'completed'].includes(invoice.status);
    if (!isPosted || invoice.payment_status === 'cancelled' || invoice.replaced_by) return sum;
    return sum + (invoice.actual_grand_total ?? invoice.expected_grand_total ?? 0);
  }, 0);

  return (
    <div className="p-3 sm:p-4 md:p-6 space-y-4 md:space-y-6">
      <PageHeader
        title={isEn ? "Purchases" : "المشتريات"}
        icon={<ShoppingBag className="w-5 h-5" />}
        actions={
          <>
            <Button
              type="button"
              variant="default"
              size="default"
              data-testid="purchase-new"
              onClick={() => setShowDialog(true)}
            >
              <Plus className="w-4 h-4 shrink-0" />
              <span>{t('purchases.addNew')}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={() => setShowQuickDialog(true)}
            >
              <ShoppingBag className="w-4 h-4 shrink-0 text-primary" />
              <span>{t('purchases.quickAdd')}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={() => setShowSuppliers(true)}
            >
              <Truck className="w-4 h-4 shrink-0 text-primary" />
              <span>{isEn ? "Suppliers" : "الموردون"}</span>
            </Button>
          </>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        <div className="bg-card rounded-xl border border-border p-3 sm:p-4 flex items-center justify-between shadow-2xs">
          <div>
            <div className="flex items-center gap-1.5 mb-0.5">
              <FileText className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs text-muted-foreground font-medium">{t('purchases.totalInvoices')}</span>
            </div>
            <p className="text-base sm:text-xl font-bold text-foreground">
              <span dir="ltr" className="inline-block tabular-nums">{invoices.length}</span>
            </p>
          </div>
        </div>
        <div className="bg-card rounded-xl border border-border p-3 sm:p-4 flex items-center justify-between shadow-2xs">
          <div>
            <div className="flex items-center gap-1.5 mb-0.5">
              <DollarSign className="w-3.5 h-3.5 text-success" />
              <span className="text-xs text-muted-foreground font-medium">{t('purchases.totalAmount')}</span>
            </div>
            <p className="text-base sm:text-xl font-bold text-success font-mono">
              <span dir="ltr" className="inline-block tabular-nums">{m.fmt(totalPurchases)}</span>
            </p>
          </div>
        </div>
      </div>

      {/* Invoices List */}
      <div className="pb-10">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : invoices.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
            <Truck className="w-12 h-12 text-muted-foreground/50 mb-3" />
            <h3 className="text-sm sm:text-base font-semibold text-foreground">{t('purchases.noInvoices')}</h3>
            <p className="text-xs sm:text-sm text-muted-foreground mt-1 max-w-sm">{t('purchases.noInvoicesDesc')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {invoices.map((invoice) => (
              <div
                key={invoice.id}
                onClick={() => {
                  setSelectedInvoiceId(invoice.id);
                  setShowViewDialog(true);
                }}
                className="bg-card rounded-xl border border-border p-4 hover:border-primary/50 hover:shadow-sm transition-all cursor-pointer group"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-sm sm:text-base font-semibold text-foreground group-hover:text-primary transition-colors">
                        {invoice.supplier_name}
                      </h3>
                      <Badge variant="secondary" className="gap-1">
                        <Eye className="w-3 h-3" />
                        {isEn ? "View Details" : "عرض التفاصيل"}
                      </Badge>
                    </div>
                    {invoice.supplier_company && (
                      <p className="text-xs text-muted-foreground">{invoice.supplier_company}</p>
                    )}
                  </div>
                  <Badge variant="outline" className="font-mono">
                    <span dir="ltr" className="inline-block tabular-nums">#{invoice.invoice_number}</span>
                  </Badge>
                </div>
                <div className="flex items-center gap-4 flex-wrap text-sm text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5" />
                    <span>{format(new Date(invoice.invoice_date), 'dd MMM yyyy', { locale: dateLocale })}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <DollarSign className="w-3.5 h-3.5" />
                    <span dir="ltr" className="inline-block font-semibold text-foreground tabular-nums">
                      {m.fmtDoc(invoice.actual_grand_total || invoice.expected_grand_total, invoice as Parameters<typeof m.fmtDoc>[1])}
                    </span>
                  </div>
                  <span className="text-xs">
                    <span dir="ltr" className="inline-block tabular-nums">{invoice.actual_items_count || invoice.expected_items_count}</span> {t('purchases.items')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Dialogs */}
      <PurchaseInvoiceDialog
        open={showDialog}
        onOpenChange={setShowDialog}
        onSuccess={loadData}
      />
      <SuppliersDialog open={showSuppliers} onOpenChange={setShowSuppliers} />
      <QuickPurchaseDialog
        open={showQuickDialog}
        onOpenChange={setShowQuickDialog}
        onSuccess={loadData}
      />
      <PurchaseInvoiceViewDialog
        invoiceId={selectedInvoiceId}
        open={showViewDialog}
        onOpenChange={setShowViewDialog}
        onDeleted={loadData}
      />
    </div>
  );
}
