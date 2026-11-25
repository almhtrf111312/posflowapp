import { findSerialLocal } from '@/lib/serials-store';
import { useState, useRef, useEffect, useMemo, memo } from 'react';
import { Search, Barcode, Package, LayoutGrid, Grid3x3, List, AlignJustify } from 'lucide-react';
import { ProductImage } from '@/components/products/ProductImage';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn, formatNumber } from '@/lib/utils';
import { fromUsd, roundForCurrency as roundForCurr } from '@/lib/money-engine';
import { BarcodeScanner } from '@/components/BarcodeScanner';
import { DualUnitDisplayCompact } from '@/components/products/DualUnitDisplay';
import { ProductDetailsDialog } from '@/components/pos/ProductDetailsDialog';
import { toast } from '@/lib/sonner-bridge';
import { useLanguage } from '@/hooks/language-context';
import { saveUnifiedStoreSettings } from '@/lib/store-settings-sync';
import { isGuestDemoMode } from '@/lib/demo-data';
import { getCurrentStoreType, isNoInventoryMode } from '@/lib/store-type-config';

interface Product {
  id: string;
  name: string;
  price: number;
  quantity: number;
  category?: string;
  image?: string;
  imageUrl?: string;
  description?: string;
  barcode?: string;
  barcode2?: string;
  barcode3?: string;
  conversionFactor?: number;
  bulkUnit?: string;
  smallUnit?: string;
  costPrice?: number;
  bulkCostPrice?: number;
  bulkSalePrice?: number;
  wholesalePrice?: number;
  location?: string;
  supplier?: string;
  warranty?: string;
  minStockLevel?: number;
  archived?: boolean;
}

interface ProductGridProps {
  products: Product[];
  categories: string[];
  searchQuery: string;
  selectedCategory: string;
  onSearchChange: (query: string) => void;
  onCategoryChange: (category: string) => void;
  onProductClick: (product: Product, quantity?: number) => void;
  onAddToCart?: (product: Product, quantity: number) => void;
  onBarcodeScan?: (barcode: string) => void;
  selectedCurrency?: { code: string; symbol: string; rate: number };
  /** المنتجات ما زالت تُحمَّل من التخزين المحلي: تُعرض بطاقات هيكلية بدلاً من حالة الفراغ */
  isLoading?: boolean;
}

type ViewMode = 'grid' | 'dense' | 'list' | 'compact';

