import { cn } from '@/lib/utils';
import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Coins, DollarSign, Percent, Check, Wallet } from 'lucide-react';
import { toast } from '@/lib/sonner-bridge';
import { useLanguage } from '@/hooks/use-language';
import { PREDEFINED_CURRENCIES, CURRENCY_CATEGORIES } from '@/lib/currencies';
import type { CurrencyDisplayMode } from '@/lib/store-settings-sync';

export interface FinanceSettingsSectionProps {
  primaryCurrency: string;
  setPrimaryCurrency: (curr: string) => void;
  enabledCurrencies: Record<string, boolean | undefined>;
  setEnabledCurrencies: React.Dispatch<React.SetStateAction<any>>;
  exchangeRates: Record<string, number | undefined>;
  setExchangeRates: React.Dispatch<React.SetStateAction<any>>;
  currencyNames: Record<string, string | undefined>;
  setCurrencyNames: React.Dispatch<React.SetStateAction<any>>;
  currencySymbols: Record<string, string | undefined>;
  setCurrencySymbols: React.Dispatch<React.SetStateAction<any>>;
  currencyDisplayMode: Record<string, CurrencyDisplayMode>;
  setCurrencyDisplayMode: React.Dispatch<React.SetStateAction<any>>;
  taxEnabled: boolean;
  setTaxEnabled: (enabled: boolean) => void;
  taxRate: number;
  setTaxRate: (rate: number) => void;
  discountPercentEnabled: boolean;
  setDiscountPercentEnabled: (enabled: boolean) => void;
  discountFixedEnabled: boolean;
  setDiscountFixedEnabled: (enabled: boolean) => void;
  trackCapital: boolean;
  setTrackCapital: (track: boolean) => void;
  initialCapital: number;
  setInitialCapital: (cap: number) => void;
  slot1Code: string;
  setSlot1Code: (code: string) => void;
  slot2Code: string;
  setSlot2Code: (code: string) => void;
  toggleCurrency: (code: string, enabled: boolean) => void;
  renderCurrencyDisplayOptions: (code: string) => React.ReactNode;
  sanitizeNumberText?: (val: string) => string;
}

