import { useState, useEffect, useRef } from 'react';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useLanguage } from '@/hooks/use-language';
import { useMoney } from '@/hooks/use-money';
import { toast } from '@/lib/sonner-bridge';
import {
  ArrowRight,
  ShoppingBag,
  Image as ImageIcon,
  Loader2,
  ScanLine,
  Camera,
  ChevronDown,
  ChevronUp,
  Package,
  Check,
  X,
  Layers,
  Calendar,
  Banknote,
  AlertCircle,
  Search,
  Barcode
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { addToQueue } from '@/lib/sync-queue';
import { getKnownTenantId, getOwnerIdForInsert } from '@/lib/supabase-store';
import { emitEvent, EVENTS } from '@/lib/events';
import { useCloudSyncContext } from '@/providers/CloudSyncProvider';
import { useImageUpload } from '@/hooks/use-image-upload';
import { BarcodeScanner } from '@/components/BarcodeScanner';
import { NativeCameraPreview } from '@/components/camera/NativeCameraPreview';
import { cn, formatNumber } from '@/lib/utils';
import { getActiveShift } from '@/lib/cashbox-store';
import { getCategoryNamesCloud, getCategoryNamesLocalFirst } from '@/lib/cloud/categories-cloud';
import { loadSuppliersCloud } from '@/lib/cloud/suppliers-cloud';

interface QuickPurchaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

interface ExistingProductOption {
  id: string;
  name: string;
  barcode?: string;
  category?: string;
  cost_price: number;
  sale_price: number;
  quantity?: number;
  min_stock_level?: number;
  expiry_date?: string;
  image_url?: string;
  custom_fields?: Record<string, unknown>;
}

export function QuickPurchaseDialog({ open, onOpenChange, onSuccess }: QuickPurchaseDialogProps) {
  const { t, language } = useLanguage();
  const isEn = language === 'en';
  const [loading, setLoading] = useState(false);
  const m = useMoney();
  const [inputCurrency, setInputCurrency] = useState<string>(() => m.activeCode);
  const currentDef = m.getCurrencyDef(inputCurrency);
  const currentRate = currentDef.rate;
  const currencySymbol = currentDef.symbol;

  // Payment Method: cash (drawer deduction) vs credit (supplier payable)
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'credit'>('cash');
  // Audit F7 (2026-11-24): a credit purchase must name its supplier
  const [supplierId, setSupplierId] = useState<string>('');
  const [supplierOptions, setSupplierOptions] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    if (paymentMethod !== 'credit') return;
    let cancelled = false;
    loadSuppliersCloud()
      .then(list => { if (!cancelled) setSupplierOptions(list.map(s => ({ id: s.id, name: s.name }))); })
      .catch(() => { if (!cancelled) setSupplierOptions([]); });
    return () => { cancelled = true; };
  }, [paymentMethod]);

  // Core Product Info
  const [productName, setProductName] = useState('');
  const [barcode, setBarcode] = useState('');
  const [category, setCategory] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [costPrice, setCostPrice] = useState('');
  const [salePrice, setSalePrice] = useState('');

  // Extended Product Fields (matching Add Product)
  const [wholesalePrice, setWholesalePrice] = useState('');
  const [minStockLevel, setMinStockLevel] = useState('5');
  const [expiryDate, setExpiryDate] = useState('');

  // Unit / Carton Settings (Collapsible)
  const [showUnitSettings, setShowUnitSettings] = useState(false);
  const [trackByUnit, setTrackByUnit] = useState<'piece' | 'bulk'>('piece');
  const [bulkUnit, setBulkUnit] = useState('كرتونة');
  const [smallUnit, setSmallUnit] = useState('قطعة');
  const [conversionFactor, setConversionFactor] = useState('1');
  const [bulkCostPrice, setBulkCostPrice] = useState('');
  const [bulkSalePrice, setBulkSalePrice] = useState('');

  // Existing Product Search & Selection
  const [searchResults, setSearchResults] = useState<ExistingProductOption[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<ExistingProductOption | null>(null);
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);

  // Category List — قراءة فورية من الكاش المحلي 0ms
  const [categories, setCategories] = useState<string[]>(() => getCategoryNamesLocalFirst());

  // Scanners & Camera
  const [showScanner, setShowScanner] = useState(false);
  const [showCameraPreview, setShowCameraPreview] = useState(false);

  // Image Upload Hook
  const {
    imageValue: imageUrl,
    imagePreview,
    uploadStatus: imgStatus,
    handleBase64Image,
    handleFileInput,
    clearImage,
    setInitialImage: setImageValue
  } = useImageUpload();

  // Load Categories on mount / open
  useEffect(() => {
    if (open) {
      const local = getCategoryNamesLocalFirst();
      if (local.length > 0) {
        setCategories(prev => Array.from(new Set([...prev, ...local])));
      }
      getCategoryNamesCloud().then(cats => {
        if (cats && cats.length > 0) {
          setCategories(Array.from(new Set([...local, ...cats])));
        }
      });
    }
  }, [open]);

  // Reset Form on Close
  useEffect(() => {
    if (!open) {
      setProductName('');
      setBarcode('');
      setCategory('');
      setQuantity('1');
      setCostPrice('');
      setSalePrice('');
      setWholesalePrice('');
      setMinStockLevel('5');
      setExpiryDate('');
      setShowUnitSettings(false);
      setTrackByUnit('piece');
      setBulkUnit('كرتونة');
      setSmallUnit('قطعة');
      setConversionFactor('1');
      setBulkCostPrice('');
      setBulkSalePrice('');
      setSelectedProduct(null);
      setSearchResults([]);
      setShowSearchDropdown(false);
      setShowScanner(false);
      setShowCameraPreview(false);
      clearImage();
    }
  }, [open, clearImage]);

  // Live search for existing products by name or barcode
  useEffect(() => {
    if (selectedProduct) return;
    const term = productName.trim();
    const bCode = barcode.trim();

    if (term.length < 2 && bCode.length < 3) {
      setSearchResults([]);
      setShowSearchDropdown(false);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const query = supabase
          .from('products')
          .select('id, name, barcode, category, cost_price, sale_price, quantity, min_stock_level, expiry_date, image_url, custom_fields')
          .eq('archived', false)
          .limit(6);

        if (bCode.length >= 3) {
          query.or(`barcode.ilike.%${bCode}%,barcode2.ilike.%${bCode}%,barcode3.ilike.%${bCode}%`);
        } else if (term.length >= 2) {
          query.ilike('name', `%${term}%`);
        }

        const { data } = await query;
        if (data && data.length > 0) {
          setSearchResults(data as ExistingProductOption[]);
          setShowSearchDropdown(true);
        } else {
          setSearchResults([]);
          setShowSearchDropdown(false);
        }
      } catch (err) {
        console.warn('Failed to search existing products:', err);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [productName, barcode, selectedProduct]);

  // Handle Select Existing Product
  const handleSelectProduct = (prod: ExistingProductOption) => {
    setSelectedProduct(prod);
    setProductName(prod.name);
    setBarcode(prod.barcode || '');
    setCategory(prod.category || '');
    const convertedCost = prod.cost_price ? m.fromUsd(prod.cost_price, inputCurrency, currentRate) : 0;
    const convertedSale = prod.sale_price ? m.fromUsd(prod.sale_price, inputCurrency, currentRate) : 0;
    setCostPrice(convertedCost > 0 ? String(m.roundForCurrency(convertedCost, inputCurrency)) : '');
    setSalePrice(convertedSale > 0 ? String(m.roundForCurrency(convertedSale, inputCurrency)) : '');
    if (prod.min_stock_level !== undefined && prod.min_stock_level !== null) {
      setMinStockLevel(String(prod.min_stock_level));
    }
    if (prod.expiry_date) {
      setExpiryDate(prod.expiry_date);
    }
    if (prod.custom_fields && prod.custom_fields.wholesalePrice) {
      setWholesalePrice(String(prod.custom_fields.wholesalePrice));
    }
    if (prod.image_url) {
      setImageValue(prod.image_url);
    }
    setSearchResults([]);
    setShowSearchDropdown(false);
  };

  const handleClearSelectedProduct = () => {
    setSelectedProduct(null);
  };

  // Barcode scanned
  const handleBarcodeScanned = (scannedBarcode: string) => {
    setBarcode(scannedBarcode);
    setShowScanner(false);
  };

  // Camera capture
  const handleCameraCaptured = (base64: string) => {
    setShowCameraPreview(false);
    handleBase64Image(base64);
  };

  // Calculate Subtotals & USD conversion
  const qtyNum = Math.max(1, Number.parseInt(quantity) || 1);
  const costNum = Number.parseFloat(costPrice) || 0;
  const saleNum = Number.parseFloat(salePrice) || 0;
  const wholesaleNum = Number.parseFloat(wholesalePrice) || 0;
  const bulkCostNum = Number.parseFloat(bulkCostPrice) || 0;
  const bulkSaleNum = Number.parseFloat(bulkSalePrice) || 0;

  // Values in USD for system storage & accounting
  const costNumUSD = m.toUsd(costNum, inputCurrency, currentRate);
  const saleNumUSD = saleNum > 0 ? m.toUsd(saleNum, inputCurrency, currentRate) : costNumUSD;
  const wholesaleNumUSD = wholesaleNum > 0 ? m.toUsd(wholesaleNum, inputCurrency, currentRate) : undefined;
  const bulkCostNumUSD = bulkCostNum > 0 ? m.toUsd(bulkCostNum, inputCurrency, currentRate) : undefined;
  const bulkSaleNumUSD = bulkSaleNum > 0 ? m.toUsd(bulkSaleNum, inputCurrency, currentRate) : undefined;

  const totalCostInCurrency = costNum * qtyNum;
  const totalCost = costNumUSD * qtyNum;

  const { isOnline, syncNow } = useCloudSyncContext();
  const submitting = useRef(false);
  const handleSubmit = async () => {
    if (submitting.current) return;
    if (!productName.trim() || !costPrice || !Number.isFinite(costNumUSD) || costNumUSD < 0 ||
        !Number.isFinite(qtyNum) || qtyNum <= 0) {
      toast.error(language === 'en' ? 'Enter a product name, valid cost and quantity' : 'أدخل اسم الصنف وسعر شراء وكمية صالحين');
      return;
    }

    if (paymentMethod === 'credit' && !supplierId) {
      toast.error(language === 'en' ? 'Choose the supplier for a credit purchase' : 'اختر المورد للشراء الآجل');
      return;
    }

    const shiftId = paymentMethod === 'cash' && totalCost > 0 ? getActiveShift()?.id : undefined;
    if (paymentMethod === 'cash' && totalCost > 0 && !shiftId) {
      toast.error(language === 'en' ? 'Open a cash shift before recording a cash purchase' : 'افتح وردية قبل تسجيل شراء نقدي');
      return;
    }
    submitting.current = true;
    setLoading(true);
    try {
      if (!getKnownTenantId() && isOnline) await getOwnerIdForInsert();
      if (!getKnownTenantId()) {
        toast.error(language === 'en' ? 'Connect to confirm the store before saving this purchase' : 'اتصل بالإنترنت لتأكيد المتجر قبل حفظ الشراء');
        return;
      }
      const operationId = crypto.randomUUID();
      const operation = addToQueue('quick_purchase', {
        operationId,
        productName: productName.trim(),
        quantity: qtyNum,
        costPrice: costNumUSD,
        paymentMethod,
        shiftId,
        supplierId: paymentMethod === 'credit' ? supplierId : undefined,
        imageUrl: imageUrl || undefined,
        barcode: barcode.trim() || undefined,
        category: category || undefined,
        salePrice: saleNumUSD,
        wholesalePrice: wholesaleNumUSD,
        minStockLevel: Number.parseInt(minStockLevel) || 5,
        expiryDate: expiryDate || undefined,
        trackByUnit,
        bulkUnit,
        smallUnit,
        conversionFactor: Number.parseInt(conversionFactor) || 1,
        bulkCostPrice: bulkCostNumUSD,
        bulkSalePrice: bulkSaleNumUSD,
        productId: selectedProduct?.id,
      }, 10);
      if (operation.status === 'failed') {
        toast.error(operation.error || (isEn ? 'Could not queue purchase for sync' : 'تعذر وضع الشراء في قائمة المزامنة'));
        return;
      }

      const synced = operation.status === 'completed' ||
        (isOnline && (await syncNow(true, operation.id)).targetSuccess === true);
      if (synced) toast.success(t('purchases.quickAdded') || 'تم حفظ فاتورة الشراء');
      else toast.info(language === 'en' ? 'Purchase queued for synchronization' : 'حُفظ الشراء في قائمة المزامنة');
      emitEvent(EVENTS.PURCHASES_UPDATED);
      emitEvent(EVENTS.PRODUCTS_UPDATED);
      onSuccess?.();
      onOpenChange(false);
    } catch (error) {
      console.error('Unable to save quick purchase:', error);
      toast.error(language === 'en' ? 'Check pending purchases before trying again' : 'تحقق من قائمة المزامنة قبل إعادة المحاولة');
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="w-[min(calc(100vw-1.5rem),36rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px] border border-border bg-card shadow-2xl"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => { if (loading || productName.trim() || costPrice) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <DialogTitle className="flex items-center gap-2">
              <ShoppingBag className="w-5 h-5 text-primary shrink-0" />
              <span>{t('purchases.quickAdd') || 'إضافة مشتريات سريعة'}</span>
            </DialogTitle>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {/* Existing Product Indicator */}
            {selectedProduct && (
              <div className="flex items-center justify-between p-2.5 bg-primary/10 border border-primary/20 rounded-lg text-xs">
                <div className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-primary shrink-0" />
                  <span className="font-medium text-primary">
                    {isEn ? (<>Existing product: <strong>{selectedProduct.name}</strong> (Current stock: {selectedProduct.quantity ?? 0})</>) : (<>منتج مسجل مسبقاً: <strong>{selectedProduct.name}</strong> (المخزون الحالي: {selectedProduct.quantity ?? 0})</>)}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="px-2 text-destructive hover:text-destructive hover:bg-destructive/10 text-xs"
                  onClick={handleClearSelectedProduct}
                >
                  <X className="w-3.5 h-3.5" />
                  {isEn ? "Clear Selection" : "إلغاء التحديد"}
                </Button>
              </div>
            )}

            {/* Product Name with Autocomplete */}
            <div className="space-y-1.5 relative">
              <Label className="text-xs sm:text-sm font-medium">
                {t('products.name') || 'اسم المنتج'} *
              </Label>
              <div className="relative">
                <Input
                  value={productName}
                  onChange={(e) => {
                    setProductName(e.target.value);
                    if (selectedProduct && e.target.value !== selectedProduct.name) {
                      setSelectedProduct(null);
                    }
                  }}
                  placeholder={t('purchases.itemNamePlaceholder') || 'اكتب اسم المنتج للبحث أو الإضافة...'}
                  className="pe-9 text-sm"
                  autoFocus
                />
                {productName && (
                  <button
                    type="button"
                    aria-label={isEn ? "Clear" : "مسح"}
                    onClick={() => {
                      setProductName('');
                      setSelectedProduct(null);
                      setSearchResults([]);
                    }}
                    className="absolute end-2 top-1/2 -translate-y-1/2 inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Autocomplete Dropdown */}
              {showSearchDropdown && searchResults.length > 0 && (
                <div className="absolute top-full inset-x-0 z-50 mt-1 bg-popover border border-border rounded-lg shadow-xl overflow-hidden max-h-48 overflow-y-auto">
                  <div className="p-1.5 bg-muted/60 text-xs font-medium text-muted-foreground">
                    {isEn ? "Matching products in stock:" : "منتجات مطابقة موجودة بالمخزون:"}
                  </div>
                  {searchResults.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelectProduct(item)}
                      className="w-full text-start p-2.5 hover:bg-accent flex items-center justify-between border-b last:border-b-0 text-xs transition-colors"
                    >
                      <div className="flex flex-col">
                        <span className="font-semibold text-foreground">{item.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {item.barcode ? (isEn ? `Barcode: ${item.barcode}` : `باركود: ${item.barcode}`) : (isEn ? 'No barcode' : 'بدون باركود')}
                          {item.category ? ` • ${item.category}` : ''}
                        </span>
                      </div>
                      <div className="text-end font-mono">
                        <span dir="ltr" className="inline-block text-primary font-bold tabular-nums">${item.cost_price?.toFixed(2) || '0.00'}</span>
                        <span className="text-xs text-muted-foreground block">
                          {isEn ? 'In stock:' : 'المتوفر:'} <span dir="ltr" className="inline-block tabular-nums">{item.quantity ?? 0}</span>
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Barcode & Category Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Barcode */}
              <div className="space-y-1.5">
                <Label className="text-xs sm:text-sm font-medium flex items-center justify-between">
                  <span>{t('products.barcode') || 'الباركود'}</span>
                  <span className="text-[10px] text-muted-foreground font-normal">{isEn ? "Optional" : "اختياري"}</span>
                </Label>
                <div className="flex gap-1.5">
                  <Input
                    value={barcode}
                    onChange={(e) => setBarcode(e.target.value)}
                    placeholder={isEn ? "Scan or enter barcode" : "امسح أو اكتب الباركود"}
                    className="h-10 text-sm font-mono"
                    dir="ltr"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    onClick={() => setShowScanner(true)}
                    title={isEn ? "Scan barcode with camera" : "مسح الباركود بالكاميرا"}
                    aria-label={isEn ? "Scan barcode with camera" : "مسح الباركود بالكاميرا"}
                  >
                    <ScanLine className="w-4 h-4 text-primary" />
                  </Button>
                </div>
              </div>

              {/* Category */}
              <div className="space-y-1.5">
                <Label className="text-xs sm:text-sm font-medium">
                  {t('products.category') || 'الفئة / التصنيف'}
                </Label>
                <div className="flex gap-1.5">
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger className="min-h-11 sm:min-h-10 rounded-[14px] text-sm flex-1">
                      <SelectValue placeholder={t('products.category') || 'اختر الفئة'} />
                    </SelectTrigger>
                    <SelectContent className="max-h-[min(20rem,60dvh)] overflow-y-auto">
                      {categories.map((cat) => (
                        <SelectItem key={cat} value={cat}>
                          {cat}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder={isEn ? "Or type a new one" : "أو اكتب جديدة"}
                    className="h-10 text-sm w-32 hidden sm:block"
                  />
                </div>
              </div>
            </div>

            {/* Currency Selector */}
            <div className="flex items-center justify-between bg-muted/30 px-3 py-1.5 rounded-lg border border-border/60">
              <span className="text-xs font-medium text-muted-foreground">
                {isEn ? "Purchase Currency:" : "عملة إدخال الشراء:"}
              </span>
              <div className="flex items-center gap-1 bg-background p-0.5 rounded-md border border-border/60">
                {m.enabledCurrencies.map((curr) => (
                  <button
                    key={curr.code}
                    type="button"
                    onClick={() => setInputCurrency(curr.code)}
                    className={cn(
                      "px-2.5 py-0.5 text-xs font-bold rounded transition-all flex items-center gap-1",
                      inputCurrency === curr.code
                        ? "bg-primary text-primary-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <span>{curr.symbol}</span>
                    <span>{curr.code}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Pricing and Quantities */}
            <div className="p-3 bg-muted/40 border border-border/70 rounded-xl space-y-3">
              <div className="grid grid-cols-2 gap-3">
                {/* Quantity */}
                <div className="space-y-1.5">
                  <Label className="text-xs sm:text-sm font-medium">
                    {t('products.quantity') || 'الكمية المشتراة'} *
                  </Label>
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    className="h-10 text-center font-bold text-base"
                  />
                </div>

                {/* Cost Price */}
                <div className="space-y-1.5">
                  <Label className="text-xs sm:text-sm font-medium flex items-center justify-between">
                    <span>{t('products.costPrice') || 'سعر الشراء (التكلفة)'} *</span>
                    <span className="text-[10px] text-primary font-mono">{currencySymbol}</span>
                  </Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={costPrice}
                    onChange={(e) => setCostPrice(e.target.value)}
                    placeholder="0.00"
                    className="text-end font-mono font-bold text-base tabular-nums"
                    dir="ltr"
                  />
                  {inputCurrency !== 'USD' && costPrice && (
                    <p className="text-xs text-muted-foreground font-mono mt-0.5 leading-tight">
                      <span dir="ltr" className="inline-block tabular-nums">≈ ${costNumUSD.toFixed(2)} USD</span>
                    </p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {/* Sale Price */}
                <div className="space-y-1.5">
                  <Label className="text-xs sm:text-sm font-medium flex items-center justify-between">
                    <span>{t('products.salePrice') || 'سعر البيع المقترح'}</span>
                    <span className="text-[10px] text-muted-foreground font-mono">{currencySymbol}</span>
                  </Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={salePrice}
                    onChange={(e) => setSalePrice(e.target.value)}
                    placeholder="0.00"
                    className="text-end font-mono tabular-nums"
                    dir="ltr"
                  />
                  {inputCurrency !== 'USD' && salePrice && (
                    <p className="text-xs text-muted-foreground font-mono mt-0.5 leading-tight">
                      <span dir="ltr" className="inline-block tabular-nums">≈ ${saleNumUSD.toFixed(2)} USD</span>
                    </p>
                  )}
                </div>

                {/* Wholesale Price */}
                <div className="space-y-1.5">
                  <Label className="text-xs sm:text-sm font-medium flex items-center justify-between">
                    <span>{t('products.wholesalePrice') || 'سعر الجملة'}</span>
                    <span className="text-[10px] text-muted-foreground font-mono">{currencySymbol}</span>
                  </Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={wholesalePrice}
                    onChange={(e) => setWholesalePrice(e.target.value)}
                    placeholder="0.00"
                    className="text-end font-mono tabular-nums"
                    dir="ltr"
                  />
                  {inputCurrency !== 'USD' && wholesalePrice && (
                    <p className="text-xs text-muted-foreground font-mono mt-0.5 leading-tight">
                      <span dir="ltr" className="inline-block tabular-nums">≈ ${(wholesaleNumUSD || 0).toFixed(2)} USD</span>
                    </p>
                  )}
                </div>
              </div>

              {/* Grand Total Indicator */}
              <div className="flex items-center justify-between px-3 py-2 bg-card rounded-lg border border-border">
                <span className="text-xs text-muted-foreground font-medium">
                  {(t('purchases.totalAmount') || 'إجمالي تكلفة الشراء')}:
                </span>
                <div className="text-end font-mono">
                  <span dir="ltr" className="inline-block text-base font-bold text-primary tabular-nums">
                    {m.roundForCurrency(totalCostInCurrency, inputCurrency).toLocaleString()} {currencySymbol}
                  </span>
                  {inputCurrency !== 'USD' && (
                    <span dir="ltr" className="text-xs text-muted-foreground block tabular-nums">
                      ≈ ${totalCost.toFixed(2)} USD
                    </span>
                  )}
                </div>
              </div>

              {/* Payment Method Selector */}
              <div className="space-y-1.5 pt-1">
                <Label className="text-xs sm:text-sm font-medium">{isEn ? "Purchase Payment Method" : "طريقة سداد المشتريات"}</Label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('cash')}
                    className={cn(
                      "py-2 px-3 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all",
                      paymentMethod === 'cash'
                        ? "bg-primary text-primary-foreground border-primary shadow-sm"
                        : "bg-muted/50 text-muted-foreground border-border hover:bg-muted"
                    )}
                  >
                    <span>{isEn ? "💵 Cash from Drawer" : "💵 نقداً من الصندوق"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('credit')}
                    className={cn(
                      "py-2 px-3 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all",
                      paymentMethod === 'credit'
                        ? "bg-primary text-primary-foreground border-primary shadow-sm"
                        : "bg-muted/50 text-muted-foreground border-border hover:bg-muted"
                    )}
                  >
                    <span>{isEn ? "📋 Credit (Supplier Balance)" : "📋 آجل (ذمة مورد)"}</span>
                  </button>
                </div>
                {paymentMethod === 'credit' && (
                  <div className="mt-2 space-y-1">
                    <Label className="text-xs">{isEn ? 'Supplier (required for credit)' : 'المورد (مطلوب للشراء الآجل)'}</Label>
                    <Select value={supplierId} onValueChange={setSupplierId}>
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder={isEn ? 'Choose a supplier' : 'اختر المورد'} />
                      </SelectTrigger>
                      <SelectContent>
                        {supplierOptions.map(sup => (
                          <SelectItem key={sup.id} value={sup.id}>{sup.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {supplierOptions.length === 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        {isEn ? 'Add a supplier first from the Purchases screen.' : 'أضف مورداً أولاً من شاشة المشتريات.'}
                      </p>
                    )}
                  </div>
                )}
                {paymentMethod === 'cash' && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {isEn ? "Amount will be deducted automatically from the open shift to keep the cashbox balanced." : "سيتم خصم المبلغ تلقائياً من الوردية الحالية المفتوحة لمنع أي عجز بالصندوق."}
                  </p>
                )}
              </div>
            </div>

            {/* Inventory Controls: Min Stock & Expiry */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs sm:text-sm font-medium">
                  {t('products.minStockLevel') || 'حد تنبيه المخزون'}
                </Label>
                <Input
                  type="number"
                  min="0"
                  value={minStockLevel}
                  onChange={(e) => setMinStockLevel(e.target.value)}
                  placeholder="5"
                  className="h-10 text-center font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs sm:text-sm font-medium">
                  {t('products.expiryDate') || 'تاريخ انتهاء الصلاحية'}
                </Label>
                <Input
                  type="date"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                  className="h-10 text-xs"
                />
              </div>
            </div>

            {/* Collapsible Dual Units Support */}
            <Collapsible open={showUnitSettings} onOpenChange={setShowUnitSettings} className="border rounded-xl p-3 bg-muted/20">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="w-full flex items-center justify-between p-1 h-auto text-xs font-semibold text-foreground">
                  <div className="flex items-center gap-1.5">
                    <Layers className="w-4 h-4 text-primary" />
                    <span>{isEn ? "Retail & Carton Unit Settings (Optional)" : "إعدادات وحدات التجزئة والكرتونة (اختياري)"}</span>
                  </div>
                  {showUnitSettings ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pt-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">{isEn ? "Bulk Unit (Carton / Box)" : "الوحدة الكبرى (كرتونة/صندوق)"}</Label>
                    <Input
                      value={bulkUnit}
                      onChange={(e) => setBulkUnit(e.target.value)}
                      placeholder={isEn ? "Carton" : "كرتونة"}
                      className="h-9 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{isEn ? "Small Unit (Piece / Pack)" : "الوحدة الصغرى (قطعة/علبة)"}</Label>
                    <Input
                      value={smallUnit}
                      onChange={(e) => setSmallUnit(e.target.value)}
                      placeholder={isEn ? "Piece" : "قطعة"}
                      className="h-9 text-xs"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[11px]">{isEn ? "Conversion Factor (pcs)" : "معامل التحويل (قطع)"}</Label>
                    <Input
                      type="number"
                      min="1"
                      value={conversionFactor}
                      onChange={(e) => setConversionFactor(e.target.value)}
                      className="h-9 text-xs text-center font-mono"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px]">{isEn ? "Carton Cost" : "تكلفة الكرتونة"} ({currencySymbol})</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={bulkCostPrice}
                      onChange={(e) => setBulkCostPrice(e.target.value)}
                      placeholder="0.00"
                      className="h-9 text-xs font-mono"
                      dir="ltr"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px]">{isEn ? "Carton Sale Price" : "سعر بيع الكرتونة"} ({currencySymbol})</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={bulkSalePrice}
                      onChange={(e) => setBulkSalePrice(e.target.value)}
                      placeholder="0.00"
                      className="h-9 text-xs font-mono"
                      dir="ltr"
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* Product / Receipt Photo */}
            <div className="space-y-2">
              <Label className="text-xs sm:text-sm font-medium">
                {isEn ? "Product or Invoice Image" : "صورة المنتج أو الفاتورة"}
              </Label>
              {imagePreview ? (
                <div className="relative w-full h-32 rounded-xl overflow-hidden border border-border group bg-black/5">
                  <img src={imagePreview} alt="Receipt Preview" loading="lazy" decoding="async" className="w-full h-full object-contain" />
                  {imgStatus === 'syncing' && (
                    <div className="absolute top-2 start-2 bg-black/70 rounded-full px-2 py-1 flex items-center gap-1.5 text-xs text-white">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>{isEn ? "Syncing..." : "جارٍ المزامنة..."}</span>
                    </div>
                  )}
                  <Button
                    size="sm"
                    variant="destructive"
                    className="absolute top-2 end-2 text-xs shadow-md"
                    onClick={clearImage}
                  >
                    <X className="w-3.5 h-3.5" />
                    {t('common.delete') || 'حذف الصورة'}
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-10 text-xs font-medium"
                    onClick={() => setShowCameraPreview(true)}
                  >
                    <Camera className="w-4 h-4 text-primary" />
                    {isEn ? "Take Photo" : "التقاط بالكاميرا"}
                  </Button>
                  <label className="flex-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full h-10 text-xs font-medium"
                      asChild
                    >
                      <span>
                        <ImageIcon className="w-4 h-4 text-primary" />
                        {isEn ? "Choose from Gallery" : "اختيار من المعرض"}
                      </span>
                    </Button>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleFileInput}
                    />
                  </label>
                </div>
              )}
            </div>

            {/* Action Buttons */}
          </DialogBody>

          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60 bg-card">
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              {t('common.cancel') || 'إلغاء'}
            </Button>
            <Button
              type="button"
              variant="default"
              size="default"
              onClick={handleSubmit}
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{t('common.loading') || 'جارٍ الحفظ...'}</span>
                </>
              ) : (
                <>
                  <Package className="w-4 h-4" />
                  <span>{selectedProduct ? (isEn ? 'Update Stock & Invoice' : 'تحديث المخزون والفاتورة') : (isEn ? 'Save Product & Update Stock' : 'حفظ المنتج وتحديث المخزون')}</span>
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Barcode Scanner Dialog */}
      {showScanner && (
        <BarcodeScanner
          isOpen={showScanner}
          onScan={handleBarcodeScanned}
          onClose={() => setShowScanner(false)}
        />
      )}

      {/* Camera Capture Dialog */}
      {showCameraPreview && (
        <NativeCameraPreview
          isOpen={showCameraPreview}
          onCapture={handleCameraCaptured}
          onClose={() => setShowCameraPreview(false)}
        />
      )}
    </>
  );
}