export const ProductGrid = memo(function ProductGrid({
  products,
  categories,
  searchQuery,
  selectedCategory,
  onSearchChange,
  onCategoryChange,
  onProductClick,
  onAddToCart,
  onBarcodeScan,
  selectedCurrency,
  isLoading = false,
}: ProductGridProps) {
  const [scannerOpen, setScannerOpen] = useState(false);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t, tDynamic, isRTL } = useLanguage();
  const isRestaurant = getCurrentStoreType() === 'restaurant';

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem('pos_view_mode') as ViewMode) || 'grid';
  });

  useEffect(() => {
    localStorage.setItem('pos_view_mode', viewMode);
  }, [viewMode]);

  // تنسيق السعر بالعملة المختارة ومعدل الصرف
  const formatDisplayPrice = (usdPrice: number) => {
    const code = selectedCurrency?.code || 'USD';
    const rate = selectedCurrency?.rate || 1;
    const symbol = selectedCurrency?.symbol || '$';
    const converted = roundForCurr(fromUsd(usdPrice, code, rate), code);
    const decimals = (rate >= 100) ? 0 : 2;

    return { symbol, amount: formatNumber(converted, decimals) };
  };

  const renderDisplayPrice = (usdPrice: number, sizeClassName: string) => {
    const { symbol, amount } = formatDisplayPrice(usdPrice);

    return (
      <span
        className={cn('inline-flex max-w-full min-w-0 items-center gap-1 whitespace-nowrap text-start tabular-nums', sizeClassName)}
        dir="ltr"
        title={`${symbol} ${amount}`}
      >
        <span className="shrink-0 text-[0.75em] font-semibold text-muted-foreground">{symbol}</span>
        <span aria-hidden="true" className="h-3 w-px shrink-0 bg-muted-foreground/50" />
        <span className="shrink-0 whitespace-nowrap font-black text-primary">{amount}</span>
      </span>
    );
  };

  // تغيّر الحجم من جهاز آخر (مزامنة الإعدادات)
  useEffect(() => {
    const onRemote = (e: Event) => {
      const v = (e as CustomEvent<string>).detail;
      if (v === 'grid' || v === 'dense' || v === 'list' || v === 'compact') setViewMode(v);
    };
    window.addEventListener('hp-pos-view-mode-changed', onRemote);
    return () => window.removeEventListener('hp-pos-view-mode-changed', onRemote);
  }, []);

  const cycleViewMode = () => {
    const next: ViewMode = viewMode === 'grid' ? 'dense' : viewMode === 'dense' ? 'list' : viewMode === 'list' ? 'compact' : 'grid';
    setViewMode(next);
    try {
      localStorage.setItem('pos_view_mode', next);
      if (!isGuestDemoMode()) void saveUnifiedStoreSettings({ appearanceSettings: { posViewMode: next } });
    } catch { /* ignore */ }
  };

  // ✅ استعادة الباركود المعلق — يتم التعامل معها في POS.tsx الآن
  // ProductGrid لم يعد يعالج PENDING_BARCODE_KEY مباشرة لتجنب التكرار

  const noInventory = isNoInventoryMode();

  const filteredProducts = useMemo(() => {
    const query = searchQuery.toLowerCase();
    const serialHitId = findSerialLocal(searchQuery);
    return products.filter(product => {
      if (product.archived) return false;
      if (!noInventory && product.quantity <= 0) return false;
      const matchesSearch = product.name.toLowerCase().includes(query) ||
        (product.barcode && product.barcode.includes(searchQuery)) ||
        (serialHitId !== undefined && product.id === serialHitId);
      const matchesCategory = selectedCategory === t('common.all') || product.category === selectedCategory;
      return matchesSearch && matchesCategory;
    });
  }, [products, noInventory, searchQuery, selectedCategory, t]);

  const pageSize = 48;
  const [page, setPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(filteredProducts.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const catalogScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => setPage(0), [searchQuery, selectedCategory]);
  useEffect(() => setPage(value => Math.min(value, lastPage)), [lastPage]);
  useEffect(() => { catalogScrollRef.current?.scrollTo(0, 0); }, [currentPage]);

  const visibleProducts = useMemo(() =>
    filteredProducts.slice(currentPage * pageSize, (currentPage + 1) * pageSize),
  [filteredProducts, currentPage]);

  const handleBarcodeScan = (barcode: string) => {
    // ✅ Don't call setScannerOpen(false) here — onClose callback handles it
    onSearchChange(barcode);
    onBarcodeScan?.(barcode);
    try { localStorage.removeItem('posflow_pending_scan'); } catch { /* intentionally empty */ }
  };

  const touchMovedRef = useRef(false);
  const longPressTriggeredRef = useRef(false);

  const handleLongPressStart = (product: Product) => {
    touchMovedRef.current = false;
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      if (!touchMovedRef.current) {
        longPressTriggeredRef.current = true;
        setSelectedProduct(product);
        setDetailsDialogOpen(true);
        if (navigator.vibrate) navigator.vibrate(50);
      }
    }, 500);
  };

  const handleLongPressEnd = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleTouchMove = () => {
    touchMovedRef.current = true;
    handleLongPressEnd();
  };

  const handleProductClick = (product: Product) => {
    handleLongPressEnd();
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return;
    }
    onProductClick(product);
  };

  const pressHandlers = (product: Product) => ({
    onClick: () => handleProductClick(product),
    onTouchStart: () => handleLongPressStart(product),
    onTouchEnd: handleLongPressEnd,
    onTouchCancel: handleLongPressEnd,
    onTouchMove: handleTouchMove,
    onMouseDown: () => handleLongPressStart(product),
    onMouseUp: handleLongPressEnd,
    onMouseLeave: handleLongPressEnd,
  });

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-muted/20">
      {/* Modern Apple-like Header Area */}
      <div data-tour="search-bar" className="px-3 py-3 md:px-5 md:py-5 flex flex-col gap-3 md:gap-4 bg-transparent shrink-0">
        <div className="flex gap-2.5 items-center">
          <div className="flex-1 relative flex items-center shadow-[0_4px_20px_rgb(0,0,0,0.03)] dark:shadow-[0_4px_20px_rgb(0,0,0,0.2)] rounded-full">
            <Search className="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
            <Input
              type="text"
              placeholder={tDynamic('productSearch')}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const trimmed = searchQuery.trim();
                  if (trimmed) {
                    const match = products.find(p => p.barcode === trimmed || p.barcode2 === trimmed || p.barcode3 === trimmed);
                    if (match) onProductClick(match);
                  }
                }
              }}
              className="ps-12 pe-4 h-12 md:h-14 rounded-full bg-card border border-border/50 text-sm md:text-base shadow-none w-full focus-visible:ring-2 focus-visible:ring-primary/30 transition-[box-shadow,border-color] font-medium"
            />
          </div>

          {!isRestaurant && (
            <Button
              variant="outline"
              size="icon"
              aria-label={t('pos.scanBarcode') || 'Scan barcode'}
              className="h-12 w-12 md:h-14 md:w-14 rounded-full bg-card border border-border/50 shadow-[0_4px_20px_rgb(0,0,0,0.03)] dark:shadow-[0_4px_20px_rgb(0,0,0,0.2)] shrink-0 text-primary hover:bg-primary/5 active:scale-[0.97] transition-[transform,color,background-color,border-color] duration-150"
              onClick={() => setScannerOpen(true)}
            >
              <Barcode className="w-5 h-5 md:w-6 md:h-6" />
            </Button>
          )}

          {/* Mobile View Toggle */}
          <button
            type="button"
            onClick={cycleViewMode}
            aria-label={t('pos.changeView') || 'Toggle view mode'}
            className="flex items-center justify-center h-12 w-12 md:h-14 md:w-14 rounded-full bg-card border border-border/50 shadow-[0_4px_20px_rgb(0,0,0,0.03)] dark:shadow-[0_4px_20px_rgb(0,0,0,0.2)] shrink-0 text-foreground hover:bg-accent/10 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-[transform,color,background-color,border-color] duration-150"
          >
            {viewMode === 'grid' && <LayoutGrid className="w-5 h-5" />}
            {viewMode === 'dense' && <Grid3x3 className="w-5 h-5" />}
            {viewMode === 'list' && <List className="w-5 h-5" />}
            {viewMode === 'compact' && <AlignJustify className="w-5 h-5" />}
          </button>
        </div>

        {/* Categories Horizontal Scroll */}
        <div data-tour="categories" className="flex gap-2 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [touch-action:pan-x] pb-1">
          {categories.map((category, index) => (
            <button
              key={category + index}
              type="button"
              onClick={() => onCategoryChange(category)}
              className={cn(
                "category-pill min-h-11 md:min-h-10 px-4 py-2 rounded-full text-xs md:text-sm font-bold whitespace-nowrap transition-[transform,color,background-color,border-color,box-shadow] duration-150 flex-shrink-0 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selectedCategory === category
                  ? "active bg-primary text-primary-foreground shadow-md scale-105 ring-2 ring-primary/20"
                  : "bg-card text-muted-foreground hover:text-foreground hover:bg-muted/80 shadow-sm border border-border/60"
              )}
            >
              {category}
            </button>
          ))}
        </div>
      </div>

      {/* Grid Content */}
      <div ref={catalogScrollRef} className="flex-1 p-3 pt-0 md:p-5 overflow-y-auto pb-32">
        {viewMode === 'grid' && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5 sm:gap-3">
            {visibleProducts.map(product => (
              <button
                key={product.id}
                type="button"
                {...pressHandlers(product)}
                className="pos-item text-start fade-in group bg-card hover:bg-card/90 rounded-2xl overflow-hidden shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-[transform,box-shadow,background-color] duration-200 border border-border/60 flex flex-col focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="w-full aspect-square bg-muted/20 relative overflow-hidden shrink-0 flex items-center justify-center">
                  <ProductImage
                    imageUrl={product.image}
                    alt={product.name}
                    className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-500 ease-out"
                    iconClassName="w-7 h-7 text-muted-foreground/30"
                  />
                </div>

                {/* جسم البطاقة المستغل للمساحة بالكامل لاسم المنتج والسعر */}
                <div className="p-2 flex flex-col justify-between flex-1 gap-2 w-full">
                  <h3 className="font-bold text-foreground text-sm leading-snug w-full text-start break-words line-clamp-2 min-h-[2.5rem]" title={product.name}>
                    {product.name}
                  </h3>

                  <div className="w-full pt-1.5 border-t border-border/30 mt-auto flex items-center justify-between gap-1.5">
                    {renderDisplayPrice(product.price, 'text-sm')}
                    <span className="inline-flex h-7 min-w-[2.25rem] shrink-0 items-center justify-center rounded-lg border border-primary bg-primary px-1.5 text-[0.875rem] font-black leading-none tabular-nums text-primary-foreground shadow-sm">
                      <span dir="ltr" className="inline-block tabular-nums">{product.quantity}</span> <span className="hidden sm:inline ms-0.5">{t('pos.piece') || 'قطعة'}</span>
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Dense View - 3 items side-by-side on mobile, 4-7 on desktop */}
        {viewMode === 'dense' && (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-1.5 sm:gap-2">
            {visibleProducts.map(product => (
              <button
                key={product.id}
                type="button"
                {...pressHandlers(product)}
                className="pos-item text-start fade-in group bg-card rounded-xl p-1.5 sm:p-2 shadow-xs hover:shadow-sm border border-border/50 flex flex-col justify-between transition-[transform,box-shadow,border-color] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {/* صورة المنتج بنسبة 4:3 مع شارة كمية عائمة في الزاوية العلوية */}
                <div className="w-full aspect-[4/3] bg-muted/20 rounded-lg overflow-hidden mb-1 sm:mb-1.5 relative flex items-center justify-center shrink-0">
                  <ProductImage
                    imageUrl={product.image}
                    alt={product.name}
                    className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-200"
                    iconClassName="w-4 h-4 sm:w-5 sm:h-5 text-muted-foreground/30"
                  />
                  {/* شارة الكمية العائمة - تحرر 100% من عرض السعر السفلي */}
                  <span dir="ltr" className="absolute top-1 end-1 z-10 inline-flex h-4 min-w-[1.25rem] px-1 items-center justify-center rounded-md bg-background/95 dark:bg-card/95 border border-border/60 text-[10px] font-black leading-none tabular-nums text-foreground shadow-xs">
                    {product.quantity}
                  </span>
                </div>

                {/* جسم البطاقة: سطرين للاسم وقاعدة مخصصة بالكامل للسعر */}
                <div className="flex flex-col justify-between flex-1 w-full gap-1">
                  <h4 className="font-bold text-[10px] sm:text-[11px] text-foreground leading-tight line-clamp-2 min-h-[1.75rem] w-full text-start break-words" title={product.name}>
                    {product.name}
                  </h4>
                  <div className="w-full pt-1 border-t border-border/30 mt-auto flex items-center justify-start">
                    {renderDisplayPrice(product.price, 'text-[11px] sm:text-xs font-black')}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* List View */}
        {viewMode === 'list' && (
          <div className="flex flex-col gap-3">
            {visibleProducts.map(product => (
              <button
                key={product.id}
                type="button"
                {...pressHandlers(product)}
                className="pos-item text-start fade-in group flex items-center bg-card rounded-[20px] p-2 shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition-[transform,box-shadow,border-color] duration-200 border border-border/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="w-20 h-20 md:w-24 md:h-24 rounded-2xl bg-muted/40 flex-shrink-0 overflow-hidden relative">
                  <ProductImage
                    imageUrl={product.image}
                    alt={product.name}
                    className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700 ease-out"
                  />
                </div>
                <div className="flex-1 min-w-0 px-4">
                  <h3 className="font-bold text-sm md:text-base text-foreground line-clamp-1 mb-1 truncate" title={product.name}>{product.name}</h3>
                  <div className="text-muted-foreground text-xs font-medium mb-1">
                    <DualUnitDisplayCompact
                      totalPieces={product.quantity}
                      conversionFactor={product.conversionFactor || 1}
                      bulkUnit={product.bulkUnit}
                      smallUnit={product.smallUnit}
                    />
                  </div>
                  {renderDisplayPrice(product.price, 'text-sm md:text-base')}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Compact View */}
        {viewMode === 'compact' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
            {visibleProducts.map(product => (
              <button
                key={product.id}
                type="button"
                {...pressHandlers(product)}
                className="pos-item text-start fade-in group flex items-center justify-between min-h-11 bg-card rounded-xl p-3 shadow-sm hover:shadow-md transition-[box-shadow,border-color] duration-200 border border-border/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex-1 min-w-0 pe-2 overflow-hidden text-start">
                  <h3 className="font-bold text-xs text-foreground truncate" title={product.name}>{product.name}</h3>
                  {renderDisplayPrice(product.price, 'text-xs mt-0.5')}
                </div>
                <div className="text-xs bg-muted/50 rounded-lg px-2 py-1 shrink-0 font-medium">
                  <DualUnitDisplayCompact
                    totalPieces={product.quantity}
                    conversionFactor={product.conversionFactor || 1}
                    bulkUnit={product.bulkUnit}
                    smallUnit={product.smallUnit}
                  />
                </div>
              </button>
            ))}
          </div>
        )}

        {lastPage > 0 && (
          <nav aria-label={isRTL ? 'صفحات المنتجات' : 'Product pages'} className="flex items-center justify-center gap-3 py-4">
            <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
              {isRTL ? 'السابق' : 'Previous'}
            </Button>
            <span dir="ltr" className="text-sm tabular-nums">{currentPage + 1} / {lastPage + 1}</span>
            <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>
              {isRTL ? 'التالي' : 'Next'}
            </Button>
          </nav>
        )}

        {filteredProducts.length === 0 && isLoading && (
          <div
            className={viewMode === 'dense'
              ? 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-1.5 sm:gap-2'
              : 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5 sm:gap-3'}
            aria-hidden="true"
          >
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="rounded-2xl bg-card border border-border/60 p-2">
                <div className="aspect-square rounded-xl bg-muted/60" />
                <div className="mt-2 h-3 rounded bg-muted/60" />
                <div className="mt-1.5 h-3 w-1/2 rounded bg-muted/40" />
              </div>
            ))}
          </div>
        )}

        {filteredProducts.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20 text-muted-foreground fade-in">
            <Package className="w-12 h-12 mb-3 text-muted-foreground/50" />
            <p className="font-semibold text-sm sm:text-base text-foreground">{t('common.all')}</p>
          </div>
        )}
      </div>

      
      {scannerOpen && (
        <BarcodeScanner
          isOpen={scannerOpen}
          onScan={handleBarcodeScan}
          onClose={() => setScannerOpen(false)}
        />
      )}
      
      {selectedProduct && (
        <ProductDetailsDialog
          product={selectedProduct}
          isOpen={detailsDialogOpen}
          onClose={() => {
            setDetailsDialogOpen(false);
            setSelectedProduct(null);
          }}
          onAddToCart={(product, qty) => {
            if (onAddToCart) {
              onAddToCart(product, qty);
            } else {
              onProductClick(product, qty);
            }
          }}
        />
      )}
    </div>
  );
});
