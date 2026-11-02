import React from 'react';
import { Store, Phone, Mail, MapPin, Upload, X, Smartphone, Sparkles, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LanguageSection } from '@/components/settings/LanguageSection';
import { useLanguage } from '@/hooks/use-language';
import { getDefaultFieldsByStoreType, StoreType } from '@/lib/product-fields-config';
import type { StoreInfo } from '@/lib/store-settings-sync';
import type { ProductFieldsConfig } from '@/lib/product-fields-config';

export interface StoreInfoSectionProps {
  storeSettings: StoreInfo;
  setStoreSettings: React.Dispatch<React.SetStateAction<StoreInfo>>;
  handleLogoUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleRemoveLogo: () => void;
  setProductFieldsConfig: (cfg: ProductFieldsConfig) => void;
  setProductFieldsChanged: (changed: boolean) => void;
  setPendingStoreType: (type: string) => void;
  setStoreTypeConfirmOpen: (open: boolean) => void;
  barcodeScanMode: 'search' | 'add';
  setBarcodeScanMode: (mode: 'search' | 'add') => void;
  hideMaintenanceSection: boolean;
  setHideMaintenanceSection: (hide: boolean) => void;
}

export function StoreInfoSection({
  storeSettings,
  setStoreSettings,
  handleLogoUpload,
  handleRemoveLogo,
  setProductFieldsConfig,
  setProductFieldsChanged,
  setPendingStoreType,
  setStoreTypeConfirmOpen,
  barcodeScanMode,
  setBarcodeScanMode,
  hideMaintenanceSection,
  setHideMaintenanceSection,
}: StoreInfoSectionProps) {
  const { t, isRTL } = useLanguage();

  return (
    <div>
      <h2 className="text-lg md:text-xl font-bold text-foreground mb-3">{t('settings.storeInfo')}</h2>

      {/* Setup Wizard Quick Launcher */}
      <div className="p-3 mb-4 rounded-xl bg-gradient-to-r from-primary/10 via-primary/5 to-transparent border border-primary/20 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <p className="text-xs font-bold text-foreground">معالج التهيئة والإعداد السريع</p>
            <p className="text-[11px] text-muted-foreground">تهيئة واختيار نوع المتجر والبيانات الأساسية بنقرة واحدة</p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 text-xs rounded-lg border-primary/30 text-primary hover:bg-primary/10 shrink-0 font-bold"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('hyperpos:open-setup-wizard'));
          }}
        >
          تشغيل المعالج
        </Button>
      </div>

      <div className="space-y-2">
        {/* اسم المتجر */}
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-foreground w-24 shrink-0">{t('settings.storeName')}</label>
          <div className="relative flex-1">
            <Store className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={storeSettings.name}
              onChange={(e) => setStoreSettings({ ...storeSettings, name: e.target.value })}
              className="pr-10 bg-muted border-0 h-9"
            />
          </div>
        </div>

        {/* نوع المتجر */}
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-foreground w-24 shrink-0">{t('settings.storeType')}</label>
          <select
            value={storeSettings.type}
            onChange={(e) => {
              const newType = e.target.value;
              setStoreSettings({ ...storeSettings, type: newType });
              if (newType !== 'phones' && newType !== 'repair') {
                setHideMaintenanceSection(true);
              } else {
                setHideMaintenanceSection(false);
              }
              const defaultFields = getDefaultFieldsByStoreType(newType as StoreType);
              setProductFieldsConfig(defaultFields);
              setProductFieldsChanged(true);
              setPendingStoreType(newType);
              setStoreTypeConfirmOpen(true);
            }}
            className="flex-1 h-9 px-3 rounded-md bg-muted border-0 text-foreground text-sm"
          >
            <option value="phones">{t('settings.storeTypes.phones')}</option>
            <option value="grocery">{t('settings.storeTypes.grocery')}</option>
            <option value="pharmacy">{t('settings.storeTypes.pharmacy')}</option>
            <option value="clothing">{t('settings.storeTypes.clothing')}</option>
            <option value="restaurant">{t('settings.storeTypes.restaurant')}</option>
            <option value="bakery">{t('settings.storeTypes.bakery')}</option>
            <option value="repair">{t('settings.storeTypes.repair')}</option>
            <option value="bookstore">{t('settings.storeTypes.bookstore')}</option>
            <option value="general">{t('settings.storeTypes.general')}</option>
          </select>
        </div>

        {/* الهاتف */}
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-foreground w-24 shrink-0">{t('common.phone')}</label>
          <div className="relative flex-1">
            <Phone className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={storeSettings.phone}
              onChange={(e) => {
                const val = e.target.value.replace(/[^\d+\-\s]/g, '');
                setStoreSettings({ ...storeSettings, phone: val });
              }}
              inputMode="tel"
              className="pr-10 bg-muted border-0 h-9"
            />
          </div>
        </div>

        {/* الإيميل */}
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-foreground w-24 shrink-0">{t('common.email')}</label>
          <div className="relative flex-1">
            <Mail className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={storeSettings.email}
              onChange={(e) => setStoreSettings({ ...storeSettings, email: e.target.value })}
              className="pr-10 bg-muted border-0 h-9"
            />
          </div>
        </div>

        {/* العنوان */}
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-foreground w-24 shrink-0">{t('settings.address')}</label>
          <div className="relative flex-1">
            <MapPin className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={storeSettings.address}
              onChange={(e) => setStoreSettings({ ...storeSettings, address: e.target.value })}
              className="pr-10 bg-muted border-0 h-9"
            />
          </div>
        </div>
      </div>

      {/* Logo Upload */}
      <div className="flex items-center gap-3 pt-2 border-t border-border mt-3">
        {storeSettings.logo ? (
          <div className="relative">
            <img
              src={storeSettings.logo}
              alt={t('settings.storeLogo')}
              className="w-14 h-14 rounded-lg object-cover border border-border"
            />
            <Button
              variant="destructive"
              size="icon"
              className="absolute -top-2 -left-2 h-5 w-5"
              onClick={handleRemoveLogo}
            >
              <X className="w-3 h-3" />
            </Button>
          </div>
        ) : (
          <div className="w-14 h-14 rounded-lg border-2 border-dashed border-border flex items-center justify-center">
            <Store className="w-6 h-6 text-muted-foreground" />
          </div>
        )}
        <div className="flex-1">
          <input
            type="file"
            accept="image/*"
            onChange={handleLogoUpload}
            className="hidden"
            id="logo-upload"
          />
          <label htmlFor="logo-upload">
            <Button variant="outline" size="sm" asChild>
              <span className="cursor-pointer">
                <Upload className="w-4 h-4" />
                {t('settings.uploadLogo')}
              </span>
            </Button>
          </label>
          <p className="text-xs text-muted-foreground mt-0.5">{t('settings.logoRequirements')}</p>
        </div>
      </div>

      {/* POS Options - قسم الصيانة */}
      {(storeSettings.type === 'phones' || storeSettings.type === 'repair') && (
        <div className="flex items-center justify-between py-2 border-t border-border mt-3">
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">{t('settings.hideMaintenanceSection')}</span>
          </div>
          <Switch
            checked={hideMaintenanceSection}
            onCheckedChange={(checked) => {
              setHideMaintenanceSection(checked);
            }}
          />
        </div>
      )}

      {/* Language Section */}
      <div className="border-t border-border pt-2 mt-3">
        <LanguageSection />
      </div>

      {/* Barcode behavior */}
      <div className="pt-2 border-t border-border space-y-3 mt-3">
        <div className="flex items-center gap-2">
          <Smartphone className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-base font-semibold text-foreground">{isRTL ? 'سلوك قارئ الباركود' : 'Barcode Scanner Behavior'}</h3>
        </div>
        <Tabs value={barcodeScanMode} onValueChange={(value) => {
          const mode = value === 'add' ? 'add' : 'search';
          setBarcodeScanMode(mode);
        }}>
          <TabsList className="grid h-auto w-full grid-cols-2">
            <TabsTrigger value="search" className="min-h-10 whitespace-normal text-xs">
              {isRTL ? 'عرض المنتج' : 'Show product'}
            </TabsTrigger>
            <TabsTrigger value="add" className="min-h-10 whitespace-normal text-xs">
              {isRTL ? 'إضافة للسلة مباشرة' : 'Add directly to cart'}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="text-xs text-muted-foreground">
          {isRTL ? 'في نمط الإضافة المباشرة، لن تظهر نافذة تفاصيل المنتج وستتم إضافته للسلة فوراً.' : 'In direct add mode, product details dialog is bypassed.'}
        </p>
      </div>

      {/* نص يوضح الطباعة للفاتورة */}
      <div className="pt-3 border-t border-border mt-3">
        <p className="text-xs text-muted-foreground text-start">
          {isRTL ? 'تظهر هذه المعلومات على رأس الفاتورة والتقارير' : 'This info appears on invoices and reports'}
        </p>
      </div>
    </div>
  );
}

export default StoreInfoSection;
