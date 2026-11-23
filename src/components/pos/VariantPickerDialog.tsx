import { Package } from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLanguage } from '@/hooks/use-language';
import { getLocalizedUnit } from '@/lib/product-units';

interface VariantProduct {
  id: string;
  name: string;
  price: number;
  category?: string;
  quantity: number;
  image?: string;
  barcode?: string;
  variantLabel?: string;
  bulkUnit?: string;
  smallUnit?: string;
  conversionFactor?: number;
  bulkSalePrice?: number;
  costPrice?: number;
  bulkCostPrice?: number;
  wholesalePrice?: number;
}

interface VariantPickerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  products: VariantProduct[];
  onSelect: (product: VariantProduct) => void;
}

export function VariantPickerDialog({
  isOpen,
  onClose,
  products,
  onSelect,
}: VariantPickerDialogProps) {
  const { t, language } = useLanguage();

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="w-[min(calc(100vw-1.5rem),28rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px] bg-background border-border/50 shadow-2xl">
        <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 bg-muted/30 text-start pe-12">
          <DialogTitle className="flex items-center gap-2">
            <Package className="w-5 h-5 text-primary shrink-0" />
            {language === 'en' ? 'Select Product Variant' : 'اختر المنتج المطلوب'}
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-2 py-4">
          {products.map((product) => (
            <button
              key={product.id}
              type="button"
              onClick={() => {
                onSelect(product);
                onClose();
              }}
              className="w-full flex items-center gap-3 p-3 rounded-xl border border-border hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors text-start"
            >
              <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                {product.image ? (
                  <img
                    src={product.image}
                    alt={product.name}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover rounded-lg"
                  />
                ) : (
                  <Package className="w-6 h-6 text-muted-foreground" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-foreground truncate" title={product.name}>{product.name}</p>
                {product.variantLabel && (
                  <p className="text-sm text-primary font-medium">({product.variantLabel})</p>
                )}
                <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                  <span dir="ltr" className="inline-block font-bold text-foreground text-sm tabular-nums">${product.price}</span>
                  <span>
                    {language === 'en' ? 'Available:' : 'متوفر:'} <span dir="ltr" className="inline-block tabular-nums">{product.quantity}</span> {getLocalizedUnit(product.smallUnit, false, language)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
