import { Package, Plus, X, BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLanguage } from '@/hooks/use-language';
import { getLocalizedUnit } from '@/lib/product-units';
import { getCurrentStoreType } from '@/lib/store-type-config';

// POS Product type matching the one used in POS.tsx (not from localStorage)
interface POSProduct {
  id: string;
  name: string;
  price: number;
  category?: string;
  quantity: number;
  image?: string;
  barcode?: string;
  bulkUnit?: string;
  smallUnit?: string;
  conversionFactor?: number;
  bulkSalePrice?: number;
  costPrice?: number;
  bulkCostPrice?: number;
}

interface ScannedProductDialogProps {
  isOpen: boolean;
  onClose: () => void;
  product: POSProduct | null;
  onAddToCart: (product: POSProduct) => void;
  onLoan?: (product: POSProduct) => void;
}

export function ScannedProductDialog({
  isOpen,
  onClose,
  product,
  onAddToCart,
  onLoan,
}: ScannedProductDialogProps) {
  const { t, language } = useLanguage();
  const isBookstore = getCurrentStoreType() === 'bookstore';
  
  if (!product) return null;

  const handleAdd = () => {
    onAddToCart(product);
    onClose();
  };

  const handleLoan = () => {
    if (onLoan) {
      onLoan(product);
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="w-[min(calc(100vw-1.5rem),28rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px] bg-background border-border/50 shadow-2xl">
        <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 bg-muted/30 text-start pe-12">
          <DialogTitle className="flex items-center gap-2">
            <Package className="w-5 h-5 text-primary shrink-0" />
            {t('scannedProduct.productFound')}
          </DialogTitle>
        </DialogHeader>
        
        <DialogBody className="py-4 space-y-4">
          <div className="flex items-center gap-4">
            <div className="w-24 h-24 rounded-2xl bg-muted/50 border border-border/40 shadow-sm flex items-center justify-center flex-shrink-0">
              {product.image ? (
                <img 
                  src={product.image} 
                  alt={product.name} 
                  loading="lazy"
                  decoding="async"
                  className="w-full h-full object-cover rounded-xl"
                />
              ) : (
                <Package className="w-10 h-10 text-muted-foreground" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-lg text-foreground mb-1 line-clamp-2 break-words" title={product.name}>{product.name}</h3>
              <p className="text-sm text-muted-foreground mb-2 truncate">{product.category}</p>
              <p dir="ltr" className="inline-block text-2xl font-bold text-primary tabular-nums">${product.price}</p>
            </div>
          </div>

          <div className="bg-muted/40 border border-border/40 rounded-xl p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{t('scannedProduct.availableStock')}:</span>
              <span className="font-semibold text-foreground">
                <span dir="ltr" className="inline-block tabular-nums">{product.quantity}</span> {getLocalizedUnit(product.smallUnit, false, language)}
              </span>
            </div>
            {product.barcode && (
              <div className="flex justify-between text-sm mt-1">
                <span className="text-muted-foreground">{t('scannedProduct.barcode')}:</span>
                <span dir="ltr" className="inline-block font-mono tabular-nums text-foreground">{product.barcode}</span>
              </div>
            )}
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
          <Button variant="outline" size="default" className="flex-1" onClick={onClose}>
            <X className="w-4 h-4 shrink-0" />
            {t('scannedProduct.close')}
          </Button>
          {isBookstore && onLoan && (
            <Button
              variant="secondary"
              size="default"
              className="flex-1"
              onClick={handleLoan}
              disabled={product.quantity === 0}
            >
              <BookOpen className="w-4 h-4 shrink-0" />
              إعارة
            </Button>
          )}
          <Button 
            variant="default"
            size="default"
            className="flex-1" 
            onClick={handleAdd}
            disabled={product.quantity === 0}
          >
            <Plus className="w-4 h-4 shrink-0" />
            {t('scannedProduct.addToCart')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
