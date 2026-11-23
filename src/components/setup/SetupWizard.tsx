import { useState, useEffect, useRef } from 'react';
import {
  Store,
  DollarSign,
  Percent,
  Users,
  Palette,
  ArrowLeft,
  ArrowRight,
  Upload,
  X,
  Sparkles,
  Check,
  Sun,
  Moon,
  Plus,
  Trash2,
  Barcode,
  ShoppingBag,
  Smartphone,
  UtensilsCrossed,
  Wrench,
  Boxes,
  Layers,
  HelpCircle,
  TrendingUp,
  FileSpreadsheet,
  Coins,
  ShieldCheck,
  ChevronRight,
  Receipt,
  Printer,
  Camera,
  ScanLine,
  Keyboard
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn, formatNumber } from '@/lib/utils';
import { toast } from '@/lib/sonner-bridge';
import { useLanguage } from '@/hooks/use-language';
import { useTheme } from '@/hooks/use-theme';
import { Partner } from '@/lib/partners-store';
import { savePartnersCloud } from '@/lib/cloud/partners-cloud';
import { APP_FONTS, AppFontId, getStoredAppFont, setStoredAppFont } from '@/lib/app-font-config';
import { UI_SCALE_OPTIONS, UIScaleId, getStoredUIScale, setStoredUIScale } from '@/lib/ui-scale-config';
import { emitEvent, EVENTS } from '@/lib/events';
import { getDefaultFieldsByStoreType, saveProductFieldsConfig, type StoreType } from '@/lib/product-fields-config';
import { saveStoreSettings, getCurrentUserId, getCurrentUserName } from '@/lib/supabase-store';
import { PhoneInput } from '@/components/ui/phone-input';
import { claimAccountPhone } from '@/lib/auth/phone-claim';
import { isValidSignupPhone } from '@/lib/auth/google-sign-in';
import { StorePhoneVerificationDialog } from '@/components/settings/StorePhoneVerificationDialog';
import { TelegramLinkCard } from '@/components/auth/TelegramLinkCard';
import { getDefaultCategories } from '@/lib/store-type-config';
import { saveCategories, loadCategories, Category } from '@/lib/categories-store';
import { detectCurrencyCodeFromMeta, PREDEFINED_CURRENCIES, getLocalizedCurrencyName } from '@/lib/currencies';
import { toEnglishCurrencySymbol } from '@/lib/currency-symbols';
import { openShift, loadShifts, getActiveShift } from '@/lib/cashbox-store';

interface SetupWizardProps {
  onComplete: () => void;
  isPreview?: boolean;
}

interface PartnerItem {
  id: string;
  name: string;
  phone: string;
  capital: number;
  sharePercentage: number;
}

const SETTINGS_KEY = 'posflow_settings_v1';
const STORE_TYPE_KEY = 'posflow_store_type';
const TAX_KEY = 'posflow_tax_settings';

const getInitialStoredSettings = (): Record<string, any> | null => {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
};

const getInitialCurrencies = (language?: string) => {
  const settings = getInitialStoredSettings();
  const enabledMap = (settings?.enabledCurrencies || {}) as Record<string, boolean>;
  const namesMap = (settings?.currencyNames || {}) as Record<string, string>;
  const symbolsMap = (settings?.currencySymbols || {}) as Record<string, string>;
  const ratesMap = (settings?.exchangeRates || {}) as Record<string, any>;

  // 1. Identify non-USD currencies that are explicitly enabled (true)
  const activeNonUsd = Object.keys(enabledMap).filter(code => code !== 'USD' && enabledMap[code] === true);

  // 2. Identify other non-USD currencies that exist in names, symbols, or rates
  const otherConfigured = Object.keys({ ...namesMap, ...symbolsMap, ...ratesMap })
    .filter(code => code !== 'USD' && !activeNonUsd.includes(code));

  // Prioritize actively enabled currencies first, then any other configured currencies
  const candidateCodes = [...activeNonUsd, ...otherConfigured];

  // Resolve Secondary Currency 1
  const c1SourceCode = candidateCodes[0] || 'TRY';
  const c1Code = detectCurrencyCodeFromMeta(
    symbolsMap[c1SourceCode],
    namesMap[c1SourceCode],
    c1SourceCode
  );
  const c1Predefined = PREDEFINED_CURRENCIES.find(c => c.code === c1Code);
  const c1Enabled = enabledMap[c1SourceCode] === true
    || settings?.primaryCurrency === c1SourceCode
    || settings?.primaryCurrency === c1Code;
  const c1Name = namesMap[c1SourceCode] || namesMap[c1Code] || getLocalizedCurrencyName(c1Predefined || c1Code, language) || c1Code;
  const c1Symbol = toEnglishCurrencySymbol(symbolsMap[c1SourceCode] || symbolsMap[c1Code] || c1Predefined?.symbol || (c1Code === 'TRY' ? '₺' : c1Code), c1Code);
  const c1Rate = Number(ratesMap[c1SourceCode] || ratesMap[c1Code]) || c1Predefined?.suggestedRate || (c1Code === 'TRY' ? 34 : 1);

  // Resolve Secondary Currency 2
  const c2SourceCode = candidateCodes[1] || (c1SourceCode === 'SYP' ? 'TRY' : 'SYP');
  const c2Code = detectCurrencyCodeFromMeta(
    symbolsMap[c2SourceCode],
    namesMap[c2SourceCode],
    c2SourceCode
  );
  const c2Predefined = PREDEFINED_CURRENCIES.find(c => c.code === c2Code);
  const c2Enabled = enabledMap[c2SourceCode] === true
    || settings?.primaryCurrency === c2SourceCode
    || settings?.primaryCurrency === c2Code;
  const c2Name = namesMap[c2SourceCode] || namesMap[c2Code] || getLocalizedCurrencyName(c2Predefined || c2Code, language) || c2Code;
  const c2Symbol = toEnglishCurrencySymbol(symbolsMap[c2SourceCode] || symbolsMap[c2Code] || c2Predefined?.symbol || (c2Code === 'SYP' ? 'SYP' : c2Code), c2Code);
  const c2Rate = Number(ratesMap[c2SourceCode] || ratesMap[c2Code]) || c2Predefined?.suggestedRate || (c2Code === 'SYP' ? 14500 : 1);

  return {
    primaryCurrency: settings?.primaryCurrency || 'USD',
    c1: { code: c1Code, enabled: c1Enabled, name: c1Name, symbol: c1Symbol, rate: c1Rate },
    c2: { code: c2Code, enabled: c2Enabled, name: c2Name, symbol: c2Symbol, rate: c2Rate },
  };
};

