import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Barcode,
  Box,
  Package,
  Plus,
  Minus,
  X,
  Copy,
  Check,
  Banknote,
  AlertTriangle,
} from 'lucide-react';
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { toast } from '@/lib/sonner-bridge';
import { ProductImage } from '@/components/products/ProductImage';
import { loadAllWarehouseStocksLocalFirst } from '@/lib/cloud/warehouses-cloud';
import { cn, formatMoney } from '@/lib/utils';
import { useLanguage } from '@/hooks/language-context';
import { useUserRole } from '@/hooks/user-role-context';
import { getLocalizedUnit } from '@/lib/product-units';

export interface Product {
  id: string;
  name: string;
  price: number;
  quantity: number;
  category?: string;
  image?: string;
  imageUrl?: string;
  description?: string;
  barcode?: string;
  costPrice?: number;
  bulkCostPrice?: number;
  bulkSalePrice?: number;
  wholesalePrice?: number;
  conversionFactor?: number;
  bulkUnit?: string;
  smallUnit?: string;
  location?: string;
  supplier?: string;
  warranty?: string;
  minStockLevel?: number;
  archived?: boolean;
}

interface ProductDetailsDialogProps {
  product: Product | null;
  isOpen: boolean;
  onClose: () => void;
  onAddToCart?: (product: Product, quantity: number) => void;
  onEditProduct?: (product: Product) => void;
}

