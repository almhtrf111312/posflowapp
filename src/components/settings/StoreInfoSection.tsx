import React from 'react';
import { Store, Phone, Mail, MapPin, Upload, X, Smartphone, Sparkles, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LanguageSection } from '@/components/settings/LanguageSection';
import { useLanguage } from '@/hooks/language-context';
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
  const { t } = useLanguage();

  return (
    <div>
      <h2 className="text-base sm:text-lg font-bold text-foreground tracking-tight mb-3">{t('settings.storeInfo')}</h2>

      {/* Setup Wizard Quick Launcher */}
      <div className="p-3 mb-4 rounded-xl bg-gradient-to-r from-primary/10 via-primary/5 to-transparent border border-primary/20 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <p className="text-xs font-bold text-foreground">{t('storeSettings.setupWizardTitle')}</p>
            <p className="text-[11px] text-muted-foreground">{t('storeSettings.setupWizardDesc')}</p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 text-xs rounded-lg border-primary/30 text-primary hover:bg-primary/10 shrink-0 font-bold"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('posflow:open-setup-wizard'));
          }}
        >
          {t('storeSettings.launchWizard')}
        </Button>
      </div>

      <div className="space-y-2">
        {/* Store Name */}
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-foreground w-24 shrink-0">{t('settings.storeName')}</label>
          <div className="relative flex-1 min-w-0">
            <Store className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={storeSettings.name}
              onChange={(e) => setStoreSettings({ ...storeSettings, name: e.target.value })}
              className="ps-10 bg-muted border-0"
            />
          </div>
        </div>

        {/* Store Type */}
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-foreground w-24 shrink-0">{t('settings.storeType')}</label>
          <Select
            value={storeSettings.type}
            onValueChange={(newType) => {
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
          >
            <SelectTrigger className="flex-1 min-h-11 sm:min-h-10 rounded-[14px] bg-muted border-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-[min(20rem,60dvh)] overflow-y-auto">
              <SelectItem value="phones">{t('settings.storeTypes.phones')}</SelectItem>
              <SelectItem value="grocery">{t('settings.storeTypes.grocery')}</SelectItem>
              <SelectItem value="pharmacy">{t('settings.storeTypes.pharmacy')}</SelectItem>
              <SelectItem value="clothing">{t('settings.storeTypes.clothing')}</SelectItem>
              <SelectItem value="restaurant">{t('settings.storeTypes.restaurant')}</SelectItem>
              <SelectItem value="bakery">{t('settings.storeTypes.bakery')}</SelectItem>
              <SelectItem value="repair">{t('settings.storeTypes.repair')}</SelectItem>
              <SelectItem value="bookstore">{t('settings.storeTypes.bookstore')}</SelectItem>
              <SelectItem value="general">{t('settings.storeTypes.general')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Phone */}
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-foreground w-24 shrink-0">{t('common.phone')}</label>
          <div className="relative flex-1 min-w-0">
            <Phone className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={storeSettings.phone}
              onChange={(e) => {
                const val = e.target.value.replace(/[^\d+\-\s]/g, '');
                setStoreSettings({ ...storeSettings, phone: val });
              }}
              inputMode="tel"
              dir="ltr"
              className="ps-10 bg-muted border-0 tabular-nums"
            />
          </div>
        </div>

        {/* Email */}
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-foreground w-24 shrink-0">{t('common.email')}</label>
          <div className="relative flex-1 min-w-0">
            <Mail className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={storeSettings.email}
              onChange={(e) => setStoreSettings({ ...storeSettings, email: e.target.value })}
              dir="ltr"
              className="ps-10 bg-muted border-0"
            />
          </div>
        </div>

        {/* Address */}
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-foreground w-24 shrink-0">{t('settings.address')}</label>
          <div className="relative flex-1 min-w-0">
            <MapPin className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={storeSettings.address}
              onChange={(e) => setStoreSettings({ ...storeSettings, address: e.target.value })}
              className="ps-10 bg-muted border-0"
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
              aria-label={t('common.delete')}
              className="absolute -top-2 -end-2 size-8 after:content-[''] after:absolute after:-inset-1.5"
              onClick={handleRemoveLogo}
            >
              <X className="w-3.5 h-3.5" />
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

      {/* POS Options - Maintenance Section */}
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
          <h3 className="text-base font-semibold text-foreground">{t('storeSettings.barcodeScannerBehavior')}</h3>
        </div>
        <Tabs value={barcodeScanMode} onValueChange={(value) => {
          const mode = value === 'add' ? 'add' : 'search';
          setBarcodeScanMode(mode);
        }}>
          <TabsList className="grid h-auto w-full grid-cols-2">
            <TabsTrigger value="search" className="min-h-10 whitespace-normal text-xs">
              {t('storeSettings.barcodeShowProduct')}
            </TabsTrigger>
            <TabsTrigger value="add" className="min-h-10 whitespace-normal text-xs">
              {t('storeSettings.barcodeAddDirectly')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="text-xs text-muted-foreground">
          {t('storeSettings.barcodeDirectAddDesc')}
        </p>
      </div>

      {/* Invoice & report header note */}
      <div className="pt-3 border-t border-border mt-3">
        <p className="text-xs text-muted-foreground text-start">
          {t('storeSettings.infoAppearsOnInvoices')}
        </p>
      </div>
    </div>
  );
}

export default StoreInfoSection;
