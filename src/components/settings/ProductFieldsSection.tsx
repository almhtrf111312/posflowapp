import { isLocalDataMode } from '@/hooks/use-network-status';
import { useState, useEffect } from 'react';
import { Settings2, Package, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useLanguage } from '@/hooks/language-context';
import type { TranslationKey } from '@/lib/i18n';
import {
  ProductFieldsConfig,
  loadProductFieldsConfig,
  syncProductFieldsFromCloud,
  getDefaultFieldsByStoreType,
  FIELD_LABELS,
  getLocalizedFieldLabel,
  getLocalizedFieldDescription,
  StoreType,
} from '@/lib/product-fields-config';
import { CustomFieldsManager } from './CustomFieldsManager';

interface ProductFieldsSectionProps {
  storeType: string;
  onConfigChange?: (config: ProductFieldsConfig) => void;
  pendingConfig?: ProductFieldsConfig | null;
}

export function ProductFieldsSection({ storeType, onConfigChange, pendingConfig }: ProductFieldsSectionProps) {
  const { t, language } = useLanguage();
  const [showOtherFields, setShowOtherFields] = useState(false);
  const [config, setConfig] = useState<ProductFieldsConfig>(() => {
    if (pendingConfig) return pendingConfig;
    const userConfig = loadProductFieldsConfig();
    if (userConfig) return userConfig;
    return getDefaultFieldsByStoreType(storeType as StoreType);
  });

  useEffect(() => {
    if (pendingConfig) {
      setConfig(pendingConfig);
    }
  }, [pendingConfig]);

  useEffect(() => {
    if (pendingConfig) return;
    const syncFromCloud = async () => {
      if (isLocalDataMode()) return; // الإعدادات المحلية تبقى ظاهرة بدون انتظار
      const cloudConfig = await syncProductFieldsFromCloud();
      if (cloudConfig) {
        setConfig(cloudConfig);
      } else {
        const userConfig = loadProductFieldsConfig();
        if (!userConfig) {
          setConfig(getDefaultFieldsByStoreType(storeType as StoreType));
        }
      }
    };
    syncFromCloud();
  }, [storeType, pendingConfig]);

  const handleToggle = (field: keyof ProductFieldsConfig) => {
    const newConfig = { ...config, [field]: !config[field] };
    setConfig(newConfig);
    if (onConfigChange) {
      onConfigChange(newConfig);
    }
  };

  const handleReset = () => {
    const defaults = getDefaultFieldsByStoreType(storeType as StoreType);
    setConfig(defaults);
    if (onConfigChange) {
      onConfigChange(defaults);
    }
  };

  const defaults = getDefaultFieldsByStoreType(storeType as StoreType);
  const recommendedFields = (Object.keys(FIELD_LABELS) as Array<keyof ProductFieldsConfig>)
    .filter(field => defaults[field]);
  const otherFields = (Object.keys(FIELD_LABELS) as Array<keyof ProductFieldsConfig>)
    .filter(field => !defaults[field]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2 pb-4 border-b border-border">
        <Button variant="outline" size="sm" onClick={handleReset}>
          <RotateCcw className="w-4 h-4" />
          {t('productFields.resetDefault')}
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-primary/10">
          <Package className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h3 className="font-semibold">{t('productFields.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('productFields.description')}</p>
        </div>
      </div>

      {/* الحقول الأساسية المقترحة */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <Settings2 className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="text-xs sm:text-sm text-muted-foreground">
            {t('productFields.autoNote')} ({getStoreTypeName(storeType, t)})
          </span>
        </div>

        {recommendedFields.length > 0 ? (
          <div className="space-y-2">
            {recommendedFields.map((field) => (
              <div
                key={field}
                onClick={() => handleToggle(field)}
                className="flex items-center justify-between gap-3 p-3 rounded-xl bg-muted/40 hover:bg-muted/70 border border-border/50 transition-colors cursor-pointer select-none"
              >
                <div className="flex-1 min-w-0 text-start">
                  <p className="text-sm font-semibold text-foreground">{getLocalizedFieldLabel(field, language)}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{getLocalizedFieldDescription(field, language)}</p>
                </div>
                <div className="shrink-0 ms-2" onClick={(e) => e.stopPropagation()}>
                  <Switch
                    checked={config[field]}
                    onCheckedChange={() => handleToggle(field)}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4 bg-muted/20 rounded-xl">
            {t('productFields.noDefaultFields' as TranslationKey)}
          </p>
        )}
      </div>

      {/* حقول إضافية يمكن تفعيلها */}
      {otherFields.length > 0 && (
        <div className="space-y-3 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowOtherFields(!showOtherFields)}
            className="w-full justify-between text-muted-foreground hover:text-foreground border border-dashed border-border py-4"
          >
            <span className="text-xs font-semibold">
              {showOtherFields
                ? t('productFields.hideOtherFields' as TranslationKey)
                : `${t('productFields.showOtherFields' as TranslationKey)} (${otherFields.length})`}
            </span>
            {showOtherFields ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>

          {showOtherFields && (
            <div className="space-y-2 animate-in fade-in duration-200">
              {otherFields.map((field) => (
                <div
                  key={field}
                  onClick={() => handleToggle(field)}
                  className="flex items-center justify-between gap-3 p-3 rounded-xl bg-muted/25 hover:bg-muted/50 border border-border/40 transition-colors cursor-pointer select-none"
                >
                  <div className="flex-1 min-w-0 text-start">
                    <p className="text-sm font-medium text-foreground">{getLocalizedFieldLabel(field, language)}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{getLocalizedFieldDescription(field, language)}</p>
                  </div>
                  <div className="shrink-0 ms-2" onClick={(e) => e.stopPropagation()}>
                    <Switch
                      checked={config[field]}
                      onCheckedChange={() => handleToggle(field)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Separator className="my-6" />
      <CustomFieldsManager />
    </div>
  );
}

function getStoreTypeName(type: string, t: (key: TranslationKey) => string): string {
  const names: Record<string, string> = {
    phones: t('productFields.storeType.phones'),
    grocery: t('productFields.storeType.grocery'),
    pharmacy: t('productFields.storeType.pharmacy'),
    clothing: t('productFields.storeType.clothing'),
    restaurant: t('productFields.storeType.restaurant'),
    repair: t('productFields.storeType.repair'),
    bookstore: t('productFields.storeType.bookstore'),
    bakery: t('productFields.storeType.bakery' as TranslationKey),
    general: t('productFields.storeType.general'),
    custom: t('productFields.storeType.custom'),
  };
  return names[type] || t('productFields.storeType.general');
}
