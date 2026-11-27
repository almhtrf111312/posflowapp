import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { NativeCameraPreview } from '@/components/camera/NativeCameraPreview';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLanguage } from '@/hooks/language-context';
import { useMoney } from '@/hooks/use-money';
import { toast } from '@/lib/sonner-bridge';
import {
  FileText,
  User,
  Building,
  Calendar,
  Hash,
  ArrowRight,
  ArrowLeft,
  Check,
  X,
  Plus,
  Camera,
  Image as ImageIcon,
  Loader2,
  Wallet,
  Trash2
} from 'lucide-react';
import { addWithdrawalFromShift, getActiveShift, getCashDrawerId } from '@/lib/cashbox-store';
import { loadSuppliersCloud, createSupplierCloud, SupplierBalance } from '@/lib/cloud/suppliers-cloud';
import { addActivityLog } from '@/lib/activity-log';
import { formatMoney } from '@/lib/utils';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  addPurchaseInvoiceCloud,
  addPurchaseInvoiceItemCloud,
  finalizePurchaseInvoiceCloud,
  deletePurchaseInvoiceCloud,
  loadPurchaseInvoiceWithItems,
  deletePurchaseInvoiceItemCloud,
  PurchaseInvoice,
  PurchaseInvoiceItem
} from '@/lib/cloud/purchase-invoices-cloud';
import { PurchaseInvoiceItemForm } from './PurchaseInvoiceItemForm';
import { useImageUpload } from '@/hooks/use-image-upload';
import { supabase } from '@/integrations/supabase/client';
import { addToQueue, extractErrorMessage, isNetworkSyncError } from '@/lib/sync-queue';
import { emitEvent, EVENTS } from '@/lib/events';
import { checkRealInternetAccess } from '@/hooks/use-network-status';
import { addProductCloud } from '@/lib/cloud/products-cloud';
import { loadCapitalState, withdrawCapital } from '@/lib/capital-store';

interface PurchaseInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type Step = 'header' | 'items' | 'finalize';