export function SetupWizard({ onComplete, isPreview }: SetupWizardProps) {
  const { isRTL, direction, language } = useLanguage();
  const isEn = language === 'en';
  const { mode: storedThemeMode, setMode: setThemeMode } = useTheme();
  const [themeMode, setDraftThemeMode] = useState(storedThemeMode);

  // Check if we are in preview mode or if setup was already previously completed
  const isAlreadySetup = typeof isPreview === 'boolean'
    ? isPreview
    : (localStorage.getItem('posflow_setup_complete') === 'true' && sessionStorage.getItem('posflow_just_signed_up') !== 'true');

  const [step, setStep] = useState(1);
  const totalSteps = 6;
  const lastRequiredStep = 2;
  const [acceptedOptionalSteps, setAcceptedOptionalSteps] = useState<Set<number>>(() => new Set());
  const savingRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [visitedSteps, setVisitedSteps] = useState<Set<number>>(new Set([1]));

  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  const tabsContainerRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the active stepper button into view on mobile
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
    if (activeTabRef.current && tabsContainerRef.current) {
      activeTabRef.current.scrollIntoView({
        behavior: 'smooth',
        inline: 'center',
        block: 'nearest',
      });
    }
  }, [step]);

  // Step 1: Store info & Identity & Catalog Templates
  const [storeName, setStoreName] = useState(() => {
    const s = getInitialStoredSettings();
    return s?.storeSettings?.name || '';
  });

  const [storeType, setStoreType] = useState<string>(() => {
    const s = getInitialStoredSettings();
    return localStorage.getItem(STORE_TYPE_KEY) || s?.storeSettings?.type || 'grocery';
  });

  const [storePhone, setStorePhone] = useState(() => {
    const s = getInitialStoredSettings();
    return s?.storeSettings?.phone || '';
  });
  const [storeAddress, setStoreAddress] = useState(() => {
    const s = getInitialStoredSettings();
    return s?.storeSettings?.address || '';
  });
  const [storeLogo, setStoreLogo] = useState<string>(() => {
    const s = getInitialStoredSettings();
    return s?.storeSettings?.logo || '';
  });
  const [seedCategories, setSeedCategories] = useState(true);

  // رقم الهاتف إلزامي: يجب ربطه بالحساب (مع فحص استخدامه في حساب آخر) قبل متابعة الإعداد
  const [phoneClaimedFor, setPhoneClaimedFor] = useState<string>('');
  const [phoneChecking, setPhoneChecking] = useState(false);
  const [phoneTelegramOpen, setPhoneTelegramOpen] = useState(false);

  // Optional currencies and pricing
  const [initialCurrencies] = useState(() => getInitialCurrencies(language));
  const [primaryCurrency, setPrimaryCurrency] = useState(initialCurrencies.primaryCurrency);

  // Secondary Currency 1
  const [sec1Enabled, setSec1Enabled] = useState(initialCurrencies.c1.enabled);
  const [sec1Code, setSec1Code] = useState(initialCurrencies.c1.code);
  const [sec1Name, setSec1Name] = useState(initialCurrencies.c1.name);
  const [sec1Symbol, setSec1Symbol] = useState(initialCurrencies.c1.symbol);
  const [sec1Rate, setSec1Rate] = useState<number>(initialCurrencies.c1.rate);

  // Secondary Currency 2
  const [sec2Enabled, setSec2Enabled] = useState(initialCurrencies.c2.enabled);
  const [sec2Code, setSec2Code] = useState(initialCurrencies.c2.code);
  const [sec2Name, setSec2Name] = useState(initialCurrencies.c2.name);
  const [sec2Symbol, setSec2Symbol] = useState(initialCurrencies.c2.symbol);
  const [sec2Rate, setSec2Rate] = useState<number>(initialCurrencies.c2.rate);

  // Sales and optional printing and barcode settings
  const [taxEnabled, setTaxEnabled] = useState(() => {
    const s = getInitialStoredSettings();
    return s?.taxEnabled ?? false;
  });
  const [taxRate, setTaxRate] = useState<number>(() => {
    const s = getInitialStoredSettings();
    return Number(s?.taxRate) || 5;
  });
  const [discountPercentEnabled, setDiscountPercentEnabled] = useState(() => {
    const s = getInitialStoredSettings();
    return s?.discountPercentEnabled ?? true;
  });
  const [discountFixedEnabled, setDiscountFixedEnabled] = useState(() => {
    const s = getInitialStoredSettings();
    return s?.discountFixedEnabled ?? true;
  });
  const [barcodeScanMode, setBarcodeScanMode] = useState<'add' | 'search'>(() => {
    const s = getInitialStoredSettings();
    return s?.barcodeScanMode || 'add';
  });
  const [barcodeDevice, setBarcodeDevice] = useState<'camera' | 'scanner' | 'manual'>(() => {
    const s = getInitialStoredSettings();
    return s?.barcodeDeviceType || (localStorage.getItem('posflow_barcode_device') as any) || 'camera';
  });
  const [paperSize, setPaperSize] = useState<'80mm' | '57mm'>(() => {
    const s = getInitialStoredSettings();
    return s?.printSettings?.paperSize || '80mm';
  });
  const [receiptFooter, setReceiptFooter] = useState(() => {
    const s = getInitialStoredSettings();
    return s?.printSettings?.footerText || (isEn ? 'Thank you for visiting' : 'شكراً لزيارتكم');
  });
  const [printAutoAfterSale, setPrintAutoAfterSale] = useState(() => {
    const s = getInitialStoredSettings();
    return s?.printSettings?.autoPrint ?? false;
  });

  // Optional partners
  const [hasPartners, setHasPartners] = useState<'no' | 'yes'>('no');
  const [partners, setPartners] = useState<PartnerItem[]>([
    { id: '1', name: '', phone: '', capital: 0, sharePercentage: 50 },
  ]);

  // Optional appearance and opening float
  const [selectedFont, setSelectedFont] = useState<AppFontId>(() => getStoredAppFont());
  const [selectedScale, setSelectedScale] = useState<UIScaleId>(() => getStoredUIScale());
  const [openingCash, setOpeningCash] = useState<string>('0');
  const [openFirstShift, setOpenFirstShift] = useState(false);

  // Load existing settings on mount and sync missing fields from cloud if available
  useEffect(() => {
    let isMounted = true;

    // Background fetch from cloud to enrich any missing data if online
    import('@/lib/supabase-store').then(({ fetchStoreSettings }) => {
      fetchStoreSettings().then((cloud) => {
        if (!isMounted || !cloud) return;
        if (cloud.name) setStoreName((prev) => prev || cloud.name || '');
        if (cloud.phone) setStorePhone((prev) => prev || cloud.phone || '');
        if (cloud.address) setStoreAddress((prev) => prev || cloud.address || '');
        if (cloud.logo_url) setStoreLogo((prev) => prev || cloud.logo_url || '');
        if (cloud.store_type) setStoreType((prev) => prev || cloud.store_type || 'grocery');
        if (cloud.primary_currency) setPrimaryCurrency((prev) => prev || cloud.primary_currency || 'USD');
        if (cloud.tax_enabled !== undefined) setTaxEnabled((prev) => prev ?? !!cloud.tax_enabled);
        if (cloud.tax_rate !== undefined) setTaxRate((prev) => prev || Number(cloud.tax_rate) || 5);
      }).catch(() => {});
    }).catch(() => {});

    return () => {
      isMounted = false;
    };
  }, []);

  // Handle predefined currency selection for secondary 1
  const handleSelectSec1 = (code: string) => {
    const found = PREDEFINED_CURRENCIES.find(c => c.code === code);
    if (found) {
      setSec1Code(found.code);
      setSec1Name(getLocalizedCurrencyName(found, language));
      setSec1Symbol(found.symbol);
      if (found.suggestedRate) setSec1Rate(found.suggestedRate);
    }
  };

  // Handle predefined currency selection for secondary 2
  const handleSelectSec2 = (code: string) => {
    const found = PREDEFINED_CURRENCIES.find(c => c.code === code);
    if (found) {
      setSec2Code(found.code);
      setSec2Name(getLocalizedCurrencyName(found, language));
      setSec2Symbol(found.symbol);
      if (found.suggestedRate) setSec2Rate(found.suggestedRate);
    }
  };

  // Handle Logo Upload
  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast.error(isEn ? 'Logo file is too large (max 2 MB)' : 'حجم الشعار كبير جداً (الحد الأقصى 2 ميغابايت)');
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target?.result as string;
      setStoreLogo(base64);
      toast.success(isEn ? 'Logo uploaded successfully' : 'تم رفع الشعار بنجاح');
    };
    reader.readAsDataURL(file);
  };

  // Partners helpers
  const handleAddPartner = () => {
    const totalShare = partners.reduce((s, p) => s + (p.sharePercentage || 0), 0);
    const rem = Math.max(0, 100 - totalShare);
    setPartners([
      ...partners,
      {
        id: Date.now().toString(),
        name: '',
        phone: '',
        capital: 0,
        sharePercentage: rem > 0 ? rem : 0,
      },
    ]);
  };

  const handleRemovePartner = (id: string) => {
    if (partners.length <= 1) {
      toast.error(isEn ? 'At least one partner is required when partnership mode is enabled' : 'يجب بقاء شريك واحد على الأقل عند تفعيل المشاركة');
      return;
    }
    setPartners(partners.filter(p => p.id !== id));
  };

  const handlePartnerChange = (id: string, field: keyof PartnerItem, value: any) => {
    setPartners(partners.map(p => {
      if (p.id !== id) return p;
      return { ...p, [field]: value };
    }));
  };

  // Finish Wizard & Save All Settings
  const saveSetup = async (optionalSteps: ReadonlySet<number>) => {
    const saveCurrencies = optionalSteps.has(3);
    const saveDevices = optionalSteps.has(4);
    const saveAppearance = optionalSteps.has(6);
    // Opening cash must be zero or a positive finite amount
    const openingCashInput = String(openingCash ?? '').trim();
    const opensShift = saveAppearance && openFirstShift;
    const openingCashValue = !opensShift || openingCashInput === '' ? 0 : Number(openingCashInput);
    if (!Number.isFinite(openingCashValue) || openingCashValue < 0) {
      toast.error(isEn ? 'Opening cashbox balance must be zero or a positive amount' : 'رصيد افتتاح الصندوق يجب أن يكون صفراً أو مبلغاً موجباً');
      return;
    }
    const finalStoreName = storeName.trim() || (isEn ? 'My Store' : 'متجري');

    // 1. Seed categories if enabled and store categories are empty
    if (seedCategories) {
      try {
        const existingCats = loadCategories();
        if (existingCats.length === 0) {
          const defaults = getDefaultCategories(storeType);
          if (defaults && defaults.length > 0) {
            const formattedCategories: Category[] = defaults.map((catName, idx) => ({
              id: `${Date.now()}-${idx}`,
              name: catName,
              createdAt: new Date().toISOString(),
            }));
            saveCategories(formattedCategories);
          }
        }
      } catch (e) {
        console.warn('[SetupWizard] Categories seed fallback:', e);
      }
    }

    // 2. Read previous settings to safely merge
    let prevSettings: Record<string, any> = {};
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) prevSettings = JSON.parse(raw);
    } catch {}

    const newSettings = {
      ...prevSettings,
      storeSettings: {
        ...(prevSettings.storeSettings || {}),
        name: finalStoreName,
        type: storeType,
        phone: storePhone.trim(),
        address: storeAddress.trim(),
        logo: storeLogo,
      },
      primaryCurrency: saveCurrencies ? primaryCurrency : (prevSettings.primaryCurrency || initialCurrencies.primaryCurrency),
      ...(saveCurrencies ? {
        // The two extra currency slots must be named explicitly: currency normalization reads slot1Code/slot2Code
        slot1Code: sec1Code && sec1Code !== 'USD' ? sec1Code : prevSettings.slot1Code,
        slot2Code: sec2Code && sec2Code !== 'USD' && sec2Code !== sec1Code ? sec2Code : prevSettings.slot2Code,
        currencyNames: {
          ...(prevSettings.currencyNames || {}),
          USD: prevSettings.currencyNames?.USD || (isEn ? 'US Dollar' : 'دولار'),
          [sec1Code]: sec1Name.trim() || sec1Code,
          [sec2Code]: sec2Name.trim() || sec2Code,
        },
        currencySymbols: {
          ...(prevSettings.currencySymbols || {}),
          USD: prevSettings.currencySymbols?.USD || '$',
          [sec1Code]: sec1Symbol.trim() || sec1Code,
          [sec2Code]: sec2Symbol.trim() || sec2Code,
        },
        exchangeRates: {
          ...(prevSettings.exchangeRates || {}),
          USD: '1',
          [sec1Code]: String(sec1Rate || 1),
          [sec2Code]: String(sec2Rate || 1),
        },
        enabledCurrencies: {
          ...(prevSettings.enabledCurrencies || {}),
          USD: true,
          [sec1Code]: sec1Enabled,
          [sec2Code]: sec2Enabled,
        },
      } : {}),
      taxEnabled,
      taxRate: taxEnabled ? Number(taxRate || 0) : 0,
      discountPercentEnabled,
      discountFixedEnabled,
      ...(saveDevices ? {
        barcodeScanMode: barcodeDevice === 'manual' ? 'search' : barcodeScanMode,
        barcodeDeviceType: barcodeDevice,
        printSettings: {
          ...(prevSettings.printSettings || {}),
          paperSize,
          footerText: receiptFooter.trim(),
          autoPrint: printAutoAfterSale,
          showLogo: !!storeLogo,
          showTaxNumber: taxEnabled,
        },
      } : {}),
    };

    // 3. Local Storage save
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(newSettings));
      localStorage.setItem(STORE_TYPE_KEY, storeType);
      // تفعيل حقول المنتجات الخاصة بنوع المتجر تلقائياً (مقاس/لون للملابس، صلاحية للأغذية، IMEI للهواتف...)
      // وحفظها للمتجر حتى لا تبقى إعدادات حقول قديمة على الجهاز
      saveProductFieldsConfig(getDefaultFieldsByStoreType(storeType as StoreType)).catch(() => {});
      let prevTax: Record<string, any> = {};
      try {
        const rawTax = localStorage.getItem(TAX_KEY);
        if (rawTax) prevTax = JSON.parse(rawTax);
      } catch {}
      localStorage.setItem(TAX_KEY, JSON.stringify({
        ...prevTax,
        enabled: taxEnabled,
        rate: taxRate,
        inclusive: prevTax.inclusive ?? false,
        name: prevTax.name || (isEn ? 'Value Added Tax (VAT)' : 'ضريبة القيمة المضافة')
      }));
      if (saveDevices) localStorage.setItem('posflow_barcode_device', barcodeDevice);
    } catch (e) {
      console.warn('[SetupWizard] Failed to save to localStorage:', e);
    }

    // 4. Opening Cash Float / Shift
    const amount = openingCashValue;
    const existingActiveShift = getActiveShift();
    if (saveAppearance && openFirstShift && !existingActiveShift) {
      try {
        const uid = getCurrentUserId() || 'offline_admin';
        const uname = getCurrentUserName() || (isEn ? 'Manager' : 'المدير');
        openShift(amount, uid, uname);
      } catch (e) {
        console.warn('[SetupWizard] Open shift fallback:', e);
      }
    }

    // 5. Partners save if enabled
    if (optionalSteps.has(5) && hasPartners === 'yes') {
      const valid = partners.filter(p => p.name.trim());
      if (valid.length > 0) {
        const now = new Date().toISOString();
        const partnersToSave: Partner[] = valid.map(p => ({
          id: `partner-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
          name: p.name.trim(),
          phone: p.phone.trim(),
          sharePercentage: Number(p.sharePercentage) || 0,
          expenseSharePercentage: Number(p.sharePercentage) || 0,
          categoryShares: [],
          accessAll: true,
          sharesExpenses: true,
          initialCapital: Number(p.capital) || 0,
          currentCapital: Number(p.capital) || 0,
          capitalWithdrawals: [],
          capitalHistory: p.capital > 0 ? [{
            id: `cap-${Date.now()}`,
            amount: Number(p.capital),
            type: 'deposit' as const,
            date: now.split('T')[0],
            notes: isEn ? 'Initial capital' : 'رأس مال أولي',
          }] : [],
          confirmedProfit: 0,
          pendingProfit: 0,
          pendingProfitDetails: [],
          currentBalance: 0,
          totalWithdrawn: 0,
          totalExpensesPaid: 0,
          totalProfitEarned: 0,
          profitHistory: [],
          withdrawalHistory: [],
          expenseHistory: [],
          joinedDate: now,
        }));
        await savePartnersCloud(partnersToSave);
      }
    }

    // 6. Cloud store settings sync
    try {
      const existingCloudRates = (prevSettings.exchangeRates && typeof prevSettings.exchangeRates === 'object')
        ? Object.fromEntries(Object.entries(prevSettings.exchangeRates).map(([k, v]) => [k, Number(v) || 1]))
        : {};

      await saveStoreSettings({
        name: finalStoreName,
        store_type: storeType,
        phone: storePhone.trim(),
        address: storeAddress.trim(),
        logo_url: storeLogo,
        ...(saveCurrencies ? {
          primary_currency: newSettings.primaryCurrency,
          exchange_rates: {
            ...existingCloudRates,
            USD: 1,
            [sec1Code]: sec1Rate || 1,
            [sec2Code]: sec2Rate || 1,
          },
        } : {}),
        tax_enabled: taxEnabled,
        tax_rate: taxEnabled ? Number(taxRate || 0) : 0,
      });
    } catch (e) {
      console.warn('[SetupWizard] Cloud settings save fallback:', e);
    }

    if (saveAppearance) {
      setStoredAppFont(selectedFont);
      setStoredUIScale(selectedScale);
      setThemeMode(themeMode);
    }

    try { localStorage.setItem('posflow_setup_complete', 'true'); } catch {}

    // 7. Dispatch system events so POS, Sidebar, and Themes update immediately
    emitEvent(EVENTS.SETTINGS_UPDATED, newSettings);
    emitEvent(EVENTS.STORE_TYPE_CHANGED, storeType);

    toast.success(isEn ? 'Store setup complete! Welcome to POS Flow App' : 'تم إعداد المتجر بنجاح! مرحباً بك في POS Flow App', {
      description: isEn ? 'Your system is ready to run at peak efficiency' : 'نظامك جاهز للعمل الآن بأعلى كفاءة',
    });

    onComplete();
  };

  const finishSetup = async (includeFinalStep = false) => {
    if (savingRef.current || phoneChecking || step < lastRequiredStep) return;
    if (!phoneClaimedFor || phoneClaimedFor !== storePhone.trim()) {
      setStep(1);
      toast.error(isEn ? 'Please verify the phone number before finishing setup' : 'تحقّق من رقم الهاتف قبل إنهاء الإعداد');
      return;
    }

    const optionalSteps = new Set(acceptedOptionalSteps);
    if (includeFinalStep) optionalSteps.add(totalSteps);
    savingRef.current = true;
    setIsSaving(true);
    try {
      await saveSetup(optionalSteps);
    } catch (error) {
      console.error('[SetupWizard] Save failed:', error);
      toast.error(isEn ? 'Could not complete setup. Please try again' : 'تعذّر إكمال الإعداد، حاول مرة أخرى');
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  const goToNextStep = (acceptOptionalStep = true) => {
    if (step > lastRequiredStep) {
      setAcceptedOptionalSteps(previous => {
        const next = new Set(previous);
        if (acceptOptionalStep) next.add(step);
        else next.delete(step);
        return next;
      });
    }
    const nextStep = step + 1;
    setVisitedSteps(previous => new Set([...previous, nextStep]));
    setStep(nextStep);
  };

  const storeTypesList = [
    { id: 'grocery', name: isEn ? 'Grocery & Supermarket' : 'بقالة وسوبرماركت', icon: ShoppingBag, desc: isEn ? 'Food, beverages, and daily essentials' : 'مواد غذائية واستهلاكية وتجزئة سريعة' },
    { id: 'phones', name: isEn ? 'Phones & Electronics' : 'هواتف وإلكترونيات', icon: Smartphone, desc: isEn ? 'Smartphones, accessories, cards, and services' : 'أجهزة، إكسسوارات، بطاقات، وخدمات' },
    { id: 'clothing', name: isEn ? 'Clothing & Fashion' : 'ملابس وأزياء', icon: Layers, desc: isEn ? 'Sizes, colors, fabrics, and categories' : 'مقاسات وألوان وأقمشة وتصنيفات' },
    { id: 'restaurant', name: isEn ? 'Restaurant & Café' : 'مطعم أو كافيه', icon: UtensilsCrossed, desc: isEn ? 'Meals, drinks, dine-in, and takeaway' : 'وجبات، مشروبات، وتناول محلي وسفري' },
    { id: 'maintenance', name: isEn ? 'Maintenance & Services' : 'خدمات وصيانة', icon: Wrench, desc: isEn ? 'Labor, spare parts, and service orders' : 'أجور عمالة، قطع غيار، وأوامر عمل' },
    { id: 'general', name: isEn ? 'General Retail' : 'تجزئة عامة ومتنوعة', icon: Boxes, desc: isEn ? 'General inventory and fast retail sales' : 'مخزون عام ومبيعات سريعة شاملة' },
  ];

  const stepsMeta = [
    { num: 1, label: isEn ? 'Store' : 'المتجر', fullTitle: isEn ? 'Store Identity & Receipt' : 'بيانات المتجر والفاتورة', icon: Store },
    { num: 2, label: isEn ? 'Sales' : 'المبيعات', fullTitle: isEn ? 'VAT & Discounts' : 'الضريبة والخصومات', icon: Receipt },
    { num: 3, label: isEn ? 'Currencies' : 'العملات', fullTitle: isEn ? 'Currencies & Exchange Rates' : 'العملات وأسعار الصرف', icon: Coins },
    { num: 4, label: isEn ? 'Hardware' : 'الأجهزة', fullTitle: isEn ? 'Printing & Barcode' : 'الطباعة والباركود', icon: Printer },
    { num: 5, label: isEn ? 'Partners' : 'الشركاء', fullTitle: isEn ? 'Partners & Capital' : 'الشركاء ورأس المال', icon: Users },
    { num: 6, label: isEn ? 'Theme & Cashbox' : 'المظهر والصندوق', fullTitle: isEn ? 'Appearance & Opening Balance' : 'المظهر ورصيد الافتتاح', icon: Palette },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-background flex items-center justify-center p-2 sm:p-4 overflow-y-auto" dir={direction}>
      <div className="w-full max-w-3xl bg-card border border-border shadow-2xl rounded-2xl sm:rounded-3xl overflow-hidden my-auto flex flex-col max-h-[96vh]">
        
        {/* Header Bar */}
        <div className="p-4 sm:p-6 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent border-b border-border/60 flex-shrink-0">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-primary text-primary-foreground flex items-center justify-center shadow-md shadow-primary/20">
                <Sparkles className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-base sm:text-lg font-black text-foreground">
                  {isEn ? "Welcome & Initial Setup Wizard" : "معالج الترحيب والإعداد الأولي"}
                </h1>
                <p className="text-xs text-muted-foreground">
                  {isEn ? "Configure your store and sales essentials, then complete any optional settings." : "اضبط بيانات المتجر والبيع، ثم أكمل ما تحتاجه من الإعدادات الاختيارية."}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* زر إغلاق / خروج بدون حفظ (Preview Mode) */}
              {isAlreadySetup && (
                <button
                  type="button"
                  onClick={() => onComplete()}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground border border-border/70 text-xs font-semibold transition-[colors,transform] active:scale-95 cursor-pointer"
                  title={isEn ? "Close preview without saving changes" : "إغلاق المعاينة دون حفظ أي تعديلات"}
                >
                  <X className="w-3.5 h-3.5" />
                  <span>{isEn ? "Close" : "إغلاق"}</span>
                </button>
              )}
            </div>
          </div>

          {/* Active Step Indicator & Smooth Progress Bar */}
          <div className="space-y-2 mb-3.5">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-black text-foreground shrink-0">
                  {isEn ? `Step ${step} of ${totalSteps}:` : `الخطوة ${step} من ${totalSteps}:`}
                </span>
                <span className="text-primary font-bold truncate">
                  {stepsMeta[step - 1]?.fullTitle}
                  {step > lastRequiredStep && (isEn ? ' · Optional' : ' · اختياري')}
                </span>
              </div>
            </div>

            {/* Linear Progress Bar */}
            <div role="progressbar" aria-label={isEn ? "Setup progress" : "التقدّم في الإعداد"} aria-valuemin={1} aria-valuemax={totalSteps} aria-valuenow={step} className="h-1.5 w-full bg-muted/60 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-[width] duration-300 ease-out shadow-sm shadow-primary/25"
                style={{ width: `${(step / totalSteps) * 100}%` }}
              />
            </div>
          </div>

          {/* Stepper Tabs Bar - Clean, Non-overlapping, Responsive */}
          <div 
            ref={tabsContainerRef}
            className="flex sm:grid sm:grid-cols-6 items-stretch gap-1.5 sm:gap-2 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden scroll-smooth py-1 px-0.5 -mx-0.5"
          >
            {stepsMeta.map((s) => {
              const Icon = s.icon;
              const isActive = step === s.num;
              const isPast = step > s.num;
              const isAccessible = visitedSteps.has(s.num);

              return (
                <button
                  key={s.num}
                  ref={isActive ? activeTabRef : null}
                  type="button"
                  disabled={!isAccessible || isSaving || phoneChecking}
                  aria-current={isActive ? 'step' : undefined}
                  onClick={() => {
                    if (isAccessible) setStep(s.num);
                  }}
                  className={cn(
                    "shrink-0 min-w-fit sm:min-w-0 sm:w-full flex items-center justify-center gap-1.5 sm:gap-2 py-2 px-3 sm:px-2 rounded-xl border text-center transition-colors duration-200 select-none",
                    !isAccessible && "opacity-40 cursor-not-allowed pointer-events-none border-border/40 bg-muted/20 text-muted-foreground/50",
                    isActive && "border-primary bg-primary text-primary-foreground font-bold shadow-md shadow-primary/25 scale-[1.01] cursor-pointer ring-2 ring-primary/20",
                    isPast && "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 font-semibold cursor-pointer",
                    isAccessible && !isActive && !isPast && "border-border/60 bg-muted/40 text-foreground hover:bg-muted/70 font-medium cursor-pointer"
                  )}
                  title={isAccessible ? `${s.num}. ${s.label}` : (isEn ? 'Please complete the previous steps first' : 'يرجى إكمال الخطوات السابقة أولاً')}
                >
                  {/* Step status badge */}
                  <div className={cn(
                    "w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-[10px] font-black transition-colors",
                    isActive && "bg-primary-foreground/20 text-primary-foreground",
                    isPast && "bg-primary text-primary-foreground",
                    isAccessible && !isActive && !isPast && "bg-muted-foreground/20 text-foreground",
                    !isAccessible && "bg-muted text-muted-foreground/40"
                  )}>
                    {isPast ? <Check className="w-3 h-3 stroke-[3]" /> : s.num}
                  </div>

                  {/* Icon */}
                  <Icon className={cn(
                    "w-3.5 h-3.5 shrink-0 hidden xs:inline-block sm:inline-block",
                    isActive ? "text-primary-foreground" : isPast ? "text-primary" : "text-muted-foreground"
                  )} />

                  {/* Label */}
                  <span className="text-[11px] sm:text-xs font-bold whitespace-nowrap truncate">
                    {s.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Content Body */}
        <div ref={contentRef} className="p-4 sm:p-7 space-y-5 flex-1 min-h-0 overflow-y-auto">
          
          {/* STEP 1: هوية المتجر وبيانات الفاتورة وقوالب التصنيفات */}
          {step === 1 && (
            <div className="space-y-5 animate-in fade-in duration-200">
              <div>
                <h2 className="text-base sm:text-lg font-bold text-foreground flex items-center gap-2">
                  <Store className="w-5 h-5 text-primary" />
                  {isEn ? "Store Identity & Receipt Details" : "هوية المتجر وبيانات الفاتورة"}
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {isEn ? "Set your store name, business type, and logo shown to customers" : "حدد اسم محلك وطبيعة نشاطك وشعارك التجاري الذي سيظهر للزبائن"}
                </p>
              </div>

              {/* Store Name Input */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-foreground">
                  {isEn ? "Store / Business Name" : "اسم المتجر / النشاط التجاري"}
                </label>
                <Input
                  value={storeName}
                  onChange={(e) => setStoreName(e.target.value)}
                  placeholder={isEn ? "e.g., Al-Noor Market, Jasmine Café..." : "مثال: سوبرماركت البركة، محلات النور، كافيه الياسمين..."}
                  className="h-11 rounded-xl text-sm font-medium"
                />
              </div>

              {/* Store Type Selector */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-foreground">
                  {isEn ? "Business Type" : "نوع النشاط التجاري"}
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  {storeTypesList.map((st) => {
                    const Icon = st.icon;
                    const isSelected = storeType === st.id;
                    return (
                      <button
                        key={st.id}
                        type="button"
                        onClick={() => setStoreType(st.id)}
                        className={cn(
                          "flex flex-col items-start p-3 rounded-xl border text-start transition-colors cursor-pointer",
                          isSelected
                            ? "border-primary bg-primary/5 shadow-xs ring-1 ring-primary/30"
                            : "border-border/60 bg-card hover:bg-muted/40 hover:border-border"
                        )}
                      >
                        <div className="flex items-center justify-between w-full mb-1.5">
                          <div className={cn(
                            "w-7 h-7 rounded-lg flex items-center justify-center shrink-0",
                            isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                          )}>
                            <Icon className="w-4 h-4" />
                          </div>
                          {isSelected && <Check className="w-4 h-4 text-primary" />}
                        </div>
                        <span className="text-xs font-bold text-foreground block truncate w-full">
                          {st.name}
                        </span>
                        <span className="text-[10px] text-muted-foreground line-clamp-1 mt-0.5">
                          {st.desc}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Logo Upload + Phone + Address */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-border/50">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-foreground">
                    {isEn ? "Phone Number (Required)" : "رقم الهاتف (إلزامي)"} <span className="text-destructive">*</span>
                  </label>
                  <PhoneInput value={storePhone} onChange={(phone) => {
                    if (!phoneChecking && !phoneTelegramOpen) setStorePhone(phone);
                  }} />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-foreground">
                    {isEn ? "Store Address / City" : "عنوان المحل / المدينة"}
                  </label>
                  <Input
                    value={storeAddress}
                    onChange={(e) => setStoreAddress(e.target.value)}
                    placeholder={isEn ? "City, street, district..." : "المدينة، الشارع، السوق..."}
                    className="h-10 rounded-xl text-xs"
                  />
                </div>
              </div>

              {/* Logo upload widget */}
              <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/30 border border-border/60">
                {storeLogo ? (
                  <div className="relative shrink-0">
                    <img
                      src={storeLogo}
                      alt="Logo preview"
                      className="w-12 h-12 rounded-xl object-contain border border-border bg-background p-1"
                    />
                    <button
                      type="button"
                      onClick={() => setStoreLogo('')}
                      className="absolute -top-1.5 -right-1.5 bg-destructive text-destructive-foreground rounded-full p-0.5 shadow-sm"
                      title={isEn ? "Remove logo" : "حذف الشعار"}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ) : (
                  <div className="w-12 h-12 rounded-xl border border-dashed border-border flex items-center justify-center bg-background/50 text-muted-foreground shrink-0">
                    <Upload className="w-5 h-5 opacity-60" />
                  </div>
                )}

                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-foreground">{isEn ? "Store Logo" : "شعار المتجر (Logo)"}</p>
                  <p className="text-[11px] text-muted-foreground">{isEn ? "Displayed at the top of invoices and printed receipts" : "يظهر في رأس الفاتورة وإيصالات الطباعة"}</p>
                </div>

                <div>
                  <input
                    type="file"
                    accept="image/*"
                    id="setup-logo-upload"
                    className="hidden"
                    onChange={handleLogoUpload}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs rounded-lg"
                    onClick={() => document.getElementById('setup-logo-upload')?.click()}
                  >
                    <Upload className="w-3.5 h-3.5" />
                    {storeLogo ? (isEn ? 'Change' : 'تغيير') : (isEn ? 'Upload Logo' : 'رفع شعار')}
                  </Button>
                </div>
              </div>

              {/* بطاقة توليد التصنيفات النموذجية تلقائياً حسب نوع النشاط */}
              <div className="flex items-center justify-between p-3.5 rounded-xl border border-border/70 bg-card hover:bg-muted/30 transition-colors">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <Boxes className="w-4 h-4 text-primary shrink-0" />
                    <span className="text-xs font-bold text-foreground">
                      {isEn ? "Auto-generate starter categories" : "توليد تصنيفات تلقائية لنشاطك"}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {isEn ? "Create common starter categories tailored to your business type for immediate use in POS" : "إنشاء تصنيفات نموذجية شائعة تناسب نشاطك المختار لتكون جاهزة في شاشة البيع فوراً"}
                  </p>
                </div>
                <Switch
                  checked={seedCategories}
                  onCheckedChange={setSeedCategories}
                  className="data-[state=checked]:bg-primary shrink-0"
                />
              </div>

              {/* Notice */}
              <div className="p-3 bg-primary/5 border border-primary/20 rounded-xl flex items-center gap-2.5 text-xs text-primary">
                <HelpCircle className="w-4 h-4 shrink-0" />
                <span>
                  {isEn ? "These details appear at the top of printed customer receipts and can be updated anytime in Settings." : "هذه البيانات ستظهر في أعلى إيصال الطباعة للزبائن، ويمكنك تعديلها لاحقاً من شاشة الإعدادات."}
                </span>
              </div>
            </div>
          )}

          {/* STEP 2: إعدادات المبيعات */}
          {step === 2 && (
            <div className="space-y-5 animate-in fade-in duration-200">
              <div>
                <h2 className="text-base sm:text-lg font-bold text-foreground flex items-center gap-2">
                  <Receipt className="w-5 h-5 text-primary" />
                  {isEn ? "Core Sales Settings" : "إعدادات البيع الأساسية"}
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {isEn ? "Configure tax and discount options used at checkout." : "اضبط الضريبة والخصومات المستخدمة في شاشة البيع."}
                </p>
              </div>

              {/* Tax Settings */}
              <div className="p-4 rounded-2xl bg-muted/30 border border-border/60 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                      <Percent className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-foreground">{isEn ? "Value Added Tax (VAT)" : "ضريبة القيمة المضافة (VAT)"}</p>
                      <p className="text-[11px] text-muted-foreground">{isEn ? "Automatically calculate tax on invoices" : "احتساب الضريبة بشكل تلقائي على الفاتورة"}</p>
                    </div>
                  </div>
                  <Switch checked={taxEnabled} onCheckedChange={setTaxEnabled} />
                </div>

                {taxEnabled && (
                  <div className="pt-2 border-t border-border/40 flex items-center justify-between gap-3 animate-in fade-in duration-150">
                    <label className="text-xs font-bold text-foreground shrink-0">
                      {isEn ? "Tax Rate (%):" : "نسبة الضريبة المئوية:"}
                    </label>
                    <div className="flex items-center gap-1.5 w-32">
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        value={taxRate || ''}
                        onChange={(e) => setTaxRate(Number(e.target.value))}
                        className="h-8 text-xs font-bold text-center"
                      />
                      <span className="text-xs font-bold text-muted-foreground">%</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Discounts Toggles */}
              <div className="p-4 rounded-2xl bg-muted/30 border border-border/60 space-y-3">
                <p className="text-xs font-bold text-foreground">{isEn ? "POS Discount Permissions" : "صلاحيات الخصومات في شاشة البيع"}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div className="flex items-center justify-between p-2.5 rounded-xl bg-background border border-border/60">
                    <span className="text-xs font-medium">{isEn ? "Allow percentage discount (%)" : "السماح بالخصم المئوي (%)"}</span>
                    <Switch
                      checked={discountPercentEnabled}
                      onCheckedChange={setDiscountPercentEnabled}
                    />
                  </div>
                  <div className="flex items-center justify-between p-2.5 rounded-xl bg-background border border-border/60">
                    <span className="text-xs font-medium">{isEn ? "Allow fixed-amount discount" : "السماح بالخصم المالي المباشر"}</span>
                    <Switch
                      checked={discountFixedEnabled}
                      onCheckedChange={setDiscountFixedEnabled}
                    />
                  </div>
                </div>
              </div>

            </div>
          )}

          {/* STEP 3: إعداد العملات المرن والديناميكي وأسعار الصرف */}
          {step === 3 && (
            <div className="space-y-5 animate-in fade-in duration-200">
              <div>
                <h2 className="text-base sm:text-lg font-bold text-foreground flex items-center gap-2">
                  <Coins className="w-5 h-5 text-primary" />
                  {isEn ? "Dynamic Multi-Currency & Exchange Rates" : "نظام العملات الديناميكي وأسعار الصرف"}
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {isEn ? "Choose your default selling currency and configure secondary currencies with live exchange rates" : "حدد العملة الافتراضية للبيع وخصص العملات الثانوية مع أسعار الصرف الحية"}
                </p>
              </div>

              {/* Primary Currency Radio Cards */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-foreground">
                  {isEn ? "Default Selling & Display Currency" : "العملة الافتراضية للبيع والعرض أمام الزبائن"}
                </label>
                <div className="grid grid-cols-3 gap-2.5">
                  {[
                    { code: 'USD', symbol: '$', title: getLocalizedCurrencyName('USD', language), badge: isEn ? 'Base Currency' : 'مرجع النظام', active: true },
                    { code: sec1Code, symbol: sec1Symbol, title: sec1Name, badge: isEn ? '2nd Currency' : 'العملة الثانية', active: sec1Enabled || primaryCurrency === sec1Code },
                    { code: sec2Code, symbol: sec2Symbol, title: sec2Name, badge: isEn ? '3rd Currency' : 'العملة الثالثة', active: sec2Enabled || primaryCurrency === sec2Code },
                  ].map((curr) => {
                    const isSelected = primaryCurrency === curr.code;
                    return (
                      <button
                        key={curr.code}
                        type="button"
                        onClick={() => {
                          setPrimaryCurrency(curr.code);
                          if (curr.code === sec1Code) setSec1Enabled(true);
                          if (curr.code === sec2Code) setSec2Enabled(true);
                        }}
                        className={cn(
                          "flex flex-col items-center justify-center p-3 rounded-2xl border-2 transition-colors relative cursor-pointer",
                          isSelected
                            ? "border-primary bg-primary/10 shadow-sm ring-1 ring-primary/30"
                            : "border-border/60 bg-card hover:bg-muted/40",
                          !curr.active && "opacity-50 border-dashed"
                        )}
                      >
                        <span className="text-2xl font-black text-primary mb-1">
                          {curr.symbol}
                        </span>
                        <span className="text-xs font-bold text-foreground truncate max-w-full">
                          {curr.title}
                        </span>
                        <span className="text-[10px] text-muted-foreground mt-0.5">
                          {curr.active ? curr.badge : (isEn ? 'Disabled' : 'معطّلة')}
                        </span>
                        {isSelected && (
                          <div className="absolute top-2 left-2 w-4 h-4 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
                            <Check className="w-2.5 h-2.5 stroke-[3]" />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* العملات المفعّلة حالياً */}
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="font-bold text-muted-foreground">{isEn ? "Enabled Currencies:" : "العملات المفعّلة:"}</span>
                {[
                  { code: 'USD', on: true },
                  { code: sec1Code, on: sec1Enabled || primaryCurrency === sec1Code },
                  { code: sec2Code, on: sec2Enabled || primaryCurrency === sec2Code },
                ].map((c) => (
                  <span
                    key={c.code}
                    className={cn(
                      'px-2 py-0.5 rounded-full border font-mono font-bold',
                      c.on ? 'bg-primary/10 text-primary border-primary/40' : 'bg-muted text-muted-foreground border-border line-through opacity-60'
                    )}
                  >
                    {c.code}
                  </span>
                ))}
              </div>

              {/* Secondary Currency 1 Configuration Card */}
              <div className="p-4 rounded-2xl border border-border/70 bg-card space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-blue-500/10 text-blue-600 flex items-center justify-center font-bold text-xs">
                      1
                    </div>
                    <div>
                      <p className="text-xs font-bold text-foreground">{isEn ? "Second Currency (e.g., Turkish Lira)" : "العملة الثانية (مثال: التركية)"}</p>
                      <p className={cn("text-[10px]", sec1Enabled ? "text-muted-foreground" : "text-destructive font-bold")}>{sec1Enabled ? (isEn ? "Payment & conversion option in POS cart and invoices" : "خيار سداد وتبديل في سلة البيع والفواتير") : (isEn ? "Disabled" : "معطّلة")}</p>
                    </div>
                  </div>
                  <Switch
                    checked={sec1Enabled || primaryCurrency === sec1Code}
                    onCheckedChange={(on) => {
                      setSec1Enabled(on);
                      // تعطيل العملة الافتراضية الحالية → الرجوع إلى الدولار
                      if (!on && primaryCurrency === sec1Code) setPrimaryCurrency('USD');
                    }}
                  />
                </div>

                {sec1Enabled && (
                  <div className="space-y-3 pt-2 border-t border-border/50 animate-in fade-in duration-150">
                    {/* Quick Pick Predefined Currency */}
                    <div className="space-y-1">
                      <label className="text-[11px] font-bold text-muted-foreground">
                        {isEn ? "Quick select from preset currencies:" : "اختيار سريع من العملات الجاهزة:"}
                      </label>
                      <Select value={sec1Code} onValueChange={handleSelectSec1}>
                        <SelectTrigger className="h-9 text-xs rounded-xl bg-background">
                          <SelectValue placeholder={isEn ? "Select currency..." : "اختر عملة..."} />
                        </SelectTrigger>
                        <SelectContent className="max-h-60 z-[120]">
                          {PREDEFINED_CURRENCIES.map(curr => (
                            <SelectItem key={curr.code} value={curr.code} className="text-xs">
                              <span className="flex items-center gap-2">
                                <span className="font-bold font-mono">{curr.code}</span>
                                <span>{getLocalizedCurrencyName(curr, language)}</span>
                                <span className="text-muted-foreground">({curr.symbol})</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Custom Name, Symbol, and Exchange Rate */}
                    <div className="grid grid-cols-3 gap-2">
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-muted-foreground">{isEn ? "Currency Name:" : "اسم العملة:"}</label>
                        <Input
                          value={sec1Name}
                          onChange={(e) => setSec1Name(e.target.value)}
                          placeholder={isEn ? "Name" : "الاسم"}
                          className="h-8 text-xs font-medium"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-muted-foreground">{isEn ? "Symbol:" : "الرمز:"}</label>
                        <Input
                          value={sec1Symbol}
                          onChange={(e) => setSec1Symbol(e.target.value)}
                          placeholder={isEn ? "Symbol" : "الرمز"}
                          className="h-8 text-xs font-bold text-center"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-muted-foreground">1 $ = ({sec1Symbol})</label>
                        <Input
                          type="number"
                          step="any"
                          value={sec1Rate || ''}
                          onChange={(e) => setSec1Rate(Number(e.target.value))}
                          placeholder={isEn ? "Exchange rate" : "سعر الصرف"}
                          className="h-8 text-xs font-bold text-primary font-mono text-center"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Secondary Currency 2 Configuration Card */}
              <div className="p-4 rounded-2xl border border-border/70 bg-card space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-600 flex items-center justify-center font-bold text-xs">
                      2
                    </div>
                    <div>
                      <p className="text-xs font-bold text-foreground">{isEn ? "Third Currency (e.g., Syrian Pound)" : "العملة الثالثة (مثال: السورية)"}</p>
                      <p className={cn("text-[10px]", sec2Enabled ? "text-muted-foreground" : "text-destructive font-bold")}>{sec2Enabled ? (isEn ? "Additional local currency payment & conversion option" : "خيار سداد وتبديل إضافي بالعملة المحلية") : (isEn ? "Disabled" : "معطّلة")}</p>
                    </div>
                  </div>
                  <Switch
                    checked={sec2Enabled || primaryCurrency === sec2Code}
                    onCheckedChange={(on) => {
                      setSec2Enabled(on);
                      // تعطيل العملة الافتراضية الحالية → الرجوع إلى الدولار
                      if (!on && primaryCurrency === sec2Code) setPrimaryCurrency('USD');
                    }}
                  />
                </div>

                {sec2Enabled && (
                  <div className="space-y-3 pt-2 border-t border-border/50 animate-in fade-in duration-150">
                    {/* Quick Pick Predefined Currency */}
                    <div className="space-y-1">
                      <label className="text-[11px] font-bold text-muted-foreground">
                        {isEn ? "Quick select from preset currencies:" : "اختيار سريع من العملات الجاهزة:"}
                      </label>
                      <Select value={sec2Code} onValueChange={handleSelectSec2}>
                        <SelectTrigger className="h-9 text-xs rounded-xl bg-background">
                          <SelectValue placeholder={isEn ? "Select currency..." : "اختر عملة..."} />
                        </SelectTrigger>
                        <SelectContent className="max-h-60 z-[120]">
                          {PREDEFINED_CURRENCIES.map(curr => (
                            <SelectItem key={curr.code} value={curr.code} className="text-xs">
                              <span className="flex items-center gap-2">
                                <span className="font-bold font-mono">{curr.code}</span>
                                <span>{getLocalizedCurrencyName(curr, language)}</span>
                                <span className="text-muted-foreground">({curr.symbol})</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Custom Name, Symbol, and Exchange Rate */}
                    <div className="grid grid-cols-3 gap-2">
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-muted-foreground">{isEn ? "Currency Name:" : "اسم العملة:"}</label>
                        <Input
                          value={sec2Name}
                          onChange={(e) => setSec2Name(e.target.value)}
                          placeholder={isEn ? "Name" : "الاسم"}
                          className="h-8 text-xs font-medium"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-muted-foreground">{isEn ? "Symbol:" : "الرمز:"}</label>
                        <Input
                          value={sec2Symbol}
                          onChange={(e) => setSec2Symbol(e.target.value)}
                          placeholder={isEn ? "Symbol" : "الرمز"}
                          className="h-8 text-xs font-bold text-center"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-muted-foreground">1 $ = ({sec2Symbol})</label>
                        <Input
                          type="number"
                          step="any"
                          value={sec2Rate || ''}
                          onChange={(e) => setSec2Rate(Number(e.target.value))}
                          placeholder={isEn ? "Exchange rate" : "سعر الصرف"}
                          className="h-8 text-xs font-bold text-primary font-mono text-center"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Friendly Note */}
              <div className="p-3 bg-muted/50 border border-border/60 rounded-xl flex items-start gap-2.5 text-xs text-muted-foreground">
                <Sparkles className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                <span>
                  {isEn ? "Note: The system keeps USD as the stable internal accounting base for profits and inventory, while letting you price, display, and collect invoices in any currency." : "ملاحظة: يحافظ النظام على الدولار (USD) كمرجع محاسبي داخلي مستقر للأرباح والمخزون، مع مرونة تامة في تسعير وعرض وقبض الفواتير بأي عملة تحددها."}
                </span>
              </div>
            </div>
          )}

          {/* STEP 4: الطباعة والباركود */}
          {step === 4 && (
            <div className="space-y-5">
              <h2 className="text-base sm:text-lg font-bold text-foreground flex items-center gap-2">
                <Printer className="w-5 h-5 text-primary" />
                {isEn ? "Printing & Barcode" : "الطباعة والباركود"}
              </h2>
              {/* Thermal Printer Settings (إعدادات الفاتورة والطباعة الحرارية) */}
              <div className="p-4 rounded-2xl bg-muted/30 border border-border/60 space-y-3.5">
                <div className="flex items-center gap-2">
                  <Printer className="w-4 h-4 text-primary" />
                  <p className="text-xs font-bold text-foreground">{isEn ? "Receipt & Thermal Printing Settings" : "إعدادات إيصال الفاتورة والطباعة الحرارية"}</p>
                </div>

                {/* Paper Size Selector */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-muted-foreground">{isEn ? "Thermal Printer Paper Width:" : "مقاس ورق الطابعة الحرارية:"}</label>
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => setPaperSize('80mm')}
                      className={cn(
                        "flex flex-col items-start p-3 rounded-xl border text-start transition-colors cursor-pointer",
                        paperSize === '80mm'
                          ? "border-primary bg-primary/10 shadow-xs"
                          : "border-border/60 bg-background hover:bg-muted/40"
                      )}
                    >
                      <div className="flex items-center justify-between w-full mb-1">
                        <span className="text-xs font-bold text-foreground">{isEn ? "Standard Receipt Printer (80mm)" : "طابعة فواتير قياسية (80mm)"}</span>
                        {paperSize === '80mm' && <Check className="w-4 h-4 text-primary" />}
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {isEn ? "80mm width — standard POS counter receipt paper" : "عرض 80 مم - ورق قياسي مناسب لكاشير المحلات ونقاط البيع"}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setPaperSize('57mm')}
                      className={cn(
                        "flex flex-col items-start p-3 rounded-xl border text-start transition-colors cursor-pointer",
                        paperSize === '57mm'
                          ? "border-primary bg-primary/10 shadow-xs"
                          : "border-border/60 bg-background hover:bg-muted/40"
                      )}
                    >
                      <div className="flex items-center justify-between w-full mb-1">
                        <span className="text-xs font-bold text-foreground">{isEn ? "Compact Bluetooth Printer (57mm)" : "طابعة بلوتوث صغيرة (57mm)"}</span>
                        {paperSize === '57mm' && <Check className="w-4 h-4 text-primary" />}
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {isEn ? "57mm width — compact portable paper for field sales" : "عرض 57 مم - ورق صغير محمول مناسب للمناديب والعمل الميداني"}
                      </span>
                    </button>
                  </div>
                </div>

                {/* Receipt Footer Text */}
                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-muted-foreground">{isEn ? "Printed Receipt Footer:" : "تذييل الفاتورة المطبوعة:"}</label>
                  <Input
                    value={receiptFooter}
                    onChange={(e) => setReceiptFooter(e.target.value)}
                    placeholder={isEn ? "e.g., Thank you for visiting!" : "مثال: شكراً لزيارتكم، نسعد بخدمتكم دائماً"}
                    className="h-9 text-xs bg-background"
                  />
                </div>

                {/* Auto Print Toggle */}
                <div className="flex items-center justify-between p-2.5 rounded-xl bg-background border border-border/60">
                  <div>
                    <p className="text-xs font-bold text-foreground">{isEn ? "Auto-print after every sale" : "الطباعة التلقائية بعد كل عملية بيع"}</p>
                    <p className="text-[10px] text-muted-foreground">{isEn ? "Send receipt straight to printer upon completing a cash or credit sale" : "إرسال الفاتورة للطابعة مباشرة فور الضغط على كاش أو آجل"}</p>
                  </div>
                  <Switch
                    checked={printAutoAfterSale}
                    onCheckedChange={setPrintAutoAfterSale}
                  />
                </div>
              </div>

              {/* Barcode Scanner Device & Behavior (3 Options) */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-foreground flex items-center gap-1.5">
                  <Barcode className="w-4 h-4 text-primary" />
                  {isEn ? "Preferred Barcode Scanning Method" : "طريقة قراءة ومسح الباركود المفضلة"}
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setBarcodeDevice('camera')}
                    className={cn(
                      "flex flex-col items-start p-3 rounded-xl border text-start transition-colors cursor-pointer",
                      barcodeDevice === 'camera'
                        ? "border-primary bg-primary/10 shadow-xs"
                        : "border-border/60 bg-card hover:bg-muted/40"
                    )}
                  >
                    <div className="flex items-center justify-between w-full mb-1.5">
                      <div className={cn(
                        "w-7 h-7 rounded-lg flex items-center justify-center",
                        barcodeDevice === 'camera' ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                      )}>
                        <Camera className="w-4 h-4" />
                      </div>
                      {barcodeDevice === 'camera' && <Check className="w-4 h-4 text-primary" />}
                    </div>
                    <span className="text-xs font-bold text-foreground block">{isEn ? "Phone / Tablet Camera" : "كاميرا الهاتف / التابلت"}</span>
                    <span className="text-[10px] text-muted-foreground mt-0.5">
                      {isEn ? "Ideal for mobile setups and small shops without extra hardware" : "مناسبة للعمل الميداني والمحلات الصغيرة دون أجهزة إضافية"}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setBarcodeDevice('scanner')}
                    className={cn(
                      "flex flex-col items-start p-3 rounded-xl border text-start transition-colors cursor-pointer",
                      barcodeDevice === 'scanner'
                        ? "border-primary bg-primary/10 shadow-xs"
                        : "border-border/60 bg-card hover:bg-muted/40"
                    )}
                  >
                    <div className="flex items-center justify-between w-full mb-1.5">
                      <div className={cn(
                        "w-7 h-7 rounded-lg flex items-center justify-center",
                        barcodeDevice === 'scanner' ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                      )}>
                        <ScanLine className="w-4 h-4" />
                      </div>
                      {barcodeDevice === 'scanner' && <Check className="w-4 h-4 text-primary" />}
                    </div>
                    <span className="text-xs font-bold text-foreground block">{isEn ? "External Scanner (USB/BT)" : "قارئ خارجي (USB/BT)"}</span>
                    <span className="text-[10px] text-muted-foreground mt-0.5">
                      {isEn ? "Ideal for busy checkout counters and fast scanning" : "مناسب لنقاط البيع المزدحمة والبيع السريع بتركيز مستمر"}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setBarcodeDevice('manual')}
                    className={cn(
                      "flex flex-col items-start p-3 rounded-xl border text-start transition-colors cursor-pointer",
                      barcodeDevice === 'manual'
                        ? "border-primary bg-primary/10 shadow-xs"
                        : "border-border/60 bg-card hover:bg-muted/40"
                    )}
                  >
                    <div className="flex items-center justify-between w-full mb-1.5">
                      <div className={cn(
                        "w-7 h-7 rounded-lg flex items-center justify-center",
                        barcodeDevice === 'manual' ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                      )}>
                        <Keyboard className="w-4 h-4" />
                      </div>
                      {barcodeDevice === 'manual' && <Check className="w-4 h-4 text-primary" />}
                    </div>
                    <span className="text-xs font-bold text-foreground block">{isEn ? "Manual Entry & Search" : "إدخال وبحث يدوي"}</span>
                    <span className="text-[10px] text-muted-foreground mt-0.5">
                      {isEn ? "For stores searching by name/SKU without barcode labels" : "للمحلات التي تبحث بالاسم والرمز أو لا تعتمد باركود للأصناف"}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* STEP 5: الشركاء ورأس المال */}
          {step === 5 && (
            <div className="space-y-5 animate-in fade-in duration-200">
              <div>
                <h2 className="text-base sm:text-lg font-bold text-foreground flex items-center gap-2">
                  <Users className="w-5 h-5 text-primary" />
                  {isEn ? "Partners & Capital Management" : "إدارة الشركاء ورأس المال"}
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {isEn ? "Specify whether you have capital/profit partners so the system distributes shares automatically" : "حدد ما إذا كان لديك شركاء في رأس المال والأرباح ليقوم النظام بتوزيعها تلقائياً"}
                </p>
              </div>

              {/* Has Partners Toggle */}
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setHasPartners('no')}
                  className={cn(
                    "flex items-center justify-between p-3.5 rounded-xl border-2 transition-colors cursor-pointer",
                    hasPartners === 'no'
                      ? "border-primary bg-primary/10 shadow-xs"
                      : "border-border/60 bg-muted/30 hover:bg-muted/50"
                  )}
                >
                  <span className="text-xs font-bold text-foreground">{isEn ? "Solo Store (No Partners)" : "متجر فردي (لا يوجد شركاء)"}</span>
                  {hasPartners === 'no' && <Check className="w-4 h-4 text-primary" />}
                </button>

                <button
                  type="button"
                  onClick={() => setHasPartners('yes')}
                  className={cn(
                    "flex items-center justify-between p-3.5 rounded-xl border-2 transition-colors cursor-pointer",
                    hasPartners === 'yes'
                      ? "border-primary bg-primary/10 shadow-xs"
                      : "border-border/60 bg-muted/30 hover:bg-muted/50"
                  )}
                >
                  <span className="text-xs font-bold text-foreground">{isEn ? "Partnership (Multiple Partners)" : "يوجد شركاء في المحل"}</span>
                  {hasPartners === 'yes' && <Check className="w-4 h-4 text-primary" />}
                </button>
              </div>

              {/* Partners list if enabled */}
              {hasPartners === 'yes' && (
                <div className="space-y-3 pt-2 border-t border-border/50 animate-in fade-in duration-150">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-foreground">{isEn ? "Partners & Profit Shares" : "قائمة الشركاء والحصص"}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs gap-1 rounded-lg"
                      onClick={handleAddPartner}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      {isEn ? "Add Partner" : "إضافة شريك"}
                    </Button>
                  </div>

                  <div className="space-y-2.5">
                    {partners.map((partner, index) => (
                      <div
                        key={partner.id}
                        className="p-3 bg-muted/30 border border-border/60 rounded-xl space-y-2"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-primary">{isEn ? `Partner #${index + 1}` : `شريك #${index + 1}`}</span>
                          {partners.length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleRemovePartner(partner.id)}
                              className="text-destructive hover:opacity-80 p-1"
                              title={isEn ? "Remove Partner" : "حذف الشريك"}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                          <div className="space-y-1">
                            <label className="text-[10px] text-muted-foreground">{isEn ? "Partner Name:" : "اسم الشريك:"}</label>
                            <Input
                              value={partner.name}
                              onChange={(e) => handlePartnerChange(partner.id, 'name', e.target.value)}
                              placeholder={isEn ? "Full name" : "الاسم الكامل"}
                              className="h-8 text-xs"
                            />
                          </div>

                          <div className="space-y-1">
                            <label className="text-[10px] text-muted-foreground">{isEn ? "Phone Number:" : "رقم الهاتف:"}</label>
                            <Input
                              value={partner.phone}
                              onChange={(e) => handlePartnerChange(partner.id, 'phone', e.target.value)}
                              placeholder="09..."
                              className="h-8 text-xs"
                            />
                          </div>

                          <div className="space-y-1">
                            <label className="text-[10px] text-muted-foreground">{isEn ? "Capital ($):" : "رأس المال ($):"}</label>
                            <Input
                              type="number"
                              value={partner.capital || ''}
                              onChange={(e) => handlePartnerChange(partner.id, 'capital', Number(e.target.value))}
                              placeholder="0.00"
                              className="h-8 text-xs font-bold text-center"
                            />
                          </div>

                          <div className="space-y-1">
                            <label className="text-[10px] text-muted-foreground">{isEn ? "Profit Share (%):" : "نسبة الأرباح (%):"}</label>
                            <Input
                              type="number"
                              min="0"
                              max="100"
                              value={partner.sharePercentage || ''}
                              onChange={(e) => handlePartnerChange(partner.id, 'sharePercentage', Number(e.target.value))}
                              placeholder="50"
                              className="h-8 text-xs font-bold text-primary text-center"
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <p className="text-[11px] text-muted-foreground">
                    {isEn ? "You can later customize per-category profit shares and expense ratios from the Partners page." : "يمكنك لاحقاً تخصيص نسب مختلفة لكل صنف وتعيين نسب المصاريف بالتفصيل من صفحة الشركاء."}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* STEP 6: الخطوط وحجم الواجهة والمظهر ورصيد الصندوق الافتتاحي */}
          {step === 6 && (
            <div className="space-y-5 animate-in fade-in duration-200">
              <div>
                <h2 className="text-base sm:text-lg font-bold text-foreground flex items-center gap-2">
                  <Palette className="w-5 h-5 text-primary" />
                  {isEn ? "Appearance & Opening Cashbox Balance" : "المظهر العام ورصيد الصندوق الافتتاحي"}
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {isEn ? "Choose your preferred font, display size, and opening cash balance to start selling right away" : "اختر الخط المناسب، حجم العرض المريح، ورصيد الكاش الافتتاحي لبدء العمل فوراً"}
                </p>
              </div>

              {/* تنبيه ربط تيليجرام لاستعادة كلمة المرور */}
              <TelegramLinkCard />

              {/* Font Family Selector */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-foreground">
                  {isEn ? "Preferred Arabic Font" : "نوع الخط العربي المفضل"}
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {APP_FONTS.map((f) => {
                    const isSelected = selectedFont === f.id;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setSelectedFont(f.id)}
                        className={cn(
                          "py-2.5 px-3 rounded-xl border text-start transition-colors flex items-center justify-between cursor-pointer",
                          isSelected
                            ? "border-primary bg-primary/10 shadow-xs ring-1 ring-primary/30"
                            : "border-border/60 bg-card hover:bg-muted/40"
                        )}
                        style={{ fontFamily: f.cssFamily }}
                      >
                        <div className="truncate">
                          <span className="text-xs font-bold text-foreground block">{isEn ? f.name : f.nameAr}</span>
                          <span className="text-[10px] text-muted-foreground block opacity-80">{isEn ? f.nameAr : f.name}</span>
                        </div>
                        {isSelected && <Check className="w-4 h-4 text-primary shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* UI Scale Selector */}
              <div className="space-y-2 pt-2 border-t border-border/50">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-foreground">
                    {isEn ? "Font & Interface Size" : "حجم الخط والواجهة"}
                  </label>
                  <span className="text-xs font-bold text-primary font-mono">
                    {UI_SCALE_OPTIONS.find(o => o.id === selectedScale)?.percentage}%
                  </span>
                </div>

                <div className="grid grid-cols-5 gap-1.5">
                  {UI_SCALE_OPTIONS.map((scale) => {
                    const isSelected = selectedScale === scale.id;
                    return (
                      <button
                        key={scale.id}
                        type="button"
                        onClick={() => setSelectedScale(scale.id)}
                        className={cn(
                          "py-2 px-1 rounded-xl border text-center transition-[colors,transform] cursor-pointer",
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground font-bold shadow-xs scale-[1.02]"
                            : "border-border/60 bg-card text-foreground hover:bg-muted/40"
                        )}
                      >
                        <span className="text-xs font-bold block">{scale.percentage}%</span>
                        <span className="text-[9px] block opacity-80 truncate">{(isEn ? scale.labelEn : scale.labelAr).split(' ')[0]}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Theme Mode Selector (Dark / Light) */}
              <div className="space-y-2 pt-2 border-t border-border/50">
                <label className="text-xs font-bold text-foreground">
                  {isEn ? "Theme Mode" : "نمط المظهر"}
                </label>
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setDraftThemeMode('light')}
                    className={cn(
                      "flex items-center justify-center gap-2.5 py-3 px-4 rounded-xl border-2 transition-colors cursor-pointer",
                      themeMode === 'light'
                        ? "border-primary bg-primary/10 shadow-xs"
                        : "border-border/60 bg-muted/40 hover:bg-muted/70"
                    )}
                  >
                    <div className={cn(
                      "w-7 h-7 rounded-lg flex items-center justify-center",
                      themeMode === 'light' ? "bg-primary text-primary-foreground" : "bg-muted-foreground/20 text-muted-foreground"
                    )}>
                      <Sun className="w-4 h-4" />
                    </div>
                    <span className="text-xs font-bold text-foreground">{isEn ? "Light Mode" : "الوضع النهاري"}</span>
                    {themeMode === 'light' && <Check className="w-4 h-4 text-primary ms-auto" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => setDraftThemeMode('dark')}
                    className={cn(
                      "flex items-center justify-center gap-2.5 py-3 px-4 rounded-xl border-2 transition-colors cursor-pointer",
                      themeMode === 'dark'
                        ? "border-primary bg-primary/10 shadow-xs"
                        : "border-border/60 bg-muted/40 hover:bg-muted/70"
                    )}
                  >
                    <div className={cn(
                      "w-7 h-7 rounded-lg flex items-center justify-center",
                      themeMode === 'dark' ? "bg-primary text-primary-foreground" : "bg-muted-foreground/20 text-muted-foreground"
                    )}>
                      <Moon className="w-4 h-4" />
                    </div>
                    <span className="text-xs font-bold text-foreground">{isEn ? "Dark Mode" : "الوضع الليلي"}</span>
                    {themeMode === 'dark' && <Check className="w-4 h-4 text-primary ms-auto" />}
                  </button>
                </div>
              </div>

              {/* بطاقة رصيد الصندوق الافتتاحي وبدء أول وردية */}
              <div className="p-4 rounded-2xl bg-primary/5 border border-primary/20 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                      <DollarSign className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-foreground">{isEn ? "Start First Shift & Opening Cashbox Balance" : "بدء أول وردية ورصيد الصندوق الافتتاحي"}</p>
                      <p className="text-[11px] text-muted-foreground">{isEn ? "Starting cash float in the cashier drawer" : "رصيد الفكة / الصرافة الافتتاحي في درج الكاشير"}</p>
                    </div>
                  </div>
                  <Switch
                    checked={openFirstShift}
                    onCheckedChange={setOpenFirstShift}
                    className="data-[state=checked]:bg-primary shrink-0"
                  />
                </div>

                {openFirstShift && (
                  <div className="pt-2 border-t border-primary/10 flex items-center justify-between gap-3 animate-in fade-in duration-150">
                    <label className="text-xs font-bold text-foreground shrink-0">
                      {isEn ? "Opening Cashbox Amount:" : "المبلغ الافتتاحي في الصندوق:"}
                    </label>
                    <div className="flex items-center gap-1.5 w-36">
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        value={openingCash}
                        onChange={(e) => setOpeningCash(e.target.value)}
                        placeholder="0.00"
                        className="h-9 text-xs font-bold text-center bg-background"
                      />
                      <span className="text-xs font-bold text-primary">$</span>
                    </div>
                  </div>
                )}

                <p className="text-[11px] text-muted-foreground">
                  {isEn ? "Your first cashier shift will start automatically with this balance so POS is ready immediately." : "سيتم بدء أول وردية كاشير تلقائياً بهذا الرصيد لتكون شاشة البيع جاهزة فوراً."}
                </p>
              </div>

            </div>
          )}

        </div>

        {/* Footer Navigation Bar */}
        <div className="p-4 sm:p-6 bg-muted/30 border-t border-border/60 flex flex-col sm:flex-row items-center justify-between gap-3 flex-shrink-0">
          {/* Back button */}
          <div className="w-full sm:w-auto flex items-center gap-2">
            {isAlreadySetup && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => onComplete()}
                className="w-full sm:w-auto h-10 px-4 rounded-xl text-xs font-semibold text-muted-foreground hover:text-foreground cursor-pointer"
              >
                {isEn ? "Close Preview" : "إغلاق المعاينة"}
              </Button>
            )}
            {step > 1 && (
              <Button
                type="button"
                variant="outline"
                disabled={isSaving || phoneChecking}
                onClick={() => setStep(step - 1)}
                className="w-full sm:w-auto h-10 px-5 rounded-xl text-xs font-bold cursor-pointer"
              >
                {isRTL ? <ArrowRight className="w-4 h-4" /> : <ArrowLeft className="w-4 h-4" />}
                {isEn ? "Back" : "السابق"}
              </Button>
            )}
          </div>

          {/* Forward / Finish buttons */}
          <div className="w-full sm:w-auto flex flex-wrap items-center gap-2">
            {step === lastRequiredStep && (
              <Button type="button" className="flex-1 sm:flex-none" disabled={isSaving} onClick={() => void finishSetup()}>
                {isSaving ? (isEn ? 'Saving…' : 'جارٍ الحفظ…') : (isEn ? 'Save & Start Selling' : 'حفظ وبدء البيع')}
              </Button>
            )}
            {step > lastRequiredStep && (
              <Button type="button" variant="ghost" disabled={isSaving}
                onClick={() => step === totalSteps ? void finishSetup() : goToNextStep(false)}>
                {step === totalSteps ? (isEn ? 'Skip & Start Selling' : 'تخطّي وبدء البيع') : (isEn ? 'Skip This Step' : 'تخطّي هذه الخطوة')}
              </Button>
            )}
            {step < totalSteps ? (
              <Button
                type="button"
                disabled={phoneChecking || isSaving}
                onClick={async () => {
                  if (step === 1 && (!phoneClaimedFor || phoneClaimedFor !== storePhone.trim())) {
                    const phone = storePhone.trim();
                    if (!phone) {
                      toast.error(isEn ? 'Phone number is required' : 'رقم الهاتف إلزامي', { description: isEn ? 'Enter your phone number to finish account setup.' : 'أدخل رقم هاتفك لإكمال إنشاء الحساب.' });
                      return;
                    }
                    if (!isValidSignupPhone(phone)) {
                      toast.error(isEn ? 'Invalid phone number' : 'رقم الهاتف غير صالح', { description: isEn ? 'Digits only (9 to 15 digits).' : 'أرقام فقط (من 9 إلى 15 رقماً).' });
                      return;
                    }
                    setPhoneChecking(true);
                    const res = await claimAccountPhone(phone);
                    setPhoneChecking(false);
                    if (res.kind === 'needs_telegram') {
                      toast.warning(isEn ? 'This number is used by another account' : 'هذا الرقم مستخدم في حساب آخر', { description: isEn ? 'A verification code sent to the original account Telegram is required.' : 'يلزم رمز تأكيد يصل إلى تيليجرام الحساب الأصلي.' });
                      setPhoneTelegramOpen(true);
                      return;
                    }
                    if (res.kind === 'conflict') {
                      toast.error(isEn ? 'Number already used by another account' : 'الرقم مستخدم في حساب آخر', { description: res.message });
                      return;
                    }
                    if (res.kind === 'error') {
                      toast.error(isEn ? 'Could not verify phone number' : 'تعذّر التحقق من الرقم', { description: res.message.slice(0, 160) });
                      return;
                    }
                    setPhoneClaimedFor(phone);
                  }
                  goToNextStep();
                }}
                className="flex-1 sm:flex-none h-10 px-4 rounded-xl text-xs font-bold"
                variant={step === lastRequiredStep ? 'outline' : 'default'}
              >
                {step === lastRequiredStep ? (isEn ? 'Optional Settings' : 'الإعدادات الاختيارية') : (isEn ? 'Next' : 'التالي')}
                {isRTL ? <ArrowLeft className="w-4 h-4" /> : <ArrowRight className="w-4 h-4" />}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={isSaving}
                onClick={() => void finishSetup(true)}
                className="w-full sm:w-auto h-10 px-5 rounded-xl text-xs font-bold"
              >
                {isSaving ? (isEn ? 'Saving…' : 'جارٍ الحفظ…') : (isEn ? 'Save & Start Selling' : 'حفظ وبدء البيع')}
              </Button>
            )}
          </div>
        </div>

        <StorePhoneVerificationDialog
          open={phoneTelegramOpen}
          onOpenChange={setPhoneTelegramOpen}
          phone={storePhone.trim()}
          status="requires_telegram_verification"
          onSuccess={() => {
            setPhoneClaimedFor(storePhone.trim());
            setVisitedSteps(prev => new Set([...prev, 2]));
            setStep(2);
          }}
        />
      </div>
    </div>
  );
}
