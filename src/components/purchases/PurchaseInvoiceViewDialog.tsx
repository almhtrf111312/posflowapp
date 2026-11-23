import { useState, useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  FileText,
  User,
  Building,
  Calendar,
  DollarSign,
  Package,
  Share2,
  Trash2,
  Loader2,
  Image as ImageIcon,
  CheckCircle2,
  Clock,
  ExternalLink,
  Edit2,
  Save,
  X,
  AlertTriangle,
} from 'lucide-react';
import {
  loadPurchaseInvoiceWithItems,
  deletePurchaseInvoiceCloud,
  editPurchaseInvoiceAtomic,
  PurchaseInvoice,
  PurchaseInvoiceItem,
  EditPurchaseInvoiceLine
} from '@/lib/cloud/purchase-invoices-cloud';
import { useUserRole } from '@/hooks/use-user-role';
import { useLanguage } from '@/hooks/use-language';
import { formatNumber, formatCurrency } from '@/lib/utils';
import { useMoney } from '@/hooks/use-money';
import { shareInvoice, InvoiceShareData } from '@/lib/native-share';
import { toast } from '@/lib/sonner-bridge';
import { PurchaseReturnDialog } from '@/components/purchases/PurchaseReturnDialog';
import { emitEvent, EVENTS } from '@/lib/events';

interface PurchaseInvoiceViewDialogProps {
  invoiceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
  onEdited?: (newInvoiceId: string) => void;
}