export function PurchaseInvoiceDialog({ open, onOpenChange, onSuccess }: PurchaseInvoiceDialogProps) {
  const { t, isRTL } = useLanguage();
  const [step, setStep] = useState<Step>('header');
  const [loading, setLoading] = useState(false);

  const m = useMoney();
  const primaryCurrencyCode = m.activeCode;
  const primaryRate = m.activeRate;
  const primarySymbol = m.activeSymbol;

  // Header form state
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [supplierCompany, setSupplierCompany] = useState('');
  const [suppliers, setSuppliers] = useState<SupplierBalance[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [newSupplier, setNewSupplier] = useState(false);
  const [paidFrom, setPaidFrom] = useState<'drawer' | 'external'>('drawer');
  const activeShift = getCashDrawerId();
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'credit'>('cash');

  // Invoice state
  const [currentInvoice, setCurrentInvoice] = useState<PurchaseInvoice | null>(null);
  const [invoiceItems, setInvoiceItems] = useState<PurchaseInvoiceItem[]>([]);
  const [showItemForm, setShowItemForm] = useState(false);

  // Invoice image — Offline-First
  const { imageValue: invoiceImageUrl, imagePreview: invoiceImagePreview, uploadStatus: invoiceImgStatus, handleBase64Image: handleInvoiceBase64, handleFileInput: handleImageUpload, clearImage: clearInvoiceImage } = useImageUpload();

  // Reset form when dialog closes
  useEffect(() => {
    if (open) {
      loadSuppliersCloud().then(setSuppliers).catch(() => {});
      setPaidFrom(getCashDrawerId() ? 'drawer' : 'external');
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      setSupplierId('');
      setNewSupplier(false);
      setStep('header');
      setInvoiceNumber('');
      setSupplierName('');
      setSupplierCompany('');
      setInvoiceDate(new Date().toISOString().split('T')[0]);
      setNotes('');
      setPaymentMethod('cash');
      setCurrentInvoice(null);
      setInvoiceItems([]);
      setShowItemForm(false);
      clearInvoiceImage();
    }
  }, [open, clearInvoiceImage]);

  const handleCreateInvoice = async () => {
    if (!invoiceNumber || (!supplierId && !(newSupplier && supplierName.trim()))) {
      toast.error(t('products.fillRequired'));
      return;
    }

    // فحص الاتصال الفعلي بالإنترنت (وليس فقط الشبكة)
    const hasInternet = await checkRealInternetAccess(2500);
    let resolvedSupplierId = supplierId;
    let resolvedSupplierName = supplierName;
    if (supplierId) {
      const sp = suppliers.find(x => x.id === supplierId);
      resolvedSupplierName = sp?.name || supplierName;
    } else if (hasInternet) {
      try {
        resolvedSupplierId = await createSupplierCloud({ name: supplierName, company: supplierCompany });
        setSupplierId(resolvedSupplierId);
        setSuppliers(await loadSuppliersCloud());
        setNewSupplier(false);
      } catch (e) {
        toast.error(extractErrorMessage(e) || t('common.error'));
        return;
      }
    } else {
      toast.error('إنشاء مورد جديد يتطلب اتصالاً بالإنترنت؛ اختر مورداً موجوداً أو اتصل بالشبكة');
      return;
    }
    if (!hasInternet) {
      const localInvoice: PurchaseInvoice = {
        id: `local_${Date.now()}`,
        user_id: 'offline',
        invoice_number: invoiceNumber,
        supplier_name: resolvedSupplierName,
        supplier_company: supplierCompany,
        supplier_id: resolvedSupplierId,
        invoice_date: invoiceDate,
        expected_items_count: 0,
        expected_total_quantity: 0,
        expected_grand_total: 0,
        actual_items_count: 0,
        actual_total_quantity: 0,
        actual_grand_total: 0,
        status: 'draft',
        notes: notes || undefined,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setCurrentInvoice(localInvoice);
      setStep('items');
      setShowItemForm(true);
      toast.success(t('purchaseInvoice.invoiceCreated') + ' (offline)', { icon: '📴' });
      return;
    }

    setLoading(true);
    const invoice = await addPurchaseInvoiceCloud({
      invoice_number: invoiceNumber,
      supplier_name: resolvedSupplierName,
      supplier_company: supplierCompany,
      supplier_id: resolvedSupplierId,
      invoice_date: invoiceDate,
      expected_items_count: 0,
      expected_total_quantity: 0,
      expected_grand_total: 0,
      payment_method: paymentMethod,
      notes: notes || undefined
    });
    setLoading(false);

    if (invoice) {
      setCurrentInvoice(invoice);
      setStep('items');
      setShowItemForm(true);
      toast.success(t('purchaseInvoice.invoiceCreated'));
    } else {
      toast.error(t('common.error'));
    }
  };

  const isOfflineInvoice = currentInvoice?.id?.startsWith('local_');

  const handleAddItem = async (item: {
    product_name: string;
    barcode?: string;
    category?: string;
    quantity: number;
    cost_price: number;
    sale_price?: number;
    product_id?: string;
    serials?: string[];
    // Extended fields
    wholesale_price?: number;
    expiry_date?: string;
    serial_number?: string;
    batch_number?: string;
    warranty?: string;
    size?: string;
    color?: string;
    weight?: string;
    fabric_type?: string;
    table_number?: string;
    order_notes?: string;
    author?: string;
    publisher?: string;
    min_stock_level?: number;
    image_url?: string;
    // Dual unit fields
    track_by_unit?: string;
    bulk_unit?: string;
    small_unit?: string;
    conversion_factor?: number;
    bulk_cost_price?: number;
    bulk_sale_price?: number;
  }) => {
    if (!currentInvoice) return;

    let resolvedProductId = item.product_id;

    // If not linked to an existing product, resolve or pre-create in products catalog
    if (!resolvedProductId && !isOfflineInvoice) {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          if (item.barcode?.trim()) {
            const { data: existing } = await supabase
              .from('products')
              .select('id')
              .eq('barcode', item.barcode.trim())
              .maybeSingle();
            if (existing) resolvedProductId = existing.id;
          }
          if (!resolvedProductId && item.product_name.trim()) {
            const { data: existing } = await supabase
              .from('products')
              .select('id')
              .ilike('name', item.product_name.trim())
              .maybeSingle();
            if (existing) resolvedProductId = existing.id;
          }

          if (!resolvedProductId) {
            const createdProd = await addProductCloud({
              name: item.product_name.trim(),
              barcode: item.barcode?.trim() || '',
              category: item.category?.trim() || '',
              costPrice: item.cost_price,
              salePrice: item.sale_price || item.cost_price,
              quantity: 0, // Initial 0; finalized invoice adds item.quantity cleanly!
              minStockLevel: item.min_stock_level || 5,
              expiryDate: item.expiry_date,
              image: item.image_url,
              wholesalePrice: item.wholesale_price,
              serialNumber: item.serial_number,
              batchNumber: item.batch_number,
              warranty: item.warranty,
              size: item.size,
              color: item.color,
              weight: item.weight,
              fabricType: item.fabric_type,
              tableNumber: item.table_number,
              orderNotes: item.order_notes,
              author: item.author,
              publisher: item.publisher,
              trackByUnit: item.track_by_unit as 'piece' | 'bulk' | undefined,
              bulkUnit: item.bulk_unit,
              smallUnit: item.small_unit,
              conversionFactor: item.conversion_factor,
              bulkCostPrice: item.bulk_cost_price,
              bulkSalePrice: item.bulk_sale_price,
            });
            if (createdProd) {
              resolvedProductId = createdProd.id;
            }
          }
        }
      } catch (err) {
        console.warn('Could not pre-create product catalog item:', err);
      }
    }

    // If offline invoice, store items locally
    if (isOfflineInvoice) {
      const localItem: PurchaseInvoiceItem = {
        id: `local_item_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        invoice_id: currentInvoice.id,
        product_name: item.product_name,
        barcode: item.barcode,
        category: item.category,
        quantity: item.quantity,
        cost_price: item.cost_price,
        sale_price: item.sale_price,
        total_cost: item.quantity * item.cost_price,
        created_at: new Date().toISOString(),
        product_id: resolvedProductId,
        serials: item.serials,
      };
      setInvoiceItems(prev => [...prev, localItem]);
      // Update local invoice totals
      setCurrentInvoice(prev => {
        if (!prev) return prev;
        const allItems = [...invoiceItems, localItem];
        return {
          ...prev,
          actual_items_count: allItems.length,
          actual_total_quantity: allItems.reduce((s, i) => s + i.quantity, 0),
          actual_grand_total: allItems.reduce((s, i) => s + i.total_cost, 0),
        };
      });
      toast.success(t('purchaseInvoice.itemAdded'));
      return;
    }

    setLoading(true);
    const newItem = await addPurchaseInvoiceItemCloud({
      invoice_id: currentInvoice.id,
      product_name: item.product_name,
      barcode: item.barcode,
      category: item.category,
      quantity: item.quantity,
      cost_price: item.cost_price,
      sale_price: item.sale_price,
      product_id: resolvedProductId,
      serials: item.serials,
    });
    setLoading(false);

    if (newItem) {
      setInvoiceItems(prev => [...prev, newItem]);
      const { invoice } = await loadPurchaseInvoiceWithItems(currentInvoice.id);
      if (invoice) setCurrentInvoice(invoice);
      toast.success(t('purchaseInvoice.itemAdded'));
    } else {
      toast.error(t('common.error'));
    }
  };

  const handleDeleteItem = async (itemId: string) => {
    if (!currentInvoice) return;

    // If offline, just remove locally
    if (isOfflineInvoice || itemId.startsWith('local_item_')) {
      setInvoiceItems(prev => {
        const filtered = prev.filter(i => i.id !== itemId);
        setCurrentInvoice(inv => {
          if (!inv) return inv;
          return {
            ...inv,
            actual_items_count: filtered.length,
            actual_total_quantity: filtered.reduce((s, i) => s + i.quantity, 0),
            actual_grand_total: filtered.reduce((s, i) => s + i.total_cost, 0),
          };
        });
        return filtered;
      });
      toast.success(t('common.success'));
      return;
    }

    const success = await deletePurchaseInvoiceItemCloud(itemId, currentInvoice.id);
    if (success) {
      setInvoiceItems(prev => prev.filter(i => i.id !== itemId));
      const { invoice } = await loadPurchaseInvoiceWithItems(currentInvoice.id);
      if (invoice) setCurrentInvoice(invoice);
      toast.success(t('common.success'));
    }
  };

  // يسحب قيمة فاتورة الشراء من رأس المال فقط إذا كان المحل يتتبع رأس مال
  const deductFromCapital = () => {
    try {
      const state = loadCapitalState();
      const tracksCapital = state.transactions.length > 0 || state.initialCapital > 0;
      if (!tracksCapital || !currentInvoice) return;
      const total = invoiceItems.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.cost_price) || 0), 0);
      if (total <= 0) return;
      const tx = withdrawCapital(total, `فاتورة شراء ${currentInvoice.invoice_number} - ${currentInvoice.supplier_name}`, 'system');
      if (!tx) toast.warning('رأس المال غير كافٍ لتغطية فاتورة الشراء، لم يتم السحب منه');
    } catch { /* ignore */ }
  };

  // إغلاق الحوار: حذف المسودة الفارغة حتى لا تُحفظ فواتير شراء بقيمة صفر
  const handleOpenChange = (next: boolean) => {
    if (!next && currentInvoice && invoiceItems.length === 0 && currentInvoice.status === 'draft') {
      if (!currentInvoice.id.startsWith('local_')) {
        deletePurchaseInvoiceCloud(currentInvoice.id).then(() => emitEvent(EVENTS.PURCHASES_UPDATED)).catch(() => {});
      }
      setCurrentInvoice(null);
    }
    onOpenChange(next);
  };

  const handleFinalize = async () => {
    if (!currentInvoice) return;
    if (invoiceItems.length === 0) {
      toast.error('أضف صنفاً واحداً على الأقل قبل حفظ الفاتورة');
      return;
    }

    setLoading(true);

    const totalCost = currentInvoice.actual_grand_total || invoiceItems.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.cost_price) || 0), 0);

    // تسجيل سحب مصروفات نقدية من الوردية النشطة إذا كان السداد نقداً لمنع عجز الصندوق
    const recordShiftCashWithdrawal = async () => {
      if (paymentMethod === 'cash' && paidFrom === 'drawer' && totalCost > 0) {
        addWithdrawalFromShift(totalCost, 'USD');
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            addActivityLog(
              'expense',
              user.id,
              user.email || 'كاشير',
              `فاتورة مشتريات نقداً من الصندوق (#${currentInvoice.invoice_number} - ${currentInvoice.supplier_name}): ${formatMoney(totalCost)}`,
              { totalCost, invoiceNumber: currentInvoice.invoice_number, supplierName: currentInvoice.supplier_name, type: 'purchase_invoice' }
            );
          }
        } catch { /* ignore log error */ }
      }
    };

    // If offline or local invoice, queue the entire invoice for later sync
    const hasInternetForFinalize = isOfflineInvoice ? false : await checkRealInternetAccess(2500);
    if (isOfflineInvoice || !hasInternetForFinalize) {
      addToQueue('purchase_invoice', {
        invoiceNumber: currentInvoice.invoice_number,
        supplierName: currentInvoice.supplier_name,
        supplierCompany: currentInvoice.supplier_company || undefined,
        supplierId: currentInvoice.supplier_id || undefined,
        amountPaid: paymentMethod === 'cash' ? totalCost : 0,
        paidFrom: paymentMethod === 'cash' ? paidFrom : undefined,
        paidShiftId: paymentMethod === 'cash' && paidFrom === 'drawer' ? (getCashDrawerId() ?? undefined) : undefined,
        invoiceDate: currentInvoice.invoice_date,
        notes: currentInvoice.notes || undefined,
        imageUrl: invoiceImageUrl || undefined,
        items: invoiceItems.map(item => ({
          product_name: item.product_name,
          barcode: item.barcode,
          category: item.category,
          quantity: item.quantity,
          cost_price: item.cost_price,
          sale_price: item.sale_price,
          product_id: item.product_id,
          serials: item.serials || undefined,
        })),
        existingInvoiceId: isOfflineInvoice ? undefined : currentInvoice.id,
      });
      setLoading(false);
      deductFromCapital();
      await recordShiftCashWithdrawal();
      toast.success(t('purchaseInvoice.finalized') + ' (offline)', { icon: '📴' });
      emitEvent(EVENTS.PURCHASES_UPDATED);
      emitEvent(EVENTS.PRODUCTS_UPDATED);
      onSuccess?.();
      onOpenChange(false);
      return;
    }

    try {
      // سجّل بيانات السداد على الفاتورة قبل الاعتماد (يُنشئ الخادم قيد المورد وحركة الصندوق ذرّياً)
      const payingCash = paymentMethod === 'cash' && totalCost > 0;
      if (payingCash && paidFrom === 'drawer' && !getCashDrawerId()) {
        setLoading(false);
        toast.error('لا توجد وردية مفتوحة للدفع من الصندوق، اختر «مصدر خارجي» أو افتح وردية');
        return;
      }
      const { error: payErr } = await supabase
        .from('purchase_invoices')
        .update({
          amount_paid: payingCash ? totalCost : 0,
          paid_from: payingCash ? paidFrom : null,
          paid_shift_id: payingCash && paidFrom === 'drawer' ? (getCashDrawerId() ?? undefined) : null,
          payment_method: paymentMethod,
        } as never)
        .eq('id', currentInvoice.id);
      if (payErr) throw payErr;

      // Save image URL if present
      if (invoiceImageUrl) {
        await supabase
          .from('purchase_invoices')
          .update({ image_url: invoiceImageUrl })
          .eq('id', currentInvoice.id);
      }

      const success = await finalizePurchaseInvoiceCloud(currentInvoice.id);
      setLoading(false);

      if (success) {
        deductFromCapital();
        await recordShiftCashWithdrawal();
        toast.success(t('purchaseInvoice.finalized'));
        emitEvent(EVENTS.PURCHASES_UPDATED);
        emitEvent(EVENTS.PRODUCTS_UPDATED);
        onSuccess?.();
        onOpenChange(false);
      } else {
        toast.error(t('common.error'));
      }
    } catch (error) {
      setLoading(false);
      const message = extractErrorMessage(error);
      if (!isNetworkSyncError(message)) {
        console.error('Finalize error:', message);
        toast.error(message || t('common.error'));
        return;
      }
      console.warn('Finalize failed on network, queueing');
      addToQueue('purchase_invoice', {
        invoiceNumber: currentInvoice.invoice_number,
        supplierName: currentInvoice.supplier_name,
        supplierCompany: currentInvoice.supplier_company || undefined,
        supplierId: currentInvoice.supplier_id || undefined,
        amountPaid: paymentMethod === 'cash' ? totalCost : 0,
        paidFrom: paymentMethod === 'cash' ? paidFrom : undefined,
        paidShiftId: paymentMethod === 'cash' && paidFrom === 'drawer' ? (getCashDrawerId() ?? undefined) : undefined,
        invoiceDate: currentInvoice.invoice_date,
        notes: currentInvoice.notes || undefined,
        imageUrl: invoiceImageUrl || undefined,
        items: invoiceItems.map(item => ({
          product_name: item.product_name,
          barcode: item.barcode,
          category: item.category,
          quantity: item.quantity,
          cost_price: item.cost_price,
          sale_price: item.sale_price,
          product_id: item.product_id,
          serials: item.serials || undefined,
        })),
        existingInvoiceId: currentInvoice.id,
      });
      deductFromCapital();
      await recordShiftCashWithdrawal();
      toast.success(t('purchaseInvoice.finalized') + ' (queued)', { icon: '📴' });
      emitEvent(EVENTS.PURCHASES_UPDATED);
      emitEvent(EVENTS.PRODUCTS_UPDATED);
      onSuccess?.();
      onOpenChange(false);
    }
  };

  const goToFinalize = () => {
    setShowItemForm(false);
    setStep('finalize');
  };

  const backToItems = () => {
    setStep('items');
    setShowItemForm(true);
  };

  const [showCameraPreview, setShowCameraPreview] = useState(false);
  
  const handleCameraCapture = () => {
    setShowCameraPreview(true);
  };

  const handleCameraCaptured = (base64: string) => {
    setShowCameraPreview(false);
    handleInvoiceBase64(base64);
  };

  if (!open) return null;

  return createPortal(
    <>
      <div
        className={cn(
          "fixed inset-0 z-50 h-[100dvh] w-full bg-background flex flex-col overflow-hidden animate-in fade-in-50 duration-150",
          showCameraPreview && "hidden"
        )}
        dir={isRTL ? 'rtl' : 'ltr'}
      >
        {/* 1. الترويسة العلوية الثابتة (Full-Screen Sticky Header) */}
        <div className="shrink-0 bg-card border-b border-border/80 px-4 py-3 sm:px-6 shadow-xs z-40">
          <div className="max-w-4xl w-full mx-auto flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 sm:w-10 sm:h-10 bg-primary/10 rounded-xl flex items-center justify-center ring-1 ring-primary/20 shrink-0">
                <FileText className="w-4 h-4 sm:w-5 sm:h-5 text-primary" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base sm:text-lg font-bold tracking-tight text-foreground truncate">
                  {t('purchaseInvoice.title')}
                </h2>
                <p className="text-xs text-muted-foreground truncate">
                  {step === 'header'
                    ? 'الخطوة 1: بيانات المورد ورقم الفاتورة'
                    : step === 'items'
                    ? 'الخطوة 2: إدخال أصناف وكميات الفاتورة'
                    : 'الخطوة 3: مراجعة واعتماد الفاتورة بالمخزون'}
                </p>
              </div>
            </div>

            {/* مؤشر المراحل المتجاوب */}
            <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none shrink-0">
              <div className={cn(
                "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 transition-all",
                step === 'header' ? "bg-primary text-primary-foreground shadow-xs" : "bg-muted text-muted-foreground"
              )}>
                <span className="w-4 h-4 rounded-full flex items-center justify-center text-xs bg-black/15">1</span>
                <span className="hidden sm:inline">{t('purchaseInvoice.headerStep')}</span>
              </div>
              <div className={cn(
                "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 transition-all",
                step === 'items' ? "bg-primary text-primary-foreground shadow-xs" : "bg-muted text-muted-foreground"
              )}>
                <span className="w-4 h-4 rounded-full flex items-center justify-center text-xs bg-black/15">2</span>
                <span className="hidden sm:inline">{t('purchaseInvoice.itemsStep')}</span>
              </div>
              <div className={cn(
                "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 transition-all",
                step === 'finalize' ? "bg-primary text-primary-foreground shadow-xs" : "bg-muted text-muted-foreground"
              )}>
                <span className="w-4 h-4 rounded-full flex items-center justify-center text-xs bg-black/15">3</span>
                <span className="hidden sm:inline">{t('purchases.finalize')}</span>
              </div>
            </div>
          </div>
        </div>

        {/* 2. جسم الشاشة الكاملة القابل للتمرير */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-4xl w-full mx-auto p-4 sm:p-6 pb-28 space-y-5">
            {/* Step 1: Header */}
            {step === 'header' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-card p-4 sm:p-6 rounded-2xl border border-border shadow-2xs">
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1 text-sm font-medium">
                    <Hash className="w-4 h-4 text-primary" />
                    {t('purchaseInvoice.invoiceNumber')} *
                  </Label>
                  <Input
                    data-testid="pi-number"
                    value={invoiceNumber}
                    onChange={(e) => setInvoiceNumber(e.target.value)}
                    placeholder="INV-2024-001"
                    className="h-11 rounded-xl"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1 text-sm font-medium">
                    <User className="w-4 h-4 text-primary" />
                    {t('purchaseInvoice.supplierName')} *
                  </Label>
                  <Select
                    value={newSupplier ? '__new__' : (supplierId || '__none__')}
                    onValueChange={(val) => {
                      if (val === '__new__') { setNewSupplier(true); setSupplierId(''); }
                      else if (val === '__none__') { setNewSupplier(false); setSupplierId(''); }
                      else { setNewSupplier(false); setSupplierId(val); }
                    }}
                  >
                    <SelectTrigger data-testid="pi-supplier" className="min-h-11 sm:min-h-10 w-full rounded-[14px]">
                      <SelectValue placeholder="— اختر المورد —" />
                    </SelectTrigger>
                    <SelectContent className="max-h-[min(20rem,60dvh)] overflow-y-auto">
                      <SelectItem value="__none__">— اختر المورد —</SelectItem>
                      {suppliers.map(sp => (
                        <SelectItem key={sp.id} value={sp.id}>
                          {sp.name}{sp.company ? ` (${sp.company})` : ''}
                        </SelectItem>
                      ))}
                      <SelectItem value="__new__">+ مورد جديد</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {newSupplier && (
                  <>
                    <div className="space-y-1.5">
                      <Label className="flex items-center gap-1 text-sm font-medium">
                        <User className="w-4 h-4 text-primary" />
                        اسم المورد الجديد *
                      </Label>
                      <Input
                        value={supplierName}
                        onChange={(e) => setSupplierName(e.target.value)}
                        placeholder={t('purchaseInvoice.supplierNamePlaceholder')}
                        className="h-11 rounded-xl"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="flex items-center gap-1 text-sm font-medium">
                        <Building className="w-4 h-4 text-primary" />
                        {t('purchaseInvoice.supplierCompany')}
                      </Label>
                      <Input
                        value={supplierCompany}
                        onChange={(e) => setSupplierCompany(e.target.value)}
                        placeholder={t('purchaseInvoice.supplierCompanyPlaceholder')}
                        className="h-11 rounded-xl"
                      />
                    </div>
                  </>
                )}

                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1 text-sm font-medium">
                    <Calendar className="w-4 h-4 text-primary" />
                    {t('purchases.invoiceDate')}
                  </Label>
                  <Input
                    type="date"
                    value={invoiceDate}
                    onChange={(e) => setInvoiceDate(e.target.value)}
                    className="h-11 rounded-xl"
                  />
                </div>

                <div className="sm:col-span-2 space-y-1.5">
                  <Label className="text-sm font-medium">{t('common.notes')}</Label>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder={t('purchaseInvoice.notesPlaceholder')}
                    rows={3}
                    className="resize-none rounded-xl"
                  />
                </div>

                <div className="sm:col-span-2 space-y-2 p-3 bg-muted/40 rounded-xl border border-border/50">
                  <Label className="flex items-center gap-1.5 text-xs sm:text-sm font-bold text-foreground">
                    <Wallet className="w-4 h-4 text-primary" />
                    طريقة السداد / الدفع
                  </Label>
                  <RadioGroup
                    value={paymentMethod}
                    onValueChange={(v) => setPaymentMethod(v as 'cash' | 'credit')}
                    className="flex flex-wrap gap-4 pt-1"
                  >
                    <div className="flex items-center gap-2 cursor-pointer">
                      <RadioGroupItem value="cash" id="invoice-pay-cash" />
                      <Label htmlFor="invoice-pay-cash" className="cursor-pointer text-xs sm:text-sm font-medium">
                        نقداً (مدفوع كاملاً الآن)
                      </Label>
                    </div>
                    <div className="flex items-center gap-2 cursor-pointer">
                      <RadioGroupItem value="credit" id="invoice-pay-credit" />
                      <Label htmlFor="invoice-pay-credit" className="cursor-pointer text-xs sm:text-sm font-medium text-muted-foreground">
                        آجل (يُسجَّل ديناً للمورد)
                      </Label>
                    </div>
                  </RadioGroup>
                  {paymentMethod === 'cash' && (
                    <RadioGroup
                      value={paidFrom}
                      onValueChange={(v) => setPaidFrom(v as 'drawer' | 'external')}
                      className="flex flex-wrap gap-4 pt-2 border-t border-border/40"
                    >
                      <div className="flex items-center gap-2 cursor-pointer">
                        <RadioGroupItem value="drawer" id="invoice-src-drawer" disabled={!activeShift} />
                        <Label htmlFor="invoice-src-drawer" className="cursor-pointer text-xs sm:text-sm">
                          من الصندوق (الغلة){!activeShift ? ' — لا توجد وردية مفتوحة' : ''}
                        </Label>
                      </div>
                      <div className="flex items-center gap-2 cursor-pointer">
                        <RadioGroupItem value="external" id="invoice-src-external" />
                        <Label htmlFor="invoice-src-external" className="cursor-pointer text-xs sm:text-sm">
                          من مصدر خارجي (لا يمسّ الصندوق)
                        </Label>
                      </div>
                    </RadioGroup>
                  )}
                </div>
              </div>
            )}

            {/* Step 2: Items */}
            {step === 'items' && currentInvoice && (
              <div className="space-y-4">
                <div className="p-3 sm:p-4 bg-card border border-border rounded-2xl flex flex-wrap items-center justify-between gap-2 shadow-2xs">
                  <div className="text-xs sm:text-sm">
                    <span className="text-muted-foreground">{t('purchaseInvoice.itemsAdded')}:</span>
                    <span dir="ltr" className="inline-block font-bold mx-1 text-foreground tabular-nums">{invoiceItems.length}</span>
                    <span className="text-muted-foreground mx-2">|</span>
                    <span className="text-muted-foreground">{t('common.total')}:</span>
                    <span dir="ltr" className="inline-block font-bold mx-1 text-primary font-mono tabular-nums">
                      {m.fmt(currentInvoice.actual_grand_total || 0)}
                    </span>
                  </div>
                  {!showItemForm && (
                    <Button
                      size="default"
                      variant="outline"
                      data-testid="pi-add-item"
                      onClick={() => setShowItemForm(true)}
                    >
                      <Plus className="w-4 h-4 shrink-0 text-primary" />
                      {t('purchaseInvoice.addAnotherItem')}
                    </Button>
                  )}
                </div>

                {invoiceItems.length > 0 && (
                  <div className="border border-border rounded-2xl overflow-x-auto max-w-full bg-card shadow-2xs">
                    <Table className="text-xs sm:text-sm min-w-[21.4rem]">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-start">{t('products.name')}</TableHead>
                          <TableHead className="text-end">{t('products.quantity')}</TableHead>
                          <TableHead className="text-end">{t('products.costPrice')}</TableHead>
                          <TableHead className="text-end">{t('common.total')}</TableHead>
                          <TableHead className="text-center w-12"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {invoiceItems.map((item) => (
                          <TableRow key={item.id}>
                            <TableCell className="font-medium text-start">{item.product_name}</TableCell>
                            <TableCell className="text-end font-mono"><span dir="ltr" className="inline-block tabular-nums">{item.quantity}</span></TableCell>
                            <TableCell className="text-end font-mono"><span dir="ltr" className="inline-block tabular-nums">{m.fmt(item.cost_price)}</span></TableCell>
                            <TableCell className="text-end font-bold font-mono"><span dir="ltr" className="inline-block tabular-nums">{m.fmt(item.total_cost)}</span></TableCell>
                            <TableCell className="text-center">
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={t('common.delete')}
                                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => handleDeleteItem(item.id)}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {showItemForm && (
                  <PurchaseInvoiceItemForm
                    onAdd={handleAddItem}
                    onClose={() => setShowItemForm(false)}
                    loading={loading}
                  />
                )}
              </div>
            )}

            {/* Step 3: Finalize with Image */}
            {step === 'finalize' && currentInvoice && (
              <div className="space-y-4">
                <div className="p-4 bg-card rounded-2xl border border-border space-y-3 shadow-2xs">
                  <h3 className="font-bold text-sm text-foreground">{t('purchases.invoiceSummary')}</h3>
                  <div className="grid grid-cols-2 gap-3 text-xs sm:text-sm">
                    <div className="p-2.5 rounded-xl bg-muted/40">
                      <span className="text-muted-foreground block text-[11px]">{t('purchaseInvoice.supplierName')}</span>
                      <span className="font-bold text-foreground">{currentInvoice.supplier_name}</span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-muted/40">
                      <span className="text-muted-foreground block text-xs">{t('purchaseInvoice.invoiceNumber')}</span>
                      <span dir="ltr" className="inline-block font-bold font-mono text-foreground tabular-nums">#{currentInvoice.invoice_number}</span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-muted/40">
                      <span className="text-muted-foreground block text-xs">{t('purchaseInvoice.itemsAdded')}</span>
                      <span dir="ltr" className="inline-block font-bold text-foreground tabular-nums">{invoiceItems.length}</span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-muted/40">
                      <span className="text-muted-foreground block text-xs">طريقة السداد</span>
                      <span className="font-bold text-foreground">
                        {paymentMethod === 'cash' ? (paidFrom === 'drawer' ? 'نقداً من الصندوق (سحب وردية)' : 'نقداً من مصدر خارجي') : 'آجل (ذمم موردين)'}
                      </span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-primary/10 border border-primary/20">
                      <span className="text-muted-foreground block text-xs">{t('common.total')}</span>
                      <span className="font-bold text-primary font-mono">
                        <span dir="ltr" className="inline-block tabular-nums">{m.fmt(currentInvoice.actual_grand_total || 0)}</span>
                        {primaryCurrencyCode !== 'USD' && (
                          <span dir="ltr" className="text-xs text-muted-foreground font-normal block font-sans tabular-nums">
                            (${currentInvoice.actual_grand_total?.toFixed(2)} USD)
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="border border-border bg-card rounded-2xl p-3.5 max-h-48 overflow-y-auto space-y-1.5">
                  {invoiceItems.map((item, index) => (
                    <div key={item.id} className="flex justify-between items-center text-xs sm:text-sm py-1.5 border-b last:border-b-0 border-border/50">
                      <span className="font-medium">{index + 1}. {item.product_name}</span>
                      <span dir="ltr" className="inline-block text-muted-foreground font-mono tabular-nums">{item.quantity} × {m.fmt(item.cost_price)}</span>
                    </div>
                  ))}
                </div>

                {/* Invoice Image Upload */}
                <div className="p-4 bg-card rounded-2xl border border-border space-y-3">
                  <Label className="text-sm font-bold block">{t('purchases.receiptPhoto')}</Label>
                  {invoiceImagePreview ? (
                    <div className="relative">
                      <img src={invoiceImagePreview} alt="Invoice" loading="lazy" decoding="async" className="w-full h-48 object-contain bg-muted/30 rounded-xl border" />
                      {invoiceImgStatus === 'syncing' && (
                        <div className="absolute top-2 start-2 bg-black/60 rounded-full p-1.5">
                          <Loader2 className="w-4 h-4 text-white animate-spin" />
                        </div>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        className="absolute top-2 end-2 rounded-xl"
                        onClick={clearInvoiceImage}
                      >
                        {t('common.delete')}
                      </Button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-12 rounded-xl font-bold gap-2"
                        onClick={handleCameraCapture}
                      >
                        <Camera className="w-4 h-4 text-primary" />
                        {t('purchases.camera')}
                      </Button>
                      <label className="w-full">
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full h-12 rounded-xl font-bold gap-2"
                          asChild
                        >
                          <span>
                            <ImageIcon className="w-4 h-4 text-primary" />
                            {t('purchases.gallery')}
                          </span>
                        </Button>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={handleImageUpload}
                        />
                      </label>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 3. شريط الأزرار السفلي الثابت والموحد للموبايل (Sticky Bottom Action Bar) */}
        <div className="shrink-0 sticky bottom-0 z-40 bg-card border-t border-border/80 p-3 sm:px-6 shadow-lg">
          <div className="max-w-4xl w-full mx-auto flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {step === 'header' && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="default"
                  onClick={() => handleOpenChange(false)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="default"
                  data-testid="pi-create"
                  onClick={handleCreateInvoice}
                  disabled={loading}
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  <span>{loading ? t('common.loading') : t('common.next')}</span>
                  <ArrowRight className="w-4 h-4 rtl:rotate-180" />
                </Button>
              </>
            )}

            {step === 'items' && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="default"
                  onClick={() => handleOpenChange(false)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="default"
                  data-testid="pi-go-finalize"
                  onClick={goToFinalize}
                  disabled={invoiceItems.length === 0 || loading}
                >
                  <span>{t('purchases.finalize')} ({invoiceItems.length})</span>
                  <ArrowRight className="w-4 h-4 rtl:rotate-180" />
                </Button>
              </>
            )}

            {step === 'finalize' && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="default"
                  onClick={backToItems}
                  disabled={loading}
                >
                  <ArrowLeft className="w-4 h-4 rtl:rotate-180" />
                  <span>{t('common.back')}</span>
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="default"
                  data-testid="pi-finalize"
                  onClick={handleFinalize}
                  disabled={loading}
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  <span>{loading ? t('common.loading') : t('purchaseInvoice.finalizeInvoice')}</span>
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <NativeCameraPreview
        isOpen={showCameraPreview}
        onClose={() => setShowCameraPreview(false)}
        onCapture={handleCameraCaptured}
        maxSize={400}
        quality={40}
      />
    </>,
    document.body
  );
}