export function ProductDetailsDialog({
  product,
  isOpen,
  onClose,
  onAddToCart,
}: ProductDetailsDialogProps) {
  const { language } = useLanguage();
  const { isCashier } = useUserRole();
  // تبويبان فقط: الأسعار والمخزون
  const [activeTab, setActiveTab] = useState<'pricing' | 'inventory'>('pricing');
  const [qty, setQty] = useState(1);
  const [copiedBarcode, setCopiedBarcode] = useState(false);
  const [dragY, setDragY] = useState(0);
  const touchStartY = useRef(0);
  const isDragging = useRef(false);

  const hasProduct = !!product;
  useEffect(() => {
    if (hasProduct) {
      setQty(1);
      setActiveTab('pricing');
    }
  }, [product?.id, hasProduct]);

  // مخزون المستودع الإضافي إن وجد
  const warehouseStockQty = useMemo(() => {
    if (!product?.id) return 0;
    try {
      const allStocks = loadAllWarehouseStocksLocalFirst();
      if (!allStocks || !allStocks.length) return 0;
      return allStocks
        .filter(ws => ws.product_id === product.id)
        .reduce((acc, ws) => acc + (Number(ws.quantity) || 0), 0);
    } catch {
      return 0;
    }
  }, [product?.id]);

  if (!product) return null;

  // الحسابات تعتمد حصرياً على البيانات الفعلية
  const salePrice = Number(product.price) || 0;

  const wholesalePrice =
    product.wholesalePrice !== undefined &&
    product.wholesalePrice !== null &&
    !isNaN(Number(product.wholesalePrice)) &&
    Number(product.wholesalePrice) > 0
      ? Number(product.wholesalePrice)
      : null;
  const hasWholesale = wholesalePrice !== null;

  const stock = Number(product.quantity) || 0;
  const minStock =
    product.minStockLevel !== undefined &&
    product.minStockLevel !== null &&
    !isNaN(Number(product.minStockLevel)) &&
    Number(product.minStockLevel) > 0
      ? Number(product.minStockLevel)
      : null;

  const handleCopyBarcode = () => {
    if (product.barcode) {
      navigator.clipboard.writeText(product.barcode);
      setCopiedBarcode(true);
      toast.success('تم نسخ الباركود بنجاح');
      setTimeout(() => setCopiedBarcode(false), 2000);
    }
  };

  const handleAdd = () => {
    if (onAddToCart) onAddToCart(product, qty);
    onClose();
  };

  // معالجة سحب الشاشة لأسفل للإغلاق بسلاسة
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    isDragging.current = true;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging.current) return;
    const diff = e.touches[0].clientY - touchStartY.current;
    if (diff > 0) {
      setDragY(diff);
    }
  };

  const handleTouchEnd = () => {
    if (!isDragging.current) return;
    isDragging.current = false;
    if (dragY > 80) {
      onClose();
    }
    setDragY(0);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        dir={language === 'en' ? 'ltr' : 'rtl'}
        className="!fixed !inset-x-0 !bottom-0 !top-auto !z-50 !mx-auto !w-full !max-w-md !max-h-[90vh] !max-h-[90dvh] !rounded-t-[32px] !border-t !border-border !bg-background !p-0 !text-foreground !shadow-2xl duration-300 animate-in slide-in-from-bottom [&>button:last-child]:hidden flex flex-col overflow-hidden"
        style={{
          left: 0,
          right: 0,
          margin: '0 auto',
          transform: `translateY(${dragY}px)`,
          transition: isDragging.current ? 'none' : 'transform 0.2s ease-out',
        }}
      >
        <DialogTitle className="sr-only">{product.name}</DialogTitle>
        <DialogDescription className="sr-only">تفاصيل المنتج</DialogDescription>

        {/* رأس النافذة: شريط السحب + شارة القسم + زر الإغلاق الدائري */}
        <div
          className="flex flex-col items-center pt-3 pb-2 px-5 cursor-grab active:cursor-grabbing select-none shrink-0"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {/* مقبض السحب */}
          <div
            className="h-1.5 w-12 rounded-full bg-muted-foreground/25 hover:bg-muted-foreground/45 mb-2.5 cursor-pointer transition-colors"
            onClick={onClose}
          />

          <div className="flex w-full items-center justify-between">
            {/* شارة القسم: كبسولة هادئة مع نقطة بارزة */}
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-primary/10 text-primary border border-primary/20 shadow-2xs">
              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
              <span>{language === 'en' ? 'Category: ' : 'قسم: '}{product.category || (language === 'en' ? 'General' : 'عام')}</span>
            </div>

            {/* زر إغلاق دائري (X) في أقصى اليسار */}
            <button
              type="button"
              onClick={onClose}
              className="flex size-11 sm:size-10 items-center justify-center rounded-full bg-muted/70 text-muted-foreground hover:text-foreground hover:bg-muted active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-[transform,color,background-color] duration-150 border border-border/50"
              aria-label={language === 'en' ? 'Close' : 'إغلاق'}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* بطاقة بيانات الصنف الرئيسية (Hero Card) */}
        <div className="px-5 pb-3 shrink-0">
          <div className="bg-card rounded-3xl border border-border/80 shadow-xs p-4 flex items-center justify-between gap-3.5">
            <div className="flex-1 min-w-0">
              <h3 className="text-sm md:text-base font-bold text-foreground truncate" title={product.name}>
                {product.name}
              </h3>
              {product.description ? (
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1" title={product.description}>
                  {product.description}
                </p>
              ) : null}

              <div className="flex items-center gap-2.5 mt-2 flex-wrap">
                <span dir="ltr" className="inline-block text-lg md:text-xl font-black text-primary tracking-tight font-mono tabular-nums">
                  ${salePrice.toFixed(2)}
                </span>
                {product.barcode && (
                  <button
                    type="button"
                    onClick={handleCopyBarcode}
                    title={language === 'en' ? 'Click to copy barcode' : 'انقر لنسخ الباركود'}
                    className="inline-flex min-h-11 sm:min-h-9 items-center gap-1.5 px-2.5 py-1 rounded-xl bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground border border-border/60 text-xs font-mono font-medium active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-[transform,color,background-color] duration-150 shadow-2xs"
                  >
                    <Barcode className="h-3.5 w-3.5 text-primary shrink-0" />
                    <span dir="ltr" className="inline-block tabular-nums">{product.barcode}</span>
                    {copiedBarcode ? (
                      <Check className="h-3 w-3 text-success shrink-0" />
                    ) : (
                      <Copy className="h-3 w-3 text-muted-foreground shrink-0" />
                    )}
                  </button>
                )}
              </div>
            </div>

            {/* صورة المنتج عبر ProductImage تشغل 100% من الحاوية المتناسقة مع الكاش أوفلاين وسحابياً */}
            <div className="h-20 w-20 md:h-22 md:w-22 rounded-2xl overflow-hidden border border-border/70 bg-muted/20 shadow-2xs shrink-0 flex items-center justify-center">
              <ProductImage
                imageUrl={product.image || product.imageUrl}
                alt={product.name}
                className="w-full h-full object-cover"
                iconClassName="w-8 h-8 text-muted-foreground/40"
              />
            </div>
          </div>
        </div>

        {/* التبويبات (تبويبان فقط: الأسعار والمخزون) بتصميم الكبسولات الموحد */}
        <div className="px-5 pb-2 shrink-0">
          <div className="flex p-1 bg-muted/60 rounded-2xl border border-border/40 shadow-xs select-none gap-1">
            <button
              type="button"
              onClick={() => setActiveTab('pricing')}
              className={cn(
                "flex-1 flex min-h-11 sm:min-h-10 items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs md:text-sm font-bold transition-[transform,color,background-color] duration-150 select-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                activeTab === 'pricing'
                  ? "bg-gradient-primary text-primary-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground hover:bg-card/60"
              )}
            >
              <Banknote className="w-3.5 h-3.5" />
              <span>{language === 'en' ? 'Pricing' : 'الأسعار'}</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('inventory')}
              className={cn(
                "flex-1 flex min-h-11 sm:min-h-10 items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs md:text-sm font-bold transition-[transform,color,background-color] duration-150 select-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                activeTab === 'inventory'
                  ? "bg-gradient-primary text-primary-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground hover:bg-card/60"
              )}
            >
              <Package className="w-3.5 h-3.5" />
              <span>{language === 'en' ? 'Inventory' : 'المخزون'}</span>
            </button>
          </div>
        </div>

        {/* محتوى التبويبات المتناسق مع UI Scale */}
        <div className="px-5 py-2 space-y-2.5 flex-1 overflow-y-auto">
          {/* التبويب الأول: الأسعار */}
          {activeTab === 'pricing' && (
            <div className="space-y-2.5">
              {/* بطاقة سعر المبيع الأساسي */}
              <div className="rounded-2xl bg-card p-3.5 border border-border/70 shadow-2xs flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-xl bg-primary/10 text-primary">
                    <Banknote className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-xs font-bold text-foreground block">{language === 'en' ? 'Base Retail Price' : 'سعر المبيع الأساسي'}</span>
                    <span className="text-[11px] text-muted-foreground">{language === 'en' ? 'Standard per-unit price' : 'السعر المعتمد للقطعة الواحدة'}</span>
                  </div>
                </div>
                <span dir="ltr" className="inline-block text-base font-black text-primary font-mono tabular-nums">
                  {formatMoney(salePrice)}
                </span>
              </div>

              {/* بطاقة سعر الجملة مع أيقونة الصندوق (محجوبة عن الكاشير) */}
              {!isCashier && (
                <div className="rounded-2xl bg-card p-3.5 border border-border/70 shadow-2xs flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-xl bg-primary/10 text-primary">
                      <Box className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="text-xs font-bold text-foreground block">{language === 'en' ? 'Wholesale Price' : 'سعر الجملة'}</span>
                      <span className="text-[11px] text-muted-foreground">{language === 'en' ? 'Applied for bulk quantities' : 'يطبق تلقائياً عند طلب الكميات'}</span>
                    </div>
                  </div>
                  <span dir="ltr" className="inline-block text-sm md:text-base font-bold text-foreground font-mono tabular-nums">
                    {hasWholesale ? formatMoney(wholesalePrice!) : (language === 'en' ? 'None' : 'لا يوجد')}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* التبويب الثاني: المخزون */}
          {activeTab === 'inventory' && (
            <div className="space-y-2.5">
              {/* الصف الأول: الكمية المتوفرة بالمحل + حد إعادة الطلب */}
              <div className="grid grid-cols-2 gap-2.5">
                {/* بطاقة الكمية المتوفرة بالمحل */}
                <div className="rounded-2xl bg-card p-3.5 border border-border/70 shadow-2xs flex flex-col justify-between text-start">
                  <span className="text-xs text-muted-foreground block mb-1">
                    {language === 'en' ? 'Available in Store:' : 'الكمية المتوفرة بالمحل:'}
                  </span>
                  <p className={cn("text-base md:text-lg font-black font-mono my-0.5", stock > 0 ? "text-foreground" : "text-destructive")}>
                    <span dir="ltr" className="inline-block tabular-nums">{stock}</span> {getLocalizedUnit(product.smallUnit, false, language)}
                  </p>
                  <div>
                    {stock > 0 ? (
                      <span className="inline-flex items-center text-[11px] font-semibold text-success">
                        {language === 'en' ? '✓ In stock' : '✓ متوفر للبيع الفوري'}
                      </span>
                    ) : (
                      <span className="inline-flex items-center text-[11px] font-bold text-destructive">
                        {language === 'en' ? 'Out of stock' : 'نفد المخزون'}
                      </span>
                    )}
                  </div>
                </div>

                {/* بطاقة حد إعادة الطلب */}
                <div className="rounded-2xl bg-card p-3.5 border border-border/70 shadow-2xs flex flex-col justify-between text-start">
                  <span className="text-xs text-muted-foreground block mb-1">
                    {language === 'en' ? 'Reorder Level:' : 'حد إعادة الطلب:'}
                  </span>
                  <p className="text-base md:text-lg font-black text-destructive font-mono my-0.5">
                    {minStock !== null ? (<><span dir="ltr" className="inline-block tabular-nums">{minStock}</span> {getLocalizedUnit(product.smallUnit, false, language)}</>) : (language === 'en' ? 'None' : 'لا يوجد')}
                  </p>
                  <span className="text-[11px] text-muted-foreground">
                    {language === 'en' ? 'Low stock alert' : 'تنبيه عند الاقتراب'}
                  </span>
                </div>
              </div>

              {/* الصف الثاني: الصنف / التصنيف + فترة الضمان */}
              <div className="grid grid-cols-2 gap-2.5">
                {/* بطاقة الصنف */}
                <div className="rounded-2xl bg-card p-3.5 border border-border/70 shadow-2xs flex flex-col justify-between text-start">
                  <span className="text-xs text-muted-foreground block mb-1">
                    {language === 'en' ? 'Category:' : 'الصنف:'}
                  </span>
                  <p className="text-xs md:text-sm font-bold text-foreground my-0.5 truncate" title={product.category || (language === 'en' ? 'General' : 'عام')}>
                    {product.category || (language === 'en' ? 'General' : 'عام')}
                  </p>
                  <span className="text-[11px] text-muted-foreground">
                    {language === 'en' ? 'Classification' : 'القسم الفعلي للمنتج'}
                  </span>
                </div>

                {/* بطاقة فترة الضمان */}
                <div className="rounded-2xl bg-card p-3.5 border border-border/70 shadow-2xs flex flex-col justify-between text-start">
                  <span className="text-xs text-muted-foreground block mb-1">
                    {language === 'en' ? 'Warranty:' : 'فترة الضمان:'}
                  </span>
                  <p className="text-xs md:text-sm font-bold text-foreground my-0.5 truncate">
                    {product.warranty ? product.warranty : (language === 'en' ? 'None' : 'لا يوجد')}
                  </p>
                  <span className="text-[11px] text-muted-foreground">
                    {language === 'en' ? 'Official warranty' : 'الضمان المعتمد للمنتج'}
                  </span>
                </div>
              </div>

              {/* بطاقة المستودع إن وجد رصيد إضافي */}
              {warehouseStockQty > 0 && (
                <div className="rounded-2xl bg-card p-3.5 border border-border/70 shadow-2xs flex justify-between items-center text-xs">
                  <span className="text-muted-foreground">
                    {language === 'en' ? 'Main Warehouse:' : 'المستودع الرئيسي:'}
                  </span>
                  <span className="font-bold text-foreground font-mono">
                    <span dir="ltr" className="inline-block tabular-nums">{warehouseStockQty}</span> {language === 'en' ? 'extra pcs' : 'قطعة إضافية'}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* شريط الإجراء السفلي: عداد كمية مستقل + زر إضافة عريض بحساب ديناميكي */}
        {stock <= 0 ? (
          <div className="shrink-0 px-5 pt-2 pb-[max(1rem,env(safe-area-inset-bottom,0px))]">
            <div className="rounded-2xl bg-destructive/10 py-3 text-center text-xs md:text-sm font-bold text-destructive border border-destructive/20 flex items-center justify-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{language === 'en' ? 'This item is currently out of stock' : 'هذا الصنف غير متوفر حالياً بالمخزون'}</span>
            </div>
          </div>
        ) : onAddToCart ? (
          <div className="shrink-0 flex items-center gap-3 border-t border-border bg-card px-5 pt-3.5 pb-[max(1rem,env(safe-area-inset-bottom,0px))]">
            {/* عداد كمية أملس داخل كبسولة مستقلة */}
            <div className="flex items-center gap-1.5 rounded-2xl bg-muted/60 px-2 py-1.5 border border-border/70 shadow-2xs">
              <button
                type="button"
                onClick={() => setQty(q => Math.max(1, q - 1))}
                disabled={qty <= 1}
                className="flex size-10 sm:size-9 items-center justify-center rounded-xl bg-card text-foreground shadow-2xs hover:bg-muted active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-[transform,background-color,opacity] duration-150 disabled:opacity-50 disabled:pointer-events-none"
                aria-label="تقليل الكمية"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <span dir="ltr" className="w-8 text-center text-sm font-bold text-foreground font-mono tabular-nums">{qty}</span>
              <button
                type="button"
                onClick={() => setQty(q => Math.min(stock, q + 1))}
                disabled={qty >= stock}
                className="flex size-10 sm:size-9 items-center justify-center rounded-xl bg-card text-foreground shadow-2xs hover:bg-muted active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-[transform,background-color,opacity] duration-150 disabled:opacity-50 disabled:pointer-events-none"
                aria-label="زيادة الكمية"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* زر إضافة عريض بلون الثيم الأساسي (+ إضافة للفاتورة) يحسب المبلغ الإجمالي ديناميكياً */}
            <Button
              type="button"
              variant="default"
              size="default"
              onClick={handleAdd}
              className="flex flex-1 min-h-11 items-center justify-between gap-2 rounded-2xl px-4 text-xs md:text-sm font-bold"
            >
              <div className="flex items-center gap-1.5">
                <Plus className="h-4 w-4 shrink-0" />
                <span>{language === 'en' ? 'Add to Invoice' : 'إضافة للفاتورة'}</span>
              </div>
              <span dir="ltr" className="inline-block px-2.5 py-0.5 rounded-xl bg-primary-foreground/20 text-primary-foreground font-mono tabular-nums font-bold text-xs">
                ${(salePrice * qty).toFixed(2)}
              </span>
            </Button>
          </div>
        ) : (
          <div className="shrink-0 px-5 pt-2 pb-[max(1rem,env(safe-area-inset-bottom,0px))]">
            <Button
              type="button"
              variant="secondary"
              size="default"
              onClick={onClose}
              className="w-full rounded-2xl text-xs md:text-sm font-bold"
            >
              {language === 'en' ? 'Close' : 'إغلاق'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