export function PurchaseInvoiceViewDialog({
  invoiceId,
  open,
  onOpenChange,
  onDeleted,
  onEdited,
}: PurchaseInvoiceViewDialogProps) {
  const { isOwner, isAdmin, isBoss } = useUserRole();
  const { language } = useLanguage();
  const isEn = language === 'en';
  const canEdit = isOwner || isAdmin || isBoss;

  const [invoice, setInvoice] = useState<PurchaseInvoice | null>(null);
  const [items, setItems] = useState<PurchaseInvoiceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [showReturn, setShowReturn] = useState(false);
  const [editLines, setEditLines] = useState<EditPurchaseInvoiceLine[]>([]);
  const m = useMoney();

  const invSnap = useMemo(() => {
    if (!invoice) return undefined;
    const anyInv = invoice as any;
    if (anyInv.currency_code || anyInv.currency) {
      return {
        currency_code: anyInv.currency_code || anyInv.currency || 'USD',
        currency_symbol: anyInv.currency_symbol || anyInv.currencySymbol || '$',
        exchange_rate: Number(anyInv.exchange_rate) || 1,
        decimals: anyInv.decimals ?? undefined,
      };
    }
    return undefined;
  }, [invoice]);

  const displayMoney = (val: number) => {
    if (invSnap) {
      return m.fmtDoc(val, invSnap);
    }
    return m.fmt(val);
  };
  const [editReason, setEditReason] = useState(() => (isEn ? 'Edit purchase invoice' : 'تعديل فاتورة مشتريات'));

  const fetchInvoice = (id: string) => {
    setLoading(true);
    loadPurchaseInvoiceWithItems(id)
      .then((result) => {
        setInvoice(result.invoice);
        setItems(result.items || []);
        setIsEditing(false);
      })
      .catch((err) => {
        console.error('Error loading purchase invoice details:', err);
        toast.error(isEn ? 'Failed to load purchase invoice details' : 'فشل تحميل تفاصيل فاتورة المشتريات');
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    if (open && invoiceId) {
      fetchInvoice(invoiceId);
    } else {
      setInvoice(null);
      setItems([]);
      setPreviewImage(null);
      setIsEditing(false);
    }
  }, [open, invoiceId]);

  const handleStartEdit = () => {
    if (!invoice) return;
    setEditLines(
      items.map((i) => ({
        product_id: i.product_id,
        product_name: i.product_name,
        barcode: i.barcode,
        category: i.category,
        quantity: i.quantity,
        cost_price: i.cost_price,
        sale_price: i.sale_price,
        ...(Array.isArray(i.serials) && i.serials.length > 0 ? { serials: i.serials } : {}),
      }))
    );
    setEditReason(isEn ? 'Correct purchase invoice quantities and prices' : 'تصحيح كميات وأسعار فاتورة الشراء');
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  const handleLineQtyChange = (index: number, val: number) => {
    setEditLines((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], quantity: Math.max(0, val) };
      return next;
    });
  };

  const handleLineSerialsChange = (index: number, text: string) => {
    setEditLines((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        serials: text.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean),
      };
      return next;
    });
  };

  const handleLineCostChange = (index: number, val: number) => {
    setEditLines((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], cost_price: Math.max(0, val) };
      return next;
    });
  };

  const handleSaveEdit = async () => {
    if (!invoice) return;
    if (editLines.length === 0) {
      toast.error(isEn ? 'Invoice must contain at least one item' : 'يجب أن تحتوي الفاتورة على صنف واحد على الأقل');
      return;
    }
    const hasInvalidQty = editLines.some((l) => !l.quantity || l.quantity <= 0);
    if (hasInvalidQty) {
      toast.error(isEn ? 'Quantity must be greater than zero for all items' : 'الكمية يجب أن تكون أكبر من صفر لجميع الأصناف');
      return;
    }

    setSavingEdit(true);
    const opId = `op_edit_pi_${invoice.id}_${Date.now()}`;
    const result = await editPurchaseInvoiceAtomic(invoice.id, editLines, opId, editReason);
    setSavingEdit(false);

    if (result.success && result.newInvoiceId) {
      toast.success(isEn ? 'Invoice updated and inventory/cost recalculated successfully' : 'تم تعديل الفاتورة وإعادة احتساب المخزون والتكلفة بنجاح');
      emitEvent(EVENTS.PURCHASES_UPDATED);
      emitEvent(EVENTS.PRODUCTS_UPDATED);
      setIsEditing(false);
      onEdited?.(result.newInvoiceId);
      fetchInvoice(result.newInvoiceId);
    } else {
      toast.error(result.error || (isEn ? 'Unable to update invoice. Please check stock availability' : 'تعذر تعديل الفاتورة، يرجى التحقق من توفر المخزون'));
    }
  };

  const handleDelete = async () => {
    if (!invoice) return;
    setShowDeleteConfirm(false);
    setDeleting(true);
    try {
      const success = await deletePurchaseInvoiceCloud(invoice.id);
      if (success) {
        toast.success(isEn ? `Purchase invoice #${invoice.invoice_number} cancelled and inventory impact reversed successfully` : `تم إلغاء فاتورة المشتريات #${invoice.invoice_number} وعكس أثرها المخزني بنجاح`);
        emitEvent(EVENTS.PURCHASES_UPDATED);
        emitEvent(EVENTS.PRODUCTS_UPDATED);
        onOpenChange(false);
        onDeleted?.();
      } else {
        toast.error(isEn ? 'Unable to delete purchase invoice' : 'تعذر حذف فاتورة المشتريات');
      }
    } catch (error) {
      console.error('Error deleting purchase invoice:', error);
      toast.error(isEn ? 'An error occurred while deleting' : 'حدث خطأ أثناء الحذف');
    } finally {
      setDeleting(false);
    }
  };

  const handleShareImage = async () => {
    if (!invoice) return;

    let storeName = 'PosFlow';
    let storePhone = '';
    let storeAddress = '';
    try {
      const raw = localStorage.getItem('posflow_settings_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        storeName = parsed.storeSettings?.name || storeName;
        storePhone = parsed.storeSettings?.phone || '';
        storeAddress = parsed.storeSettings?.address || '';
      }
    } catch (e) {
      /* ignore */
    }

    const grandTotal = invoice.actual_grand_total || invoice.expected_grand_total || 0;

    const shareData: InvoiceShareData = {
      id: invoice.invoice_number,
      storeName,
      storePhone,
      storeAddress,
      customerName: invoice.supplier_name,
      supplierName: invoice.supplier_name,
      supplierPhone: invoice.supplier_phone,
      date: new Date(invoice.invoice_date).toLocaleDateString('ar-SA'),
      items: items.map((item) => ({
        name: item.product_name,
        quantity: item.quantity,
        unitPrice: item.cost_price,
        total: item.total_cost || item.quantity * item.cost_price,
      })),
      subtotal: grandTotal,
      total: grandTotal,
      currencySymbol: invSnap?.currency_symbol || (invoice as any).currency_symbol || (invoice as any).currencySymbol || m.activeSymbol,
      currency: invSnap?.currency_code || (invoice as any).currency || m.activeCode,
      paymentType: (invoice.payment_type || 'cash') as InvoiceShareData['paymentType'],
      type: 'purchase',
      notes: invoice.notes,
    };

    const success = await shareInvoice(shareData);
    if (success) {
      toast.success(isEn ? 'Share dialog opened' : 'تم فتح نافذة المشاركة');
    }
  };

  if (!open) return null;

  const currentGrandTotal = isEditing
    ? editLines.reduce((s, l) => s + (l.quantity || 0) * (l.cost_price || 0), 0)
    : invoice?.actual_grand_total || invoice?.expected_grand_total || 0;

  const currentTotalQty = isEditing
    ? editLines.reduce((s, l) => s + (l.quantity || 0), 0)
    : invoice?.actual_total_quantity || items.reduce((s, i) => s + (i.quantity || 0), 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(calc(100vw-1.5rem),42rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden text-xs sm:text-sm rounded-[24px] break-words"
        onPointerDownOutside={(e) => { if (isEditing || savingEdit || deleting) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (isEditing || savingEdit || deleting) e.preventDefault(); }}
      >
        {/* Fixed Header — مع إزاحة pe-12 sm:pe-14 لمنع تراكب زر X فوق زر الحذف */}
        <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 pe-12 sm:pe-14 border-b border-border/60 text-start">
          <DialogTitle className="flex items-center justify-between gap-2 text-base sm:text-lg">
            <div className="flex items-center gap-2 min-w-0">
              <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
                <FileText className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="truncate font-bold">
                  {isEditing ? (isEn ? 'Edit Purchase Invoice' : 'تعديل فاتورة مشتريات') : (isEn ? `Purchase Invoice #${invoice?.invoice_number || ''}` : `فاتورة مشتريات #${invoice?.invoice_number || ''}`)}
                </div>
                {!isEditing && (
                  <div className="flex items-center gap-1.5 mt-1">
                    {invoice?.status === 'superseded' ? (
                      <Badge variant="secondary">
                        {isEn ? "Superseded by later edit" : "مستبدلة بتعديل لاحق"}
                      </Badge>
                    ) : invoice?.status === 'cancelled' ? (
                      <Badge variant="outline" className="bg-destructive/15 text-destructive border-destructive/30">
                        {isEn ? "Cancelled (Inventory & cost reversed)" : "ملغاة (تم عكس المخزون والتكلفة)"}
                      </Badge>
                    ) : invoice?.status === 'finalized' ? (
                      <Badge variant="outline" className="gap-1 bg-success/15 text-success border-success/30">
                        <CheckCircle2 className="w-3 h-3" />
                        {isEn ? "Confirmed in inventory" : "مؤكدة بالمخزون"}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="gap-1 bg-warning/15 text-warning border-warning/30">
                        <Clock className="w-3 h-3" />
                        {isEn ? "Draft" : "مسودة"}
                      </Badge>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Quick header actions */}
            {!isEditing && invoice && (
              <div className="flex items-center gap-1.5 shrink-0">
                {canEdit && invoice.status !== 'superseded' && invoice.status !== 'cancelled' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1 min-h-11 sm:min-h-9 px-2.5 text-xs text-primary border-primary/40 hover:bg-primary/10"
                    onClick={handleStartEdit}
                    disabled={loading}
                    aria-label={isEn ? "Edit" : "تعديل"}
                  >
                    <Edit2 className="w-4 h-4" />
                    <span className="hidden sm:inline">{isEn ? "Edit" : "تعديل"}</span>
                  </Button>
                )}
                {canEdit && invoice.status === 'finalized' && (
                  <Button variant="outline" size="sm" className="gap-1 min-h-11 sm:min-h-9 px-2.5 text-xs" onClick={() => setShowReturn(true)} disabled={loading} aria-label={isEn ? "Return" : "مرتجع"}>
                    <span>{isEn ? "Return" : "مرتجع"}</span>
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1 min-h-11 sm:min-h-9 px-2.5 text-xs border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={loading || deleting || invoice.status === 'cancelled'}
                  aria-label={invoice.status === 'cancelled' ? (isEn ? 'Cancelled' : 'ملغاة') : (isEn ? 'Cancel' : 'إلغاء')}
                >
                  {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  <span className="hidden sm:inline">{invoice.status === 'cancelled' ? (isEn ? 'Cancelled' : 'ملغاة') : (isEn ? 'Cancel' : 'إلغاء')}</span>
                </Button>
              </div>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Scrollable Content Body */}
        <DialogBody className="space-y-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="w-8 h-8 animate-spin text-primary mb-2" />
              <p className="text-sm">{isEn ? "Loading invoice details and items..." : "جاري تحميل تفاصيل الفاتورة والأصناف..."}</p>
            </div>
          ) : !invoice ? (
            <div className="py-12 text-center text-muted-foreground">
              <p>{isEn ? "Purchase invoice not found" : "لم يتم العثور على الفاتورة المطلوبة"}</p>
            </div>
          ) : (
            <>
              {/* Invoice Info Banner */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 p-3 rounded-xl bg-muted/40 border border-border/50 text-xs sm:text-sm">
                <div className="flex items-center gap-2 text-foreground font-medium">
                  <User className="w-4 h-4 text-primary shrink-0" />
                  <span>{isEn ? "Supplier:" : "المورد:"}</span>
                  <span className="text-foreground font-bold">{invoice.supplier_name}</span>
                  {invoice.supplier_company && (
                    <span className="text-xs text-muted-foreground">({invoice.supplier_company})</span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Calendar className="w-4 h-4 text-primary shrink-0" />
                  <span>{isEn ? "Purchase Date:" : "تاريخ الشراء:"}</span>
                  <span className="text-foreground font-medium">{invoice.invoice_date}</span>
                </div>
              </div>

              {/* Quick Summary Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
                <div className="p-2.5 rounded-xl bg-card border border-border text-center">
                  <div className="text-xs text-muted-foreground mb-0.5">{isEn ? "Items Count" : "عدد الأصناف"}</div>
                  <div className="text-sm sm:text-base font-bold text-foreground">
                    <span dir="ltr" className="inline-block tabular-nums">{isEditing ? editLines.length : items.length}</span> {isEn ? "items" : "صنف"}
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border text-center">
                  <div className="text-xs text-muted-foreground mb-0.5">{isEn ? "Total Quantity" : "إجمالي الكمية"}</div>
                  <div className="text-sm sm:text-base font-bold text-primary">
                    <span dir="ltr" className="inline-block tabular-nums">{formatNumber(currentTotalQty)}</span>
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border text-center">
                  <div className="text-xs text-muted-foreground mb-0.5">{isEn ? "Grand Total" : "المجموع الإجمالي"}</div>
                  <div className="text-sm sm:text-base font-bold text-success">
                    <span dir="ltr" className="inline-block tabular-nums">{displayMoney(currentGrandTotal)}</span>
                    {invSnap && invSnap.currency_code !== 'USD' && (
                      <span dir="ltr" className="text-xs text-muted-foreground block font-normal font-sans tabular-nums">
                        (≈ ${currentGrandTotal.toFixed(2)} USD)
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Edit Mode Notice & Reason Input */}
              {isEditing && (
                <div className="p-3 bg-warning/10 border border-warning/30 rounded-xl space-y-2 text-xs">
                  <div className="flex items-center gap-1.5 font-bold text-warning">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>{isEn ? "Protected Atomic Accounting Edit" : "تعديل محاسبي ذري محمي"}</span>
                  </div>
                  <p className="text-muted-foreground leading-relaxed">
                    {isEn ? "Saving this edit atomically reverses original stock and balance entries, records the updated lines, recalculates weighted-average cost, and marks the previous invoice as superseded." : "سيتم عكس حركة المخزون والذمة للأسطر القديمة وتسجيل الأسطر المعدلة كحركات جديدة وإعادة احتساب متوسط التكلفة آلياً، وتعليم الفاتورة القديمة كمستبدلة."}
                  </p>
                  <div>
                    <label className="block text-[11px] font-medium text-foreground mb-1">{isEn ? "Edit Reason:" : "سبب التعديل:"}</label>
                    <Input
                      value={editReason}
                      onChange={(e) => setEditReason(e.target.value)}
                      placeholder={isEn ? "Enter the reason for editing this invoice for audit..." : "اكتب سبب تعديل الفاتورة للتدقيق..."}
                      className="h-8 text-xs bg-background"
                    />
                  </div>
                </div>
              )}

              {/* Items Section */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Package className="w-4 h-4 text-primary" />
                  <h4 className="text-xs sm:text-sm font-semibold text-foreground">
                    {isEditing ? (isEn ? 'Edit Invoice Items' : 'تعديل بنود الفاتورة') : (isEn ? `Purchased Products in This Invoice (${items.length})` : `المنتجات المشتراة في هذه الفاتورة (${items.length})`)}
                  </h4>
                </div>

                {/* Mobile Cards View (<sm) */}
                <div className="sm:hidden space-y-2">
                  {(isEditing ? editLines : items).map((item, idx) => (
                    <div
                      key={(item as any).id || idx}
                      className="p-3 rounded-xl border border-border bg-card/60 space-y-2 break-words"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-foreground text-xs">{item.product_name}</span>
                        {item.barcode && (
                          <span className="font-mono text-[10px] text-muted-foreground">{item.barcode}</span>
                        )}
                      </div>

                      {isEditing ? (
                        <div className="grid grid-cols-2 gap-2 pt-1 border-t border-border/40">
                          <div>
                            <label className="text-[10px] text-muted-foreground block mb-0.5">{isEn ? "Qty:" : "الكمية:"}</label>
                            <Input
                              type="number"
                              min="1"
                              step="any"
                              value={item.quantity}
                              onChange={(e) => handleLineQtyChange(idx, parseFloat(e.target.value) || 0)}
                              className="h-8 text-xs font-bold text-primary"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-muted-foreground block mb-0.5">{isEn ? "Cost:" : "التكلفة:"}</label>
                            <Input
                              type="number"
                              min="0"
                              step="any"
                              value={item.cost_price}
                              onChange={(e) => handleLineCostChange(idx, parseFloat(e.target.value) || 0)}
                              className="h-8 text-xs font-bold"
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-3 gap-1 text-[11px] pt-1 border-t border-border/40">
                          <div>
                            <span className="text-muted-foreground block text-[10px]">{isEn ? "Qty:" : "الكمية:"}</span>
                            <span className="font-bold text-primary">{formatNumber(item.quantity)}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground block text-[10px]">{isEn ? "Cost:" : "التكلفة:"}</span>
                            <span>{displayMoney(item.cost_price)}</span>
                          </div>
                          <div className="text-end">
                            <span className="text-muted-foreground block text-[10px]">{isEn ? "Total:" : "الإجمالي:"}</span>
                            <span className="font-bold text-foreground">
                              {displayMoney((item as any).total_cost || item.quantity * item.cost_price)}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Desktop / Tablet Table View (>=sm) */}
                <div className="hidden sm:block border border-border rounded-xl overflow-hidden">
                  <div className="overflow-x-auto max-h-80">
                    <Table className="text-xs sm:text-sm">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-center w-10">#</TableHead>
                          <TableHead className="text-start">{isEn ? "Product Name" : "اسم المنتج"}</TableHead>
                          <TableHead className="text-end w-28">{isEn ? "Qty" : "الكمية"}</TableHead>
                          <TableHead className="text-end w-28">{isEn ? "Unit Cost" : "سعر التكلفة"}</TableHead>
                          <TableHead className="text-end">{isEn ? "Total" : "الإجمالي"}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(isEditing ? editLines : items).map((item, idx) => (
                          <TableRow key={(item as any).id || idx}>
                            <TableCell className="text-center text-muted-foreground"><span dir="ltr" className="inline-block tabular-nums">{idx + 1}</span></TableCell>
                            <TableCell className="font-medium text-start">
                              <div className="text-foreground">{item.product_name}</div>
                              {item.barcode && (
                                <div className="text-xs text-muted-foreground font-mono"><span dir="ltr" className="inline-block tabular-nums">{item.barcode}</span></div>
                              )}
                            </TableCell>
                            <TableCell className="text-end">
                              {isEditing ? (
                                <Input
                                  dir="ltr"
                                  type="number"
                                  min="1"
                                  step="any"
                                  value={item.quantity}
                                  onChange={(e) => handleLineQtyChange(idx, parseFloat(e.target.value) || 0)}
                                  className="h-9 text-xs font-bold text-center text-primary tabular-nums"
                                />
                              ) : (
                                <span dir="ltr" className="inline-block font-bold text-primary tabular-nums">{formatNumber(item.quantity)}</span>
                              )}
                            </TableCell>
                            <TableCell className="text-end">
                              {isEditing ? (
                                <Input
                                  dir="ltr"
                                  type="number"
                                  min="0"
                                  step="any"
                                  value={item.cost_price}
                                  onChange={(e) => handleLineCostChange(idx, parseFloat(e.target.value) || 0)}
                                  className="h-9 text-xs font-bold text-center tabular-nums"
                                />
                              ) : (
                                <span dir="ltr" className="inline-block text-muted-foreground tabular-nums">{displayMoney(item.cost_price)}</span>
                              )}
                            </TableCell>
                            <TableCell className="text-end font-bold text-foreground">
                              <span dir="ltr" className="inline-block tabular-nums">{displayMoney((item as any).total_cost || item.quantity * item.cost_price)}</span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>

              {/* Serial numbers editing (only lines that track serials) */}
              {isEditing && editLines.some((l) => Array.isArray(l.serials)) && (
                <div className="p-3 bg-muted/30 border border-border rounded-xl space-y-3">
                  <div className="text-xs font-bold">{isEn ? "Serial Numbers (one per line)" : "الأرقام التسلسلية (رقم في كل سطر)"}</div>
                  {editLines.map((l, idx) =>
                    Array.isArray(l.serials) ? (
                      <div key={idx}>
                        <label className="text-[11px] text-muted-foreground block mb-1">
                          {l.product_name} — {l.serials.length} / {l.quantity}
                        </label>
                        <Textarea
                          dir="ltr"
                          rows={Math.min(6, Math.max(2, l.serials.length))}
                          defaultValue={l.serials.join('\n')}
                          onChange={(e) => handleLineSerialsChange(idx, e.target.value)}
                          className="text-xs font-mono"
                        />
                      </div>
                    ) : null
                  )}
                </div>
              )}

              {/* Invoice Image Thumbnail if present */}
              {invoice.image_url && !isEditing && (
                <div className="p-3 bg-muted/30 border border-border rounded-xl flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ImageIcon className="w-4 h-4 text-primary" />
                    <span className="text-xs font-medium">{isEn ? "Attached Invoice Image" : "صورة الفاتورة المرفقة"}</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={() => setPreviewImage(invoice.image_url || null)}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    {isEn ? "View Image" : "عرض الصورة"}
                  </Button>
                </div>
              )}

              {/* Notes if present */}
              {invoice.notes && (
                <div className="p-3 bg-warning/10 border border-warning/30 rounded-xl text-xs text-foreground">
                  <span className="font-semibold text-warning me-1">{isEn ? "Notes:" : "ملاحظات:"}</span>
                  <span>{invoice.notes}</span>
                </div>
              )}
            </>
          )}
        </DialogBody>

        {/* Fixed Footer */}
        <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60 bg-muted/20">
          {isEditing ? (
            <>
              <Button
                variant="outline"
                size="default"
                onClick={handleCancelEdit}
                disabled={savingEdit}
              >
                <X className="w-4 h-4" />
                {isEn ? "Cancel Edit" : "إلغاء التعديل"}
              </Button>
              <Button
                variant="default"
                size="default"
                onClick={handleSaveEdit}
                disabled={savingEdit}
              >
                {savingEdit ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {isEn ? "Saving & recalculating..." : "جارٍ الحفظ والاحتساب..."}
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    {isEn ? "Save Accounting Edit" : "حفظ التعديل المحاسبي"}
                  </>
                )}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="default"
                onClick={() => onOpenChange(false)}
              >
                {isEn ? "Close" : "إغلاق"}
              </Button>
              <Button
                variant="default"
                size="default"
                onClick={handleShareImage}
                disabled={loading || !invoice}
              >
                <Share2 className="w-4 h-4" />
                {isEn ? "Share Invoice as Image" : "مشاركة الفاتورة كصورة"}
              </Button>
            </>
          )}
        </DialogFooter>

        {/* Image Preview Modal */}
        {previewImage && (
          <Dialog open={!!previewImage} onOpenChange={() => setPreviewImage(null)}>
            <DialogContent className="max-w-3xl p-2">
              <img
                src={previewImage}
                alt={isEn ? "Purchase invoice preview" : "معاينة فاتورة المشتريات"}
                loading="lazy"
                decoding="async"
                className="w-full max-h-[80vh] object-contain rounded-lg"
              />
            </DialogContent>
          </Dialog>
        )}
      </DialogContent>
      {invoice && (
        <PurchaseReturnDialog
          open={showReturn}
          onOpenChange={setShowReturn}
          invoiceId={invoice.id}
          items={items}
          onDone={() => fetchInvoice(invoice.id)}
        />
      )}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isEn ? 'Cancel Purchase Invoice' : 'إلغاء فاتورة المشتريات'}</AlertDialogTitle>
            <AlertDialogDescription>
              {isEn
                ? `Are you sure you want to cancel purchase invoice #${invoice?.invoice_number || ''}? Its inventory and cost impact will be reversed safely.`
                : `هل أنت متأكد من إلغاء فاتورة المشتريات رقم #${invoice?.invoice_number || ''}؟ سيتم عكس المخزون والتكلفة بأمان.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{isEn ? 'Cancel' : 'إلغاء'}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="w-4 h-4 animate-spin" />}
              {isEn ? 'Confirm' : 'تأكيد'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