export function FinanceSettingsSection({
  primaryCurrency,
  setPrimaryCurrency,
  enabledCurrencies,
  setEnabledCurrencies,
  exchangeRates,
  setExchangeRates,
  currencyNames,
  setCurrencyNames,
  currencySymbols,
  setCurrencySymbols,
  currencyDisplayMode,
  setCurrencyDisplayMode,
  taxEnabled,
  setTaxEnabled,
  taxRate,
  setTaxRate,
  discountPercentEnabled,
  setDiscountPercentEnabled,
  discountFixedEnabled,
  setDiscountFixedEnabled,
  trackCapital,
  setTrackCapital,
  initialCapital,
  setInitialCapital,
  slot1Code,
  setSlot1Code,
  slot2Code,
  setSlot2Code,
  toggleCurrency,
  renderCurrencyDisplayOptions,
  sanitizeNumberText = (val: string) => {
    if (!val) return '';
    let normalized = val.replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660));
    normalized = normalized.replace(/[\u06f0-\u06f9]/g, d => String(d.charCodeAt(0) - 0x06f0));
    normalized = normalized.replace(/[,\u060c\u066b]/g, '.');
    normalized = normalized.replace(/[^\d.]/g, '');
    const parts = normalized.split('.');
    return parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : normalized;
  },
}: FinanceSettingsSectionProps) {
  const { t, isRTL } = useLanguage();

  return (
    <div className="space-y-4">
                {/* قسم العملة وأسعار الصرف */}
                <div className="space-y-4 rounded-xl border border-border/80 bg-card/60 p-4 md:p-6 shadow-sm">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border/40 pb-3">
                    <div>
                      <h3 className="text-base font-bold text-foreground flex items-center gap-2">
                        <Coins className="w-5 h-5 text-primary" />
                        {t('settings.exchangeRates')} والعملة الافتراضية
                      </h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        اختر العملة الرئيسية التي ستظهر بها أسعار البيع والشراء وسلة الكاشير افتراضياً
                      </p>
                    </div>
                    <Badge variant="outline" className="w-fit text-xs px-2.5 py-1 font-semibold border-primary/30 text-primary bg-primary/10">
                      العملة النشطة حالياً: {primaryCurrency}
                    </Badge>
                  </div>

                  {/* بطاقات العملات الثلاث باختيار راديو ومفاتيح التفعيل */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 pt-2">
                    
                    {/* 1. الدولار الأمريكي USD */}
                    <div
                      onClick={() => {
                        if (enabledCurrencies.USD !== false) {
                          setPrimaryCurrency('USD');
                        } else {
                          toast({ title: 'العملة معطلة', description: 'يجب تفعيل عرض الدولار الأمريكي أولاً لاختياره كعملة افتراضية' });
                        }
                      }}
                      className={cn(
                        "relative flex flex-col justify-between p-4 rounded-xl border-2 transition-colors cursor-pointer",
                        enabledCurrencies.USD === false && "opacity-60 border-dashed border-border/60 bg-muted/10",
                        primaryCurrency === 'USD'
                          ? "border-primary bg-primary/5 shadow-md shadow-primary/5 ring-1 ring-primary/20"
                          : "border-border/60 hover:border-primary/40 bg-card hover:bg-muted/20"
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2.5">
                          <div className={cn(
                            "w-9 h-9 rounded-lg flex items-center justify-center font-black text-base",
                            primaryCurrency === 'USD' ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                          )}>
                            $
                          </div>
                          <div>
                            <h4 className="font-bold text-sm text-foreground">الدولار الأمريكي</h4>
                            <span className="text-[11px] text-muted-foreground font-mono">USD</span>
                          </div>
                        </div>
                        <div className={cn(
                          "w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors",
                          primaryCurrency === 'USD' ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
                        )}>
                          {primaryCurrency === 'USD' && <Check className="w-3 h-3 stroke-[3]" />}
                        </div>
                      </div>

                      <div className="mt-4 pt-3 border-t border-border/40 space-y-2">
                        <div className="flex items-center justify-between">
                          <Badge variant="secondary" className="text-[10px] font-medium bg-muted/60 text-muted-foreground">
                            مرجع محاسبي (1.00 $)
                          </Badge>
                          <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                            <span className="text-xs font-medium text-foreground">عرض في الواجهة:</span>
                            <Switch
                              checked={enabledCurrencies.USD !== false}
                              onCheckedChange={(val) => toggleCurrency('USD', val)}
                            />
                          </div>
                        </div>
                        <p className="text-[10px] text-muted-foreground/80 leading-relaxed">
                          يبقى الدولار المرجع المحاسبي في قاعدة البيانات حتى عند إخفائه من نقاط البيع والفواتير.
                        </p>
                        {renderCurrencyDisplayOptions('USD')}
                      </div>
                    </div>

                    {/* 2. العملة الإضافية 1 (Slot 1) */}
                    <div
                      onClick={() => {
                        if (enabledCurrencies[slot1Code]) {
                          setPrimaryCurrency(slot1Code);
                        } else {
                          toast({ title: isRTL ? 'العملة معطلة' : 'Currency Disabled', description: isRTL ? 'يجب تفعيل هذه العملة أولاً لاختيارها كعملة افتراضية' : 'Must enable this currency first' });
                        }
                      }}
                      className={cn(
                        "relative flex flex-col justify-between p-4 rounded-xl border-2 transition-colors cursor-pointer",
                        !enabledCurrencies[slot1Code] && "opacity-60 border-dashed border-border/60 bg-muted/10",
                        primaryCurrency === slot1Code
                          ? "border-primary bg-primary/5 shadow-md shadow-primary/5 ring-1 ring-primary/20"
                          : "border-border/60 hover:border-primary/40 bg-card hover:bg-muted/20"
                      )}
                    >
                      <div>
                        {/* Header: Icon + Predefined Dropdown + Radio */}
                        <div className="flex items-start justify-between gap-2">
                          <div className={cn(
                            "w-10 h-10 rounded-xl flex items-center justify-center font-black text-sm shrink-0 shadow-xs",
                            primaryCurrency === slot1Code ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                          )}>
                            {currencySymbols[slot1Code] || PREDEFINED_CURRENCIES.find(c => c.code === slot1Code)?.symbol || slot1Code}
                          </div>

                          <div className="flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
                            <label className="text-[10px] font-bold text-muted-foreground block mb-1">
                              {isRTL ? 'قائمة العملات الجاهزة (27 عملة):' : 'Predefined currencies (27):'}
                            </label>
                            <select
                              value={PREDEFINED_CURRENCIES.find(c => c.code === slot1Code)?.code || ''}
                              onChange={(e) => {
                                const selected = PREDEFINED_CURRENCIES.find(c => c.code === e.target.value);
                                if (selected) {
                                  const nextCode = selected.code;
                                  const oldCode = slot1Code; // حفظ الكود القديم
                                  setSlot1Code(nextCode);
                                  setCurrencySymbols(prev => ({ ...prev, [nextCode]: selected.symbol }));
                                  setCurrencyNames(prev => ({ ...prev, [nextCode]: isRTL ? selected.name : selected.nameEn }));
                                  if (selected.suggestedRate) {
                                    setExchangeRates(prev => ({ ...prev, [nextCode]: String(selected.suggestedRate) }));
                                  }
                                  // تنظيف الكود القديم وتفعيل الكود الجديد فقط
                                  setEnabledCurrencies(prev => {
                                    const next = { ...prev };
                                    if (oldCode && oldCode !== nextCode && oldCode !== slot2Code && oldCode !== 'USD') {
                                      delete next[oldCode];
                                    }
                                    next[nextCode] = true;
                                    return next;
                                  });
                                  if (primaryCurrency === slot1Code) {
                                    setPrimaryCurrency(nextCode);
                                  }
                                }
                              }}
                              className="w-full h-8 px-2 rounded-lg bg-background border border-border/80 text-foreground text-xs font-semibold focus:ring-1 focus:ring-primary focus:outline-hidden"
                            >
                              <option value="" disabled>{isRTL ? 'اختر عملة لتعبئة البيانات تلقائياً...' : 'Choose predefined...'}</option>
                              {CURRENCY_CATEGORIES.map(category => (
                                <optgroup key={category.id} label={isRTL ? category.label : category.labelEn}>
                                  {PREDEFINED_CURRENCIES.filter(c => c.category === category.id).map(c => (
                                    <option key={c.code} value={c.code}>
                                      {c.code} - {isRTL ? c.name : c.nameEn} ({c.symbol})
                                    </option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                          </div>

                          <div className={cn(
                            "w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors shrink-0 mt-1",
                            primaryCurrency === slot1Code ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
                          )}>
                            {primaryCurrency === slot1Code && <Check className="w-3 h-3 stroke-[3]" />}
                          </div>
                        </div>

                        {/* Custom Name & Symbol Inputs */}
                        <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-border/40" onClick={(e) => e.stopPropagation()}>
                          <div>
                            <span className="text-[10px] text-muted-foreground font-semibold block mb-1">
                              {isRTL ? 'اسم العملة:' : 'Name:'}
                            </span>
                            <Input
                              value={currencyNames[slot1Code] || ''}
                              onChange={(e) => setCurrencyNames({ ...currencyNames, [slot1Code]: e.target.value })}
                              className="h-7 text-xs font-bold px-2 bg-background/80"
                              placeholder={isRTL ? "مثال: ريال قطري" : "e.g. Qatari Riyal"}
                            />
                          </div>
                          <div>
                            <span className="text-[10px] text-muted-foreground font-semibold block mb-1">
                              {isRTL ? 'رمز العملة:' : 'Symbol:'}
                            </span>
                            <Input
                              value={currencySymbols[slot1Code] || ''}
                              onChange={(e) => setCurrencySymbols({ ...currencySymbols, [slot1Code]: e.target.value })}
                              className="h-7 text-xs font-bold px-2 bg-background/80 font-mono"
                              placeholder={isRTL ? "مثال: QAR أو TRY" : "e.g. QAR or TRY"}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Exchange Rate & Toggle Switch */}
                      <div className="mt-3 pt-3 border-t border-border/40 space-y-2.5">
                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          <span className="text-xs text-muted-foreground whitespace-nowrap">{isRTL ? 'سعر الصرف ($1 =):' : 'Exchange Rate ($1 =):'}</span>
                          <Input
                            type="text"
                            inputMode="decimal"
                            value={exchangeRates[slot1Code] ?? ''}
                            onChange={(e) => setExchangeRates({ ...exchangeRates, [slot1Code]: sanitizeNumberText(e.target.value) })}
                            className="h-7 text-xs font-mono font-bold px-2 bg-background/80"
                            placeholder="3.64"
                          />
                        </div>
                        {renderCurrencyDisplayOptions(slot1Code)}
                        <div className="flex items-center justify-between pt-1 border-t border-border/30" onClick={(e) => e.stopPropagation()}>
                          <span className="text-xs font-medium text-foreground">{isRTL ? 'تفعيل العملة:' : 'Enable Currency:'}</span>
                          <Switch
                            checked={enabledCurrencies[slot1Code] === true}
                            onCheckedChange={(val) => toggleCurrency(slot1Code, val)}
                          />
                        </div>
                      </div>
                    </div>

                    {/* 3. العملة الإضافية 2 (Slot 2) */}
                    <div
                      onClick={() => {
                        if (enabledCurrencies[slot2Code]) {
                          setPrimaryCurrency(slot2Code);
                        } else {
                          toast({ title: isRTL ? 'العملة معطلة' : 'Currency Disabled', description: isRTL ? 'يجب تفعيل هذه العملة أولاً لاختيارها كعملة افتراضية' : 'Must enable this currency first' });
                        }
                      }}
                      className={cn(
                        "relative flex flex-col justify-between p-4 rounded-xl border-2 transition-colors cursor-pointer",
                        !enabledCurrencies[slot2Code] && "opacity-60 border-dashed border-border/60 bg-muted/10",
                        primaryCurrency === slot2Code
                          ? "border-primary bg-primary/5 shadow-md shadow-primary/5 ring-1 ring-primary/20"
                          : "border-border/60 hover:border-primary/40 bg-card hover:bg-muted/20"
                      )}
                    >
                      <div>
                        {/* Header: Icon + Predefined Dropdown + Radio */}
                        <div className="flex items-start justify-between gap-2">
                          <div className={cn(
                            "w-10 h-10 rounded-xl flex items-center justify-center font-black text-sm shrink-0 shadow-xs",
                            primaryCurrency === slot2Code ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                          )}>
                            {currencySymbols[slot2Code] || PREDEFINED_CURRENCIES.find(c => c.code === slot2Code)?.symbol || slot2Code}
                          </div>

                          <div className="flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
                            <label className="text-[10px] font-bold text-muted-foreground block mb-1">
                              {isRTL ? 'قائمة العملات الجاهزة (27 عملة):' : 'Predefined currencies (27):'}
                            </label>
                            <select
                              value={PREDEFINED_CURRENCIES.find(c => c.code === slot2Code)?.code || ''}
                              onChange={(e) => {
                                const selected = PREDEFINED_CURRENCIES.find(c => c.code === e.target.value);
                                if (selected) {
                                  const nextCode = selected.code;
                                  const oldCode = slot2Code; // حفظ الكود القديم
                                  setSlot2Code(nextCode);
                                  setCurrencySymbols(prev => ({ ...prev, [nextCode]: selected.symbol }));
                                  setCurrencyNames(prev => ({ ...prev, [nextCode]: isRTL ? selected.name : selected.nameEn }));
                                  if (selected.suggestedRate) {
                                    setExchangeRates(prev => ({ ...prev, [nextCode]: String(selected.suggestedRate) }));
                                  }
                                  // تنظيف الكود القديم وتفعيل الكود الجديد فقط
                                  setEnabledCurrencies(prev => {
                                    const next = { ...prev };
                                    if (oldCode && oldCode !== nextCode && oldCode !== slot1Code && oldCode !== 'USD') {
                                      delete next[oldCode];
                                    }
                                    next[nextCode] = true;
                                    return next;
                                  });
                                  if (primaryCurrency === slot2Code) {
                                    setPrimaryCurrency(nextCode);
                                  }
                                }
                              }}
                              className="w-full h-8 px-2 rounded-lg bg-background border border-border/80 text-foreground text-xs font-semibold focus:ring-1 focus:ring-primary focus:outline-hidden"
                            >
                              <option value="" disabled>{isRTL ? 'اختر عملة لتعبئة البيانات تلقائياً...' : 'Choose predefined...'}</option>
                              {CURRENCY_CATEGORIES.map(category => (
                                <optgroup key={category.id} label={isRTL ? category.label : category.labelEn}>
                                  {PREDEFINED_CURRENCIES.filter(c => c.category === category.id).map(c => (
                                    <option key={c.code} value={c.code}>
                                      {c.code} - {isRTL ? c.name : c.nameEn} ({c.symbol})
                                    </option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                          </div>

                          <div className={cn(
                            "w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors shrink-0 mt-1",
                            primaryCurrency === slot2Code ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
                          )}>
                            {primaryCurrency === slot2Code && <Check className="w-3 h-3 stroke-[3]" />}
                          </div>
                        </div>

                        {/* Custom Name & Symbol Inputs */}
                        <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-border/40" onClick={(e) => e.stopPropagation()}>
                          <div>
                            <span className="text-[10px] text-muted-foreground font-semibold block mb-1">
                              {isRTL ? 'اسم العملة:' : 'Name:'}
                            </span>
                            <Input
                              value={currencyNames[slot2Code] || ''}
                              onChange={(e) => setCurrencyNames({ ...currencyNames, [slot2Code]: e.target.value })}
                              className="h-7 text-xs font-bold px-2 bg-background/80"
                              placeholder={isRTL ? "مثال: جنيه مصري" : "e.g. Egyptian Pound"}
                            />
                          </div>
                          <div>
                            <span className="text-[10px] text-muted-foreground font-semibold block mb-1">
                              {isRTL ? 'رمز العملة:' : 'Symbol:'}
                            </span>
                            <Input
                              value={currencySymbols[slot2Code] || ''}
                              onChange={(e) => setCurrencySymbols({ ...currencySymbols, [slot2Code]: e.target.value })}
                              className="h-7 text-xs font-bold px-2 bg-background/80 font-mono"
                              placeholder={isRTL ? "مثال: EGP أو IQD" : "e.g. EGP or IQD"}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Exchange Rate & Toggle Switch */}
                      <div className="mt-3 pt-3 border-t border-border/40 space-y-2.5">
                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          <span className="text-xs text-muted-foreground whitespace-nowrap">{isRTL ? 'سعر الصرف ($1 =):' : 'Exchange Rate ($1 =):'}</span>
                          <Input
                            type="text"
                            inputMode="decimal"
                            value={exchangeRates[slot2Code] ?? ''}
                            onChange={(e) => setExchangeRates({ ...exchangeRates, [slot2Code]: sanitizeNumberText(e.target.value) })}
                            className="h-7 text-xs font-mono font-bold px-2 bg-background/80"
                            placeholder="48"
                          />
                        </div>
                        {renderCurrencyDisplayOptions(slot2Code)}
                        <div className="flex items-center justify-between pt-1 border-t border-border/30" onClick={(e) => e.stopPropagation()}>
                          <span className="text-xs font-medium text-foreground">{isRTL ? 'تفعيل العملة:' : 'Enable Currency:'}</span>
                          <Switch
                            checked={enabledCurrencies[slot2Code] === true}
                            onCheckedChange={(val) => toggleCurrency(slot2Code, val)}
                          />
                        </div>
                      </div>
                    </div>

                  </div>
                </div>

                {/* Tax Settings */}
                <div className="pt-2 border-t border-border space-y-3">
                  <h3 className="text-base font-semibold text-foreground">{t('settings.tax') || 'الضريبة'}</h3>
                  <div className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-2">
                      <Percent className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{t('settings.enableTax') || 'تفعيل الضريبة'}</span>
                    </div>
                    <Switch
                      checked={taxEnabled}
                      onCheckedChange={(checked) => {
                        setTaxEnabled(checked);
                      }}
                    />
                  </div>
                  {taxEnabled && (
                    <div className="flex items-center gap-2">
                      <label className="text-sm font-medium text-foreground w-24 shrink-0">{t('settings.taxRate') || 'نسبة الضريبة'}</label>
                      <div className="relative flex-1">
                        <Percent className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input
                          type="number"
                          value={taxRate || ''}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            setTaxRate(val);
                          }}
                          className="pr-10 bg-muted border-0 h-9 text-sm"
                          placeholder="15"
                          min="0"
                          max="100"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Discount Control Settings */}
                <div className="pt-2 border-t border-border space-y-3">
                  <h3 className="text-base font-semibold text-foreground">{t('settings.discountControl') || 'التحكم بالخصومات'}</h3>
                  <div className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-2">
                      <Percent className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{t('settings.enablePercentDiscount') || 'خصم النسبة المئوية'}</span>
                    </div>
                    <Switch
                      checked={discountPercentEnabled}
                      onCheckedChange={(checked) => {
                        setDiscountPercentEnabled(checked);
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-2">
                      <DollarSign className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{t('settings.enableFixedDiscount') || 'خصم المبلغ الثابت'}</span>
                    </div>
                    <Switch
                      checked={discountFixedEnabled}
                      onCheckedChange={(checked) => {
                        setDiscountFixedEnabled(checked);
                      }}
                    />
                  </div>
                </div>

                {/* Capital & Liquidity Tracking Section */}
                <div className="pt-2 border-t border-border space-y-3">
                  <div className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-2">
                      <Wallet className="w-4 h-4 text-primary" />
                      <div>
                        <span className="text-sm font-medium block">
                          {isRTL ? 'تتبع رأس المال والسيولة' : 'Track Capital & Liquidity'}
                        </span>
                        <span className="text-xs text-muted-foreground block">
                          {isRTL 
                            ? (trackCapital ? 'وضع تتبع رأس المال التأسيسي وحركة السيولة النقدية' : 'وضع بدون رأس مال (تدفق نقدي بسيط)') 
                            : (trackCapital ? 'Track initial capital and liquid cash movement' : 'Simple cash flow mode')}
                        </span>
                      </div>
                    </div>
                    <Switch
                      checked={trackCapital}
                      onCheckedChange={(checked) => {
                        setTrackCapital(checked);
                      }}
                    />
                  </div>
                  {trackCapital && (
                    <div className="space-y-1 bg-muted/40 p-3 rounded-xl border border-border/60">
                      <label className="text-sm font-medium text-foreground block">
                        {isRTL ? 'رأس المال التأسيسي للمحل ($)' : 'Initial Store Capital ($)'}
                      </label>
                      <div className="relative">
                        <DollarSign className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input
                          type="number"
                          value={initialCapital || ''}
                          onChange={(e) => {
                            const val = e.target.value === '' ? 0 : Math.max(0, Number(e.target.value));
                            setInitialCapital(val);
                          }}
                          className="pr-10 bg-background border-border/80 h-9 text-sm"
                          placeholder="0.00"
                          min="0"
                          step="any"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {isRTL 
                          ? 'يُضاف هذا المبلغ تلقائياً إلى رؤوس أموال الشركاء إن وجدوا لاحتساب إجمالي رأس المال والسيولة المتاحة.'
                          : 'This amount is combined with partners capital (if any) to calculate total capital and available liquidity.'}
                      </p>
                    </div>
                  )}
                </div>

                {/* نص توضيحي للعملات والضرائب */}
                <div className="pt-3 border-t border-border">
                  <p className="text-xs text-muted-foreground text-start">
                    {isRTL ? 'تُطبق أسعار الصرف ونسب الضريبة والخصومات فوراً في الكاشير' : 'Rates and discounts apply immediately to POS'}
                  </p>
                </div>

    </div>
  );
}

export default FinanceSettingsSection;
