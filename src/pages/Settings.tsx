import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';

import appIconUrl from '@/assets/app-icon.png'; // bundled: يعمل على file:// في نسخة الكمبيوتر


const ActivityArchiveSection = lazy(() => import('@/components/settings/ActivityArchiveSection').then(m => ({ default: m.ActivityArchiveSection })));

const SystemDiagnostics = lazy(() => import('@/components/settings/SystemDiagnostics').then(m => ({ default: m.SystemDiagnostics })));

const LocalBackupSection = lazy(() => import('@/components/settings/LocalBackupSection').then(m => ({ default: m.LocalBackupSection })));

const Partners = lazy(() => import('@/pages/Partners'));

const LicenseManagement = lazy(() => import('@/components/settings/LicenseManagement').then(m => ({ default: m.LicenseManagement })));

const DataResetSection = lazy(() => import('@/components/settings/DataResetSection'));

const ContactLinksSection = lazy(() => import('@/components/settings/ContactLinksSection').then(m => ({ default: m.ContactLinksSection })));

const ProductFieldsSection = lazy(() => import('@/components/settings/ProductFieldsSection').then(m => ({ default: m.ProductFieldsSection })));

const UsersTab = lazy(() => import('@/components/settings/UsersTab'));
const StoreInfoSection = lazy(() => import('@/components/settings/StoreInfoSection'));
const FinanceSettingsSection = lazy(() => import('@/components/settings/FinanceSettingsSection'));
const PrinterSettingsSection = lazy(() => import('@/components/settings/PrinterSettingsSection'));
const BackupSettingsSection = lazy(() => import('@/components/settings/BackupSettingsSection'));
import { Coins, Undo2, Smartphone, UserCheck, Users, ArrowLeft, ArrowRight, Sparkles, ShoppingCart, SlidersHorizontal, LayoutGrid, List, ChevronLeft, ChevronRight } from 'lucide-react';
import { NOTIFICATION_EVENT_GROUPS, getDefaultNotificationEvents } from '@/lib/notification-events-config';

import {
  Search,
  Store,
  DollarSign,
  RefreshCw,
  Bell,
  Printer,
  Bluetooth,
  Laptop,
  Unlink,
  Database,
  Save,
  User,
  Mail,
  Phone,
  MapPin,
  Plus,
  Edit,
  Trash2,
  Download,
  Upload,
  Check,
  X,
  Eye,
  EyeOff,
  Volume2,
  VolumeX,
  FileText,
  Clock,
  Shield,
  AlertCircle,
  CheckCircle2,
  Cloud,
  Globe,
  Loader2,
  Activity,
  Key,
  FileUp,
  Lock,
  Banknote,
  Package,
  AlertTriangle,
  ExternalLink,
  Wrench,
  Archive,
  Percent,
  Wallet
} from 'lucide-react';
import { downloadJSON, isNativePlatform, listNativeBackups, NativeBackupFile, DownloadResult } from '@/lib/file-download';
import { LanguageSection } from '@/components/settings/LanguageSection';
import { isValidAppFontId, setStoredAppFont, APP_FONT_STORAGE_KEY } from '@/lib/app-font-config';
// ThemeSection integrated as a tab
import { ActivationCodeInput } from '@/components/settings/ActivationCodeInput';
import { ProductFieldsConfig, loadProductFieldsConfig, saveProductFieldsConfig, getDefaultFieldsByStoreType, StoreType } from '@/lib/product-fields-config';
import { loadCustomFields } from '@/lib/custom-fields-config';
import { PREDEFINED_CURRENCIES, CURRENCY_CATEGORIES, detectCurrencyCodeFromMeta, loadNormalizedCurrencySettings, normalizeCurrencySettings } from '@/lib/currencies';
import { getDefaultCategories } from '@/lib/store-type-config';
import { saveCategories, Category } from '@/lib/categories-store';
import { ProfileManagement } from '@/components/settings/ProfileManagement';
import {
  printHTML,
  PrinterConfig,
  BluetoothDevice,
  getStoredPrinterConfig,
  saveStoredPrinterConfig,
  searchBluetoothPrinters,
  connectAndTestBluetoothPrinter,
  isBluetoothSupported,
} from '@/lib/native-print';
import {
  PosFlowPrinter,
  isNativeAndroid,
} from '@/lib/printer/posflow-printer';
import {
  clearSelectedPrinter,
  printTestPage,
  describePrinterError,
} from '@/lib/printer/bluetooth-printer';
import { BluetoothPrinterDialog, PRINTER_FLOW_FLAG } from '@/components/printer/BluetoothPrinterDialog';
import type { PaperWidth } from '@/lib/printer/receipt-escpos';
import { checkNotificationPermissionNative, requestNotificationPermissionNative, sendLocalNotification } from '@/lib/native-notifications';
import { cn, formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useLicense } from '@/hooks/use-license';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { StorePhoneVerificationDialog } from '@/components/settings/StorePhoneVerificationDialog';
import { RestoreWarningDialog } from '@/components/settings/RestoreWarningDialog';
import { TelegramLinkCard } from '@/components/auth/TelegramLinkCard';
import { showToast } from '@/lib/toast-config';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/hooks/use-language';

import { useAuth } from '@/hooks/use-auth';
import { useUserRole } from '@/hooks/use-user-role';
import { isGuestDemoMode } from '@/lib/demo-data';
import { emitEvent, EVENTS } from '@/lib/events';
import { saveStoreSettings, fetchStoreSettings } from '@/lib/supabase-store';
import {
  loadUnifiedStoreSettings,
  mergeStoreSettings,
  applySettingsToRuntime,
  saveUnifiedStoreSettings,
  pullStoreSettingsWithGuard,
  StoreSettingsSaveStatus,
} from '@/lib/store-settings-sync';
import { useNavigate, useSearchParams, Navigate } from 'react-router-dom';
import { FeatureErrorBoundary } from '@/components/debug/FeatureErrorBoundary';
import type { LucideIcon } from 'lucide-react';
import type { TranslationKey } from '@/lib/i18n';
import { PageHeader } from '@/components/layout/PageHeader';

export interface SettingsTabItem {
  id: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  bossOnly?: boolean;
  danger?: boolean;
  description?: string;
  category?: 'core' | 'operations' | 'support';
  badge?: string;
  color?: string;
  keywords?: string[];
}

const SETTINGS_STORAGE_KEY = 'posflow_settings_v1';

// Type-safe settings interfaces
interface SyncSettingsType {
  interval: number;
  showSuccessNotification: boolean;
  showErrorNotification: boolean;
  showSyncStatus: boolean;
  lastSync: string;
  trackCapital?: boolean;
  initialCapital?: number;
}

interface NotificationSettingsType {
  masterEnabled: boolean; // مفتاح الإشعارات الرئيسي الشامل
  sound: boolean;
  newSale: boolean;
  lowStock: boolean;
  newDebt: boolean;
  paymentReceived: boolean;
  dailyReport: boolean;
  durationSeconds?: number; // وقت بقاء الإشعار بالثواني (0.5 إلى 3.0)
  events?: Record<string, boolean>; // مفاتيح أحداث الإشعارات المخصصة
}

interface PrintSettingsType {
  autoPrint: boolean;
  showLogo: boolean;
  showAddress: boolean;
  showPhone: boolean;
  paperSize: string;
  copies: string;
  footer: string;
  showStoreName?: boolean;
  showEmail?: boolean;
  showInvoiceNumber?: boolean;
  showDateTime?: boolean;
  showCashierName?: boolean;
  welcomeMessage?: string;
  showAlternativeCurrencies?: boolean;
}

interface BackupSettingsType {
  autoBackup: boolean;
  interval: string;
  keepDays: string;
}

export interface PersistedSettings {
  primaryCurrency?: string;
  slot1Code?: string;
  slot2Code?: string;
  enabledCurrencies?: Record<string, boolean>;
  storeSettings?: Partial<{ name: string; type: string; phone: string; email: string; address: string; logo: string }>;
  exchangeRates?: Record<string, string | number>;
  currencyNames?: Record<string, string>;
  currencySymbols?: Record<string, string>;
  currencyDisplayMode?: Record<string, 'symbol' | 'name' | 'both'>;
  syncSettings?: Partial<SyncSettingsType>;
  notificationSettings?: Partial<NotificationSettingsType>;
  printSettings?: Partial<PrintSettingsType>;
  backupSettings?: Partial<BackupSettingsType>;
  currencySymbol?: string;
  hideMaintenanceSection?: boolean;
  taxEnabled?: boolean;
  taxRate?: number;
  discountPercentEnabled?: boolean;
  discountFixedEnabled?: boolean;
  barcodeScanMode?: 'search' | 'add';
  trackCapital?: boolean;
  initialCapital?: number;
};

const sanitizeNumberText = (value: string) => {
  if (!value) return '';
  let normalized = value.replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660));
  normalized = normalized.replace(/[\u06f0-\u06f9]/g, d => String(d.charCodeAt(0) - 0x06f0));
  normalized = normalized.replace(/[,\u060c\u066b]/g, '.');
  normalized = normalized.replace(/[^\d.]/g, '');
  const parts = normalized.split('.');
  return parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : normalized;
};

const loadPersistedSettings = (): PersistedSettings | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as PersistedSettings) : null;
  } catch (error) {
    console.error('Failed to load settings:', error);
    return null;
  }
};

const savePersistedSettings = (data: PersistedSettings): boolean => {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(data));
    // Emit standardized event so other components update in same-tab
    emitEvent(EVENTS.SETTINGS_UPDATED, data);
    return true;
  } catch (error) {
    console.error('Failed to save settings:', error);
    return false;
  }
};

// UserData interface is now imported from use-users-management hook

interface BackupData {
  id: string;
  date: string;
  size: string;
  type: 'auto' | 'manual';
}

export default function Settings() {
  const licenseState = useLicense();
  const { toast } = useToast();
  const [phoneVerificationOpen, setPhoneVerificationOpen] = useState(false);
  const [phoneVerificationStatus, setPhoneVerificationStatus] = useState<'available' | 'requires_telegram_verification'>('available');
  const { t, isRTL } = useLanguage();
  const { user: currentUser } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab');



  const [searchQuery, setSearchQuery] = useState('');
  const [settingsLayout, setSettingsLayout] = useState<'grid' | 'list'>(() => {
    try {
      return (localStorage.getItem('settings_layout_mode') as 'grid' | 'list') || 'grid';
    } catch {
      return 'grid';
    }
  });

  const handleLayoutChange = (mode: 'grid' | 'list') => {
    setSettingsLayout(mode);
    try {
      localStorage.setItem('settings_layout_mode', mode);
      void saveUnifiedStoreSettings({ appearanceSettings: { settingsLayout: mode } });
    } catch {
      // ignore storage errors
    }
  };
  const setActiveTab = (tabId: string | null) => {
    if (tabId) {
      setSearchParams({ tab: tabId });
    } else {
      setSearchParams({});
    }
    window.scrollTo({ top: 0 });
  };
  const [isSavingUser, setIsSavingUser] = useState(false);
  const navigate = useNavigate();
  const { isBoss, isAdmin: isOwnerAdmin } = useUserRole();

  // Boss panel password verification
  const [bossPassword, setBossPassword] = useState('');
  const [showBossPassword, setShowBossPassword] = useState(false);
  const [bossPasswordError, setBossPasswordError] = useState('');
  const [isVerifyingBossPassword, setIsVerifyingBossPassword] = useState(false);

  const handleOpenBossPanel = async () => {
    if (!bossPassword || !currentUser?.email) return;
    setIsVerifyingBossPassword(true);
    setBossPasswordError('');
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: currentUser.email,
        password: bossPassword,
      });
      if (error) {
        setBossPasswordError(t('auth.invalidCredentials') || 'كلمة المرور غير صحيحة');
      } else {
        setBossPassword('');
        navigate('/boss');
      }
    } catch {
      setBossPasswordError('حدث خطأ أثناء التحقق');
    } finally {
      setIsVerifyingBossPassword(false);
    }
  };

  const persisted = loadPersistedSettings();
  const initialUnified = loadUnifiedStoreSettings();

  // ✅ البدء فوراً كجاهز من الكاش المحلي دون أي حظر أو انتظار للشبكة
  const [isSettingsReady, setIsSettingsReady] = useState(true);
  const [lastSaveStatus, setLastSaveStatus] = useState<StoreSettingsSaveStatus | null>(null);

  // Store settings
  const [storeSettings, setStoreSettings] = useState({
    name: initialUnified?.storeSettings?.name ?? (persisted?.storeSettings?.name ?? ''),
    type: initialUnified?.storeSettings?.type ?? (persisted?.storeSettings?.type ?? 'phones'),
    phone: initialUnified?.storeSettings?.phone ?? (persisted?.storeSettings?.phone ?? ''),
    email: initialUnified?.storeSettings?.email ?? (persisted?.storeSettings?.email ?? ''),
    address: initialUnified?.storeSettings?.address ?? (persisted?.storeSettings?.address ?? ''),
    logo: initialUnified?.storeSettings?.logo ?? (persisted?.storeSettings?.logo ?? ''),
  });

  // Tax settings
  const [taxEnabled, setTaxEnabled] = useState(initialUnified?.taxEnabled ?? (persisted?.taxEnabled ?? false));
  const [taxRate, setTaxRate] = useState(initialUnified?.taxRate ?? (persisted?.taxRate ?? 0));

  // Discount control settings
  const [discountPercentEnabled, setDiscountPercentEnabled] = useState(initialUnified?.discountPercentEnabled ?? (persisted?.discountPercentEnabled ?? true));
  const [discountFixedEnabled, setDiscountFixedEnabled] = useState(initialUnified?.discountFixedEnabled ?? (persisted?.discountFixedEnabled ?? true));
  const [barcodeScanMode, setBarcodeScanMode] = useState<'search' | 'add'>(initialUnified?.barcodeScanMode ?? (persisted?.barcodeScanMode ?? 'search'));

  // Capital tracking settings
  const [trackCapital, setTrackCapital] = useState<boolean>(
    initialUnified?.trackCapital ?? (persisted?.trackCapital ?? (persisted?.syncSettings?.trackCapital ?? false))
  );
  const [initialCapital, setInitialCapital] = useState<number>(
    initialUnified?.initialCapital ?? (persisted?.initialCapital ?? (persisted?.syncSettings?.initialCapital ?? 0))
  );

  const [notificationPerm, setNotificationPerm] = useState<string>('prompt');

  // التحقق الحقيقي من إذن الإشعارات الأصلي عند تحميل الإعدادات
  useEffect(() => {
    checkNotificationPermissionNative().then(status => {
      setNotificationPerm(status);
    }).catch(() => {});
  }, []);

  const handleRequestNotificationPermission = async () => {
    try {
      const status = await requestNotificationPermissionNative();
      setNotificationPerm(status);

      if (status === 'granted') {
        localStorage.setItem('posflow_notifications_enabled', 'true');
        toast({ title: '✓ تم تفعيل الإشعارات بنجاح', description: 'ستصلك تنبيهات المبيعات والديون ونفاذ المخزون' });
        // إرسال إشعار تجريبي فوري حقيقي في شريط الإشعارات
        await sendLocalNotification('PosFlow', '🎉 تنبيه تجريبي: نظام الإشعارات يعمل بنجاح!');
      } else {
        toast({
          title: 'تنبيه الأذونات',
          description: 'يرجى السماح بالإشعارات للتطبيق من إعدادات الهاتف (التطبيقات > PosFlow > الإشعارات)',
          variant: 'destructive'
        });
      }
    } catch (err) {
      console.error('Error requesting notification permission:', err);
      toast({ title: 'تنبيه', description: 'يرجى مراجعة إعدادات الإشعارات في جهازك', variant: 'destructive' });
    }
  };

  const handleSendTestNotification = async () => {
    const success = await sendLocalNotification('PosFlow', '🎉 تنبيه تجريبي: نظام الإشعارات يعمل بنجاح!');
    if (success) {
      toast({
        title: '🎉 تم إرسال الإشعار التجريبي',
        description: 'تحقق من شريط إشعارات الهاتف في الأعلى',
      });
    } else {
      toast({
        title: '⚠️ لم يتم إرسال الإشعار',
        description: 'تأكد من تفعيل إذن الإشعارات للتطبيق في إعدادات الهاتف',
        variant: 'destructive',
      });
    }
  };

  // Logo upload handler
  const handleLogoUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('image/')) {
        toast({
          title: t('common.error'),
          description: t('settings.invalidImageType'),
          variant: 'destructive',
        });
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        toast({
          title: t('common.error'),
          description: t('settings.imageTooLarge'),
          variant: 'destructive',
        });
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result as string;
        setStoreSettings(prev => ({ ...prev, logo: base64 }));
        toast({
          title: t('common.success'),
          description: t('settings.logoUploaded'),
        });
      };
      reader.readAsDataURL(file);
    }
  };

  const handleRemoveLogo = () => {
    setStoreSettings(prev => ({ ...prev, logo: '' }));
    toast({
      title: t('common.deleted'),
      description: t('settings.logoRemoved'),
    });
  };

  // Dynamic currency states (Slot 1 & Slot 2 with real codes)
  const initialNormalized = useMemo(() => loadNormalizedCurrencySettings(), []);

  const [slot1Code, setSlot1Code] = useState<string>(() => {
    const s1Saved = persisted?.slot1Code || initialUnified?.slot1Code;
    if (s1Saved && s1Saved !== 'USD') return s1Saved;
    const enabledMap = initialUnified?.enabledCurrencies || persisted?.enabledCurrencies || {};
    const namesMap = initialUnified?.currencyNames || persisted?.currencyNames || {};
    const symbolsMap = initialUnified?.currencySymbols || persisted?.currencySymbols || {};
    const ratesMap = initialUnified?.exchangeRates || persisted?.exchangeRates || {};
    const activeNonUsd = Object.keys(enabledMap).filter(c => c !== 'USD' && enabledMap[c] === true);
    const otherConfigured = Object.keys({ ...ratesMap, ...namesMap, ...symbolsMap })
      .filter(c => c !== 'USD' && !activeNonUsd.includes(c));
    const candidateCodes = [...activeNonUsd, ...otherConfigured];
    return candidateCodes[0] || '';
  });

  const [slot2Code, setSlot2Code] = useState<string>(() => {
    const s2Saved = persisted?.slot2Code || initialUnified?.slot2Code;
    if (s2Saved && s2Saved !== 'USD') return s2Saved;
    const enabledMap = initialUnified?.enabledCurrencies || persisted?.enabledCurrencies || {};
    const namesMap = initialUnified?.currencyNames || persisted?.currencyNames || {};
    const symbolsMap = initialUnified?.currencySymbols || persisted?.currencySymbols || {};
    const ratesMap = initialUnified?.exchangeRates || persisted?.exchangeRates || {};
    const activeNonUsd = Object.keys(enabledMap).filter(c => c !== 'USD' && enabledMap[c] === true);
    const otherConfigured = Object.keys({ ...ratesMap, ...namesMap, ...symbolsMap })
      .filter(c => c !== 'USD' && !activeNonUsd.includes(c));
    const candidateCodes = [...activeNonUsd, ...otherConfigured];
    const s1Candidate = candidateCodes[0] || '';
    return candidateCodes.find(c => c !== s1Candidate) || '';
  });

  const [primaryCurrency, setPrimaryCurrency] = useState<string>(
    initialUnified?.primaryCurrency || persisted?.primaryCurrency || initialNormalized.primaryCurrencyCode || 'USD'
  );

  const [enabledCurrencies, setEnabledCurrencies] = useState<Record<string, boolean>>(() => {
    const base: Record<string, boolean> = {
      USD: initialUnified?.enabledCurrencies?.USD !== false && persisted?.enabledCurrencies?.USD !== false,
    };
    if (slot1Code && slot1Code !== 'USD') {
      base[slot1Code] = initialNormalized.currencies[slot1Code]?.enabled === true;
    }
    if (slot2Code && slot2Code !== 'USD' && slot2Code !== slot1Code) {
      base[slot2Code] = initialNormalized.currencies[slot2Code]?.enabled === true;
    }
    return base;
  });

  const toggleCurrency = (currency: string, enabled: boolean) => {
    const nextEnabled = {
      ...enabledCurrencies,
      [currency]: enabled,
    };

    // 1. حساب العملات النشطة الفعلية
    const activeNonUsd = [slot1Code, slot2Code].filter(code => code && nextEnabled[code] === true);
    
    // إذا عطل المستخدم كل العملات بما فيها الدولار، يُجبر تفعيل الدولار تلقائياً
    if (!enabled && activeNonUsd.length === 0 && nextEnabled.USD === false) {
      nextEnabled.USD = true;
    }

    // 2. إدارة الانتقال التلقائي للعملة الافتراضية
    let newPrimary = primaryCurrency;
    if (!enabled && primaryCurrency === currency) {
      // إذا عطلنا العملة الافتراضية الحالية، ننتقل للعملة المفعلة التالية:
      if (currency !== 'USD' && nextEnabled[slot1Code] && slot1Code !== currency) {
        newPrimary = slot1Code;
      } else if (currency !== 'USD' && nextEnabled[slot2Code] && slot2Code !== currency) {
        newPrimary = slot2Code;
      } else {
        // إذا عطل العملتين الافتراضيتين أو لم يتبق بديل: يتحول حتماً وتلقائياً إلى الدولار
        newPrimary = 'USD';
        nextEnabled.USD = true; // ضمان تفعيل الدولار
      }
      setPrimaryCurrency(newPrimary);
    } else if (primaryCurrency === currency && !enabled) {
      newPrimary = 'USD';
      nextEnabled.USD = true;
      setPrimaryCurrency('USD');
    }

    setEnabledCurrencies(nextEnabled);

    // 3. تطهير الكائن المحفوظ ليقتصر فقط على العملات الحقيقية الثلاث
    const sanitizedEnabled: Record<string, boolean> = {
      USD: nextEnabled.USD !== false,
    };
    if (slot1Code) sanitizedEnabled[slot1Code] = nextEnabled[slot1Code] === true;
    if (slot2Code) sanitizedEnabled[slot2Code] = nextEnabled[slot2Code] === true;

    const persistedSettings = loadPersistedSettings() || {};
    const updated = {
      ...persistedSettings,
      slot1Code,
      slot2Code,
      enabledCurrencies: sanitizedEnabled,
      primaryCurrency: newPrimary,
    };

    savePersistedSettings(updated as PersistedSettings);

    saveUnifiedStoreSettings({
      updatedAt: Date.now(),
      slot1Code,
      slot2Code,
      enabledCurrencies: sanitizedEnabled,
      primaryCurrency: newPrimary,
    }).catch(e => console.warn('[Settings] toggleCurrency unified save error:', e));

    emitEvent(EVENTS.SETTINGS_UPDATED, updated);
  };

  const [exchangeRates, setExchangeRates] = useState<Record<string, string>>(() => {
    const base: Record<string, string> = {};
    for (const [code, c] of Object.entries(initialNormalized.currencies)) {
      base[code] = String(c.rate);
    }
    return base;
  });

  const [currencyNames, setCurrencyNames] = useState<Record<string, string>>(() => {
    const base: Record<string, string> = {};
    for (const [code, c] of Object.entries(initialNormalized.currencies)) {
      base[code] = c.name;
    }
    return base;
  });

  const [currencySymbols, setCurrencySymbols] = useState<Record<string, string>>(() => {
    const base: Record<string, string> = {};
    for (const [code, c] of Object.entries(initialNormalized.currencies)) {
      base[code] = c.symbol;
    }
    return base;
  });
  const [currencyDisplayMode, setCurrencyDisplayMode] = useState<Record<string, 'symbol' | 'name' | 'both'>>(
    () => initialUnified?.currencyDisplayMode || {}
  );
  const renderCurrencyDisplayOptions = (code: string) => {
    const labels = isRTL
      ? { symbol: 'الرمز فقط', name: 'الاسم فقط', both: 'كلاهما' }
      : { symbol: 'Symbol', name: 'Name', both: 'Both' };
    const selectedMode = currencyDisplayMode[code] || 'symbol';

    return (
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-border/30 mt-2">
        <span className="text-[10px] text-muted-foreground font-medium">
          {isRTL ? 'طريقة العرض:' : 'Display:'}
        </span>
        <div className="flex items-center gap-1 rounded-lg border border-border/40 bg-muted/60 p-0.5">
          {(['symbol', 'name', 'both'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={selectedMode === mode}
              onClick={() => setCurrencyDisplayMode(prev => ({ ...prev, [code]: mode }))}
              className={cn(
                "min-h-7 rounded-md px-2 text-[9px] font-bold transition-colors",
                selectedMode === mode ? "bg-primary text-primary-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {labels[mode]}
            </button>
          ))}
        </div>
      </div>
    );
  };

  // Sync settings
  const [syncSettings, setSyncSettings] = useState({
    interval: Number(initialUnified.syncSettings?.interval ?? persisted?.syncSettings?.interval ?? 10),
    showSuccessNotification: initialUnified.syncSettings?.showSuccessNotification !== false,
    showErrorNotification: initialUnified.syncSettings?.showErrorNotification !== false,
    showSyncStatus: initialUnified.syncSettings?.showSyncStatus !== false,
    lastSync: String(initialUnified.syncSettings?.lastSync ?? persisted?.syncSettings?.lastSync ?? ''),
  });

  // Notification settings
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettingsType>(() => {
    const defaultEvts = getDefaultNotificationEvents();
    const savedEvts = persisted?.notificationSettings?.events ?? (initialUnified?.notificationSettings as any)?.events ?? {};
    return {
      masterEnabled: persisted?.notificationSettings?.masterEnabled ?? (initialUnified?.notificationSettings as any)?.masterEnabled ?? true,
      sound: persisted?.notificationSettings?.sound ?? (initialUnified?.notificationSettings as any)?.sound ?? true,
      newSale: persisted?.notificationSettings?.newSale ?? (initialUnified?.notificationSettings as any)?.newSale ?? true,
      lowStock: persisted?.notificationSettings?.lowStock ?? (initialUnified?.notificationSettings as any)?.lowStock ?? true,
      newDebt: persisted?.notificationSettings?.newDebt ?? (initialUnified?.notificationSettings as any)?.newDebt ?? true,
      paymentReceived: persisted?.notificationSettings?.paymentReceived ?? (initialUnified?.notificationSettings as any)?.paymentReceived ?? true,
      dailyReport: persisted?.notificationSettings?.dailyReport ?? (initialUnified?.notificationSettings as any)?.dailyReport ?? false,
      durationSeconds: persisted?.notificationSettings?.durationSeconds ?? (initialUnified?.notificationSettings as any)?.durationSeconds ?? 2,
      events: { ...defaultEvts, ...savedEvts },
    };
  });

  // Bluetooth & Printer Management State
  const [printerConfig, setPrinterConfig] = useState<PrinterConfig>(getStoredPrinterConfig);
  const [isPrinterConnected, setIsPrinterConnected] = useState(false);
  const [isTestingPrint, setIsTestingPrint] = useState(false);
  const [showUnpairDialog, setShowUnpairDialog] = useState(false);

  // Add Bluetooth Printer Dialog state
  const [showBtDialog, setShowBtDialog] = useState<boolean>(
    () => sessionStorage.getItem(PRINTER_FLOW_FLAG) === 'await_bt'
  );

  useEffect(() => {
    if (printerConfig.connectionType === 'bluetooth' && printerConfig.deviceAddress && isNativeAndroid()) {
      PosFlowPrinter.isConnected().then((r) => setIsPrinterConnected(Boolean(r?.connected))).catch(() => setIsPrinterConnected(false));
    }
  }, [printerConfig.connectionType, printerConfig.deviceAddress]);

  const handleUpdatePrinterConfig = (updates: Partial<PrinterConfig>) => {
    const next = { ...printerConfig, ...updates };
    setPrinterConfig(next);
    saveStoredPrinterConfig(next);
    toast({
      title: t('common.saved'),
      description: isRTL ? 'تم حفظ إعدادات الطابعة بنجاح' : 'Printer settings updated',
    });
  };

  const handleMainTestPrint = async () => {
    if (!printerConfig.deviceAddress) return;
    setIsTestingPrint(true);
    try {
      const paper = (printerConfig.paperWidth === '58mm' ? '58mm' : '80mm');
      await printTestPage(printerConfig.deviceAddress, paper);
      setIsPrinterConnected(true);
      toast({
        title: t('common.success'),
        description: isRTL ? 'تمت طباعة صفحة الاختبار بنجاح' : 'Test page printed successfully',
      });
    } catch (e) {
      setIsPrinterConnected(false);
      toast({
        title: t('common.error'),
        description: describePrinterError(e),
        variant: 'destructive',
      });
    } finally {
      setIsTestingPrint(false);
    }
  };

  const handleConfirmUnpair = async () => {
    clearSelectedPrinter();
    setPrinterConfig(getStoredPrinterConfig());
    setIsPrinterConnected(false);
    setShowUnpairDialog(false);
    try {
      await PosFlowPrinter.disconnect();
    } catch {}
    toast({
      title: t('common.saved'),
      description: isRTL ? 'تم فصل الطابعة' : 'Printer disconnected',
    });
  };



  // Printing settings
  const [printSettings, setPrintSettings] = useState({
    autoPrint: persisted?.printSettings?.autoPrint ?? (initialUnified?.printSettings as any)?.autoPrint ?? true,
    showStoreName: persisted?.printSettings?.showStoreName ?? (initialUnified?.printSettings as any)?.showStoreName ?? true,
    showLogo: persisted?.printSettings?.showLogo ?? (initialUnified?.printSettings as any)?.showLogo ?? true,
    showAddress: persisted?.printSettings?.showAddress ?? (initialUnified?.printSettings as any)?.showAddress ?? true,
    showPhone: persisted?.printSettings?.showPhone ?? (initialUnified?.printSettings as any)?.showPhone ?? true,
    showEmail: persisted?.printSettings?.showEmail ?? (initialUnified?.printSettings as any)?.showEmail ?? true,
    showInvoiceNumber: persisted?.printSettings?.showInvoiceNumber ?? (initialUnified?.printSettings as any)?.showInvoiceNumber ?? true,
    showDateTime: persisted?.printSettings?.showDateTime ?? (initialUnified?.printSettings as any)?.showDateTime ?? true,
    showCashierName: persisted?.printSettings?.showCashierName ?? (initialUnified?.printSettings as any)?.showCashierName ?? true,
    welcomeMessage: persisted?.printSettings?.welcomeMessage ?? (initialUnified?.printSettings as any)?.welcomeMessage ?? '',
    footer: persisted?.printSettings?.footer || (initialUnified?.printSettings as any)?.footer || t('settings.defaultFooter'),
    showAlternativeCurrencies: persisted?.printSettings?.showAlternativeCurrencies ?? (initialUnified?.printSettings as any)?.showAlternativeCurrencies ?? false,
    paperSize: persisted?.printSettings?.paperSize || (initialUnified?.printSettings as any)?.paperSize || '80mm',
    copies: String(persisted?.printSettings?.copies ?? (initialUnified?.printSettings as any)?.copies ?? 1),
  });

  // Users are now managed by useUsersManagement hook

  // Backups
  const [backups, setBackups] = useState<BackupData[]>([
    { id: '1', date: '2024-01-15 10:00', size: '2.5 MB', type: 'auto' },
    { id: '2', date: '2024-01-14 10:00', size: '2.4 MB', type: 'auto' },
    { id: '3', date: '2024-01-13 15:30', size: '2.3 MB', type: 'manual' },
  ]);

  const [backupSettings, setBackupSettings] = useState({
    autoBackup: persisted?.backupSettings?.autoBackup ?? initialUnified?.backupSettings?.autoBackup ?? true,
    interval: persisted?.backupSettings?.interval ?? initialUnified?.backupSettings?.interval ?? 'daily',
    keepDays: String(persisted?.backupSettings?.keepDays ?? initialUnified?.backupSettings?.keepDays ?? 30),
  });

  // POS options
  const [hideMaintenanceSection, setHideMaintenanceSection] = useState(
    persisted?.hideMaintenanceSection ?? initialUnified?.hideMaintenanceSection ?? false
  );

  // Product fields config state (for unified save)
  const [productFieldsConfig, setProductFieldsConfig] = useState<ProductFieldsConfig | null>(() => loadProductFieldsConfig());
  const [productFieldsChanged, setProductFieldsChanged] = useState(false);

  // Floating action banner success state
  const [isSaveSuccess, setIsSaveSuccess] = useState(false);
  const saveSuccessTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up success banner timeout on unmount
  useEffect(() => {
    return () => {
      if (saveSuccessTimeoutRef.current) {
        clearTimeout(saveSuccessTimeoutRef.current);
      }
    };
  }, []);

  // Store type change confirmation
  const [storeTypeConfirmOpen, setStoreTypeConfirmOpen] = useState(false);
  const [pendingStoreType, setPendingStoreType] = useState<string | null>(null);

  // Dialogs
  const [isSyncing, setIsSyncing] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<{ backup: import('@/lib/full-backup').FullBackup; fileName: string; summary: string } | null>(null);
  const [lastBackupResult, setLastBackupResult] = useState<DownloadResult | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // Transfer license state
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [transferPassword, setTransferPassword] = useState('');
  const [isTransferring, setIsTransferring] = useState(false);
  const [showTransferPassword, setShowTransferPassword] = useState(false);

  const handleTransferLicense = async () => {
    if (!transferPassword || !currentUser?.email) return;
    setIsTransferring(true);
    try {
      const { data, error } = await supabase.functions.invoke('transfer-license', {
        body: { email: currentUser.email, password: transferPassword },
      });

      if (error || !data?.success) {
        toast({
          title: t('common.error'),
          description: data?.error || t('settings.transferFailed'),
          variant: 'destructive',
        });
        setIsTransferring(false);
        return;
      }

      toast({
        title: t('common.success'),
        description: t('settings.deviceUnlinked'),
      });

      // Clear all local data and force sign out
      setTransferDialogOpen(false);
      setTransferPassword('');
      localStorage.clear();
      await supabase.auth.signOut();
    } catch (err) {
      toast({
        title: t('common.error'),
        description: t('settings.unexpectedError'),
        variant: 'destructive',
      });
    }
    setIsTransferring(false);
  };

  const [isSavingSettings, setIsSavingSettings] = useState(false);

  // Snapshot of settings when page loads - for revert functionality
  const settingsSnapshotRef = useRef<{
    storeSettings: typeof storeSettings;
    primaryCurrency: string;
    enabledCurrencies: typeof enabledCurrencies;
    exchangeRates: typeof exchangeRates;
    currencyNames: typeof currencyNames;
    currencySymbols: typeof currencySymbols;
    currencyDisplayMode: typeof currencyDisplayMode;
    notificationSettings: typeof notificationSettings;
    printSettings: typeof printSettings;
    backupSettings: typeof backupSettings;
    syncSettings: typeof syncSettings;
    hideMaintenanceSection: boolean;
    productFieldsConfig: ProductFieldsConfig | null;
    taxEnabled: boolean;
    taxRate: number;
    discountPercentEnabled: boolean;
    discountFixedEnabled: boolean;
    barcodeScanMode: 'search' | 'add';
    trackCapital?: boolean;
    initialCapital?: number;
  } | null>(null);


  // ✅ Silent SWR: Load settings from cloud in background without UI blocking or unnecessary re-renders
  useEffect(() => {
    let isMounted = true;
    const loadFromCloudSilent = async () => {
      try {
        const restoredSettings = await pullStoreSettingsWithGuard();
        if (!isMounted || !restoredSettings) return;

        // Compare timestamps to avoid unnecessary re-renders when local settings are already current
        const cloudUpdatedAt = Number(restoredSettings.updatedAt) || 0;
        const localUpdatedAt = Number(initialUnified?.updatedAt) || 0;

        if (cloudUpdatedAt <= localUpdatedAt) {
          return;
        }

        const merged = restoredSettings;
        setSettingsLayout(merged.appearanceSettings.settingsLayout === 'list' ? 'list' : 'grid');
        const restoredSync = {
          interval: Number(merged.syncSettings?.interval ?? 10),
          showSuccessNotification: merged.syncSettings?.showSuccessNotification !== false,
          showErrorNotification: merged.syncSettings?.showErrorNotification !== false,
          showSyncStatus: merged.syncSettings?.showSyncStatus !== false,
          lastSync: String(merged.syncSettings?.lastSync ?? ''),
        };
        setSyncSettings(restoredSync);

        setStoreSettings(merged.storeSettings);
        setTaxEnabled(merged.taxEnabled);
        setTaxRate(merged.taxRate);
        setNotificationSettings(merged.notificationSettings as unknown as typeof notificationSettings);
        setPrintSettings(merged.printSettings as typeof printSettings);
        const s1Saved = merged.slot1Code;
        const s2Saved = merged.slot2Code;
        let s1Code = s1Saved && s1Saved !== 'USD' ? s1Saved : '';
        let s2Code = s2Saved && s2Saved !== 'USD' ? s2Saved : '';
        if (!s1Code) {
          const enabledMap = merged.enabledCurrencies || {};
          const namesMap = merged.currencyNames || {};
          const symbolsMap = merged.currencySymbols || {};
          const ratesMap = merged.exchangeRates || {};
          const activeNonUsd = Object.keys(enabledMap).filter(c => c !== 'USD' && enabledMap[c] === true);
          const otherConfigured = Object.keys({ ...ratesMap, ...namesMap, ...symbolsMap })
            .filter(c => c !== 'USD' && !activeNonUsd.includes(c));
          const candidateCodes = [...activeNonUsd, ...otherConfigured];
          s1Code = candidateCodes[0] || '';
          s2Code = candidateCodes.find(c => c !== s1Code) || '';
        } else if (!s2Code) {
          s2Code = '';
        }
        setSlot1Code(s1Code);
        setSlot2Code(s2Code);
        const initialNorm = normalizeCurrencySettings(merged);
        setPrimaryCurrency(initialNorm.primaryCurrencyCode);

        const loadedRates: Record<string, string> = {};
        const loadedNames: Record<string, string> = {};
        const loadedSymbols: Record<string, string> = {};
        const loadedEnabled: Record<string, boolean> = {
          USD: initialNorm.currencies.USD?.enabled !== false,
        };
        for (const [code, c] of Object.entries(initialNorm.currencies)) {
          loadedRates[code] = String(c.rate);
          loadedNames[code] = c.name;
          loadedSymbols[code] = c.symbol;
        }
        if (s1Code && s1Code !== 'USD') {
          loadedEnabled[s1Code] = initialNorm.currencies[s1Code]?.enabled === true;
        }
        if (s2Code && s2Code !== 'USD' && s2Code !== s1Code) {
          loadedEnabled[s2Code] = initialNorm.currencies[s2Code]?.enabled === true;
        }
        setExchangeRates(loadedRates);
        setCurrencyNames(loadedNames);
        setCurrencySymbols(loadedSymbols);
        setCurrencyDisplayMode(merged.currencyDisplayMode || {});
        setEnabledCurrencies(loadedEnabled);

        setDiscountPercentEnabled(merged.discountPercentEnabled);
        setDiscountFixedEnabled(merged.discountFixedEnabled);
        setBarcodeScanMode(merged.barcodeScanMode);
        setHideMaintenanceSection(merged.hideMaintenanceSection);
        setTrackCapital(merged.trackCapital);
        setInitialCapital(merged.initialCapital);
        setBackupSettings({
          autoBackup: Boolean(merged.backupSettings.autoBackup),
          interval: String(merged.backupSettings.interval || 'daily'),
          keepDays: String(merged.backupSettings.keepDays || '7'),
        });

        if (merged.productFieldsConfig) {
          setProductFieldsConfig(merged.productFieldsConfig);
        }

        applySettingsToRuntime(merged);

        settingsSnapshotRef.current = {
          storeSettings: { ...merged.storeSettings },
          syncSettings: restoredSync,
          primaryCurrency: merged.primaryCurrency,
          enabledCurrencies: { ...merged.enabledCurrencies },
          exchangeRates: { ...merged.exchangeRates } as any,
          currencyNames: { ...merged.currencyNames } as any,
          currencySymbols: { ...merged.currencySymbols } as any,
          currencyDisplayMode: { ...merged.currencyDisplayMode },
          notificationSettings: { ...(merged.notificationSettings as unknown as typeof notificationSettings) },
          printSettings: { ...(merged.printSettings as typeof printSettings) },
          backupSettings: {
            autoBackup: Boolean(merged.backupSettings.autoBackup),
            interval: String(merged.backupSettings.interval || 'daily'),
            keepDays: String(merged.backupSettings.keepDays || '7'),
          },
          hideMaintenanceSection: merged.hideMaintenanceSection,
          taxEnabled: merged.taxEnabled,
          taxRate: merged.taxRate,
          discountPercentEnabled: merged.discountPercentEnabled,
          discountFixedEnabled: merged.discountFixedEnabled,
          barcodeScanMode: merged.barcodeScanMode,
          productFieldsConfig: merged.productFieldsConfig || loadProductFieldsConfig(),
        };
      } catch (e) {
        console.warn('[Settings] Silent background settings sync error (cached values in use):', e);
      }
    };
    const timer = setTimeout(loadFromCloudSilent, 50);
    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, []);

  // Capture snapshot on first render only
  useEffect(() => {
    if (!settingsSnapshotRef.current) {
      settingsSnapshotRef.current = {
        storeSettings: { ...storeSettings },
        syncSettings: { ...syncSettings },
        primaryCurrency,
        enabledCurrencies: { ...enabledCurrencies },
        exchangeRates: { ...exchangeRates },
        currencyNames: { ...currencyNames },
        currencySymbols: { ...currencySymbols },
        currencyDisplayMode: { ...currencyDisplayMode },
        notificationSettings: { ...notificationSettings },
        printSettings: { ...printSettings },
        backupSettings: { ...backupSettings },
        hideMaintenanceSection,
        productFieldsConfig: loadProductFieldsConfig(),
        taxEnabled,
        taxRate,
        discountPercentEnabled,
        discountFixedEnabled,
        barcodeScanMode,
        trackCapital,
        initialCapital,
      };
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const settingsTabs: SettingsTabItem[] = useMemo(() => [
    {
      id: 'profile',
      label: t('settings.profile') || 'الملف الشخصي',
      description: isRTL ? 'إدارة الحساب وكلمة المرور' : 'Account & password',
      icon: User,
      category: 'core',
      color: 'rose',
      badge: isBoss ? 'Boss 👑' : isOwnerAdmin ? 'Owner' : 'Cashier',
      keywords: ['ملف', 'حساب', 'مستخدم', 'كلمة مرور', 'profile', 'user', 'account', 'password'],
    },
    {
      id: 'store',
      label: t('settings.store') || 'إعدادات المتجر والعملات',
      description: isRTL ? 'الهوية، الضرائب وأسعار الصرف' : 'Identity, taxes & exchange rates',
      icon: Store,
      category: 'core',
      color: 'amber',
      badge: `${primaryCurrency || 'USD'}`,
      keywords: ['متجر', 'محل', 'شعار', 'عملات', 'صرف', 'ضرائب', 'store', 'currencies', 'taxes', 'rates'],
    },
    {
      id: 'backup',
      label: t('settings.backupSync') || 'النسخ والمزامنة',
      description: isRTL ? 'نسخ احتياطي محلي وسحابي' : 'Cloud sync & local backups',
      icon: Database,
      adminOnly: true,
      category: 'core',
      color: 'blue',
      badge: syncSettings?.lastSync ? (syncSettings.lastSync.includes(' ') ? syncSettings.lastSync.split(' ')[1] : syncSettings.lastSync) : (isRTL ? 'سحابي' : 'Cloud'),
      keywords: ['نسخ', 'احتياطي', 'مزامنة', 'سحابي', 'تصدير', 'استيراد', 'backup', 'sync', 'cloud', 'import', 'export'],
    },
    {
      id: 'notifications',
      label: t('settings.notifications') || 'التنبيهات والإشعارات',
      description: isRTL ? 'صوت، مبيعات ونفاد المخزون' : 'Sounds, sales & low stock alerts',
      icon: Bell,
      category: 'core',
      color: 'purple',
      badge: notificationSettings.masterEnabled !== false ? (isRTL ? 'مفعل 🔔' : 'Active 🔔') : (isRTL ? 'معطل' : 'Off'),
      keywords: ['إشعار', 'إشعارات', 'تنبيه', 'صوت', 'notifications', 'alerts', 'sound'],
    },
    {
      id: 'productFields',
      label: t('settings.productFields') || 'حقول المنتجات',
      description: isRTL ? 'تخصيص بطاقة الأصناف ومواصفاتها' : 'Custom fields for product cards',
      icon: Package,
      category: 'core',
      color: 'amber',
      badge: isRTL ? 'تخصيص' : 'Custom',
      keywords: ['حقول', 'منتجات', 'أصناف', 'بطاقة', 'fields', 'products'],
    },
    {
      id: 'printing',
      label: t('settings.printing') || 'الطباعة والمشاركة',
      description: isRTL ? 'تخصيص الفواتير والبلوتوث' : 'Receipt design & thermal printers',
      icon: Printer,
      category: 'operations',
      color: 'teal',
      badge: printSettings?.paperSize || '80mm',
      keywords: ['طباعة', 'فاتورة', 'طابعة', 'بلوتوث', 'حرارية', 'printer', 'receipt', 'print'],
    },
    {
      id: 'users',
      label: t('settings.users') || 'المستخدمين والصلاحيات',
      description: isRTL ? 'إدارة الكاشيرات وضبط الوصول' : 'Staff, cashiers & permissions',
      icon: Users,
      adminOnly: true,
      category: 'operations',
      color: 'indigo',
      badge: isRTL ? 'إدارة' : 'Manage',
      keywords: ['مستخدمين', 'كاشير', 'صلاحيات', 'وصول', 'users', 'roles', 'cashier'],
    },
    {
      id: 'activity',

      label: isRTL ? 'سجل النشاط والأرشيف' : 'Activity log & archive',

      description: isRTL ? 'تدقيق الحركات، الأرشيف واسترجاع المحذوفات' : 'Audit trail, archive & restore deleted items',

      icon: Activity,

      category: 'operations',

      color: 'emerald',

      badge: isRTL ? 'تدقيق آمن' : 'Audit',

      keywords: ['نشاط', 'سجل', 'تدقيق', 'عمليات', 'حركات', 'أرشيف', 'محذوفات', 'استرجاع', 'فواتير', 'activity', 'log', 'audit', 'archive', 'deleted'],
    },
    {
      id: 'license',
      label: t('settings.license') || 'الترخيص وتفعيل الجهاز',
      description: isRTL ? 'كود الترخيص ونقل الرخصة' : 'Device license & activation',
      icon: Key,
      category: 'operations',
      color: 'orange',
      badge: isRTL ? 'نشط' : 'Active',
      keywords: ['ترخيص', 'تفعيل', 'كود', 'رخصة', 'license', 'activation', 'key'],
    },
    {
      id: 'licenses',
      label: t('settings.licenseManagement') || 'إدارة التراخيص',
      description: isRTL ? 'توليد الأكواد وإدارة الأجهزة' : 'Generate keys & manage devices',
      icon: Shield,
      bossOnly: true,
      danger: true,
      category: 'operations',
      color: 'rose',
      badge: 'Super Admin',
      keywords: ['تراخيص', 'توليد', 'أجهزة', 'أكواد', 'licenses', 'management'],
    },
    {
      id: 'partners',
      label: t('nav.partners') || 'الشركاء ورأس المال',
      description: isRTL ? 'حصص الأرباح والمسحوبات' : 'Partners & profit sharing',
      icon: UserCheck,
      adminOnly: true,
      category: 'operations',
      color: 'cyan',
      badge: isRTL ? 'أرباح' : 'Profits',
      keywords: ['شركاء', 'أرباح', 'رأس مال', 'مسحوبات', 'partners', 'capital'],
    },
    {
      id: 'reset',
      label: t('settings.resetData') || 'تصفير البيانات',
      description: isRTL ? 'تهيئة قاعدة البيانات من الصفر' : 'Reset & clear all system data',
      icon: AlertTriangle,
      adminOnly: true,
      danger: true,
      category: 'operations',
      color: 'destructive',
      badge: '⚠️',
      keywords: ['تصفير', 'حذف', 'إعادة ضبط', 'بيانات', 'reset', 'clear', 'wipe'],
    },
    {
      id: 'contact',
      label: t('license.contactDeveloper') || 'التواصل مع المطور',
      description: isRTL ? 'واتساب، تلكرام والدعم المباشر' : 'WhatsApp, Telegram & support',
      icon: Phone,
      category: 'support',
      color: 'emerald',
      badge: isRTL ? 'مباشر' : 'Live',
      keywords: ['تواصل', 'مطور', 'دعم', 'واتساب', 'تلكرام', 'contact', 'support', 'developer'],
    },
    {
      id: 'about',
      label: isRTL ? 'حول البرنامج' : 'About',
      description: isRTL ? 'الإصدار v1.0.68 وسجل التحديثات' : 'v1.0.68 release & updates',
      icon: FileText,
      category: 'support',
      color: 'primary',
      badge: 'v1.0.68',
      keywords: ['حول', 'برنامج', 'إصدار', 'تحديث', 'نسخة', 'about', 'version'],
    },
  ], [t, isRTL, isBoss, isOwnerAdmin, primaryCurrency, syncSettings?.lastSync, notificationPerm, printSettings?.paperSize]);

  // Independent tabs that have no saveable settings form state
  const INDEPENDENT_TABS = ['licenses', 'activity', 'archive', 'license', 'contact', 'reset', 'about', 'users', 'partners', 'profile'];

  // Check if there are unsaved changes
  const hasUnsavedChanges = (() => {
    // Hide save bar on main screen (activeTab === null) or independent tabs
    if (!activeTab || INDEPENDENT_TABS.includes(activeTab)) return false;
    const snap = settingsSnapshotRef.current;
    if (!snap) return false;

    // Check changes ONLY for the active tab to prevent false triggers
    if (activeTab === 'store') {
      return (
        primaryCurrency !== snap.primaryCurrency ||
        slot1Code !== (snap as any).slot1Code ||
        slot2Code !== (snap as any).slot2Code ||
        JSON.stringify(enabledCurrencies) !== JSON.stringify(snap.enabledCurrencies) ||
        JSON.stringify(storeSettings) !== JSON.stringify(snap.storeSettings) ||
        JSON.stringify(exchangeRates) !== JSON.stringify(snap.exchangeRates) ||
        JSON.stringify(currencyNames) !== JSON.stringify(snap.currencyNames) ||
        JSON.stringify(currencySymbols) !== JSON.stringify(snap.currencySymbols) ||
        JSON.stringify(currencyDisplayMode) !== JSON.stringify(snap.currencyDisplayMode) ||
        hideMaintenanceSection !== snap.hideMaintenanceSection ||
        taxEnabled !== snap.taxEnabled ||
        taxRate !== snap.taxRate ||
        discountPercentEnabled !== snap.discountPercentEnabled ||
        discountFixedEnabled !== snap.discountFixedEnabled ||
        barcodeScanMode !== snap.barcodeScanMode ||
        trackCapital !== snap.trackCapital ||
        initialCapital !== snap.initialCapital
      );
    }

    if (activeTab === 'productFields') {
      const isProductFieldsDirty = Boolean(
        (productFieldsConfig && !snap.productFieldsConfig) ||
        (!productFieldsConfig && snap.productFieldsConfig) ||
        (productFieldsConfig && snap.productFieldsConfig && JSON.stringify(productFieldsConfig) !== JSON.stringify(snap.productFieldsConfig))
      );
      return isProductFieldsDirty || productFieldsChanged;
    }

    if (activeTab === 'notifications') {
      return JSON.stringify(notificationSettings) !== JSON.stringify(snap.notificationSettings);
    }

    if (activeTab === 'printing') {
      return JSON.stringify(printSettings) !== JSON.stringify(snap.printSettings);
    }

    if (activeTab === 'backup') {
      return JSON.stringify(backupSettings) !== JSON.stringify(snap.backupSettings) ||
        JSON.stringify(syncSettings) !== JSON.stringify(snap.syncSettings);
    }

    return false;
  })();

  // Revert all settings to snapshot
  const handleRevert = () => {
    const snap = settingsSnapshotRef.current;
    if (!snap) return;
    setStoreSettings({ ...snap.storeSettings });
    setPrimaryCurrency(snap.primaryCurrency ?? 'USD');
    if ((snap as any).slot1Code) setSlot1Code((snap as any).slot1Code);
    if ((snap as any).slot2Code) setSlot2Code((snap as any).slot2Code);
    if (snap.enabledCurrencies) {
      setEnabledCurrencies({ ...snap.enabledCurrencies });
    }
    setExchangeRates({ ...snap.exchangeRates });
    setCurrencyNames({ ...snap.currencyNames });
    setCurrencySymbols({ ...snap.currencySymbols });
    setCurrencyDisplayMode({ ...snap.currencyDisplayMode });
    setNotificationSettings({ ...snap.notificationSettings });
    setPrintSettings({ ...snap.printSettings });
    setBackupSettings({ ...snap.backupSettings });
    setSyncSettings({ ...snap.syncSettings });
    setHideMaintenanceSection(snap.hideMaintenanceSection);
    setTrackCapital(snap.trackCapital ?? false);
    setInitialCapital(snap.initialCapital ?? 0);
    if (snap.productFieldsConfig) {
      setProductFieldsConfig({ ...snap.productFieldsConfig });
      localStorage.setItem('posflow_product_fields_v1', JSON.stringify(snap.productFieldsConfig));
      emitEvent(EVENTS.PRODUCT_FIELDS_UPDATED, snap.productFieldsConfig);
    } else {
      setProductFieldsConfig(null);
    }
    setProductFieldsChanged(false);
    setTaxEnabled(snap.taxEnabled);
    setTaxRate(snap.taxRate);
    setDiscountPercentEnabled(snap.discountPercentEnabled);
    setDiscountFixedEnabled(snap.discountFixedEnabled);
    setBarcodeScanMode(snap.barcodeScanMode);
    setIsSaveSuccess(false);
    setLastSaveStatus(null);
    if (saveSuccessTimeoutRef.current) {
      clearTimeout(saveSuccessTimeoutRef.current);
    }
    toast({
      title: t('common.success'),
      description: t('settings.changesReverted'),
    });
  };

  // Handlers
  const executeSave = async () => {
    // 1. تحقق أسعار الصرف ديناميكياً للخانات المستخدمة
    if (activeTab === 'store' || !activeTab) {
      for (const slot of [slot1Code, slot2Code]) {
        if (!slot || slot === 'USD') continue;
        const val = exchangeRates[slot];
        if (val !== '' && val !== undefined) {
          const num = Number(val);
          if (!Number.isFinite(num) || num <= 0) {
            toast({
              title: t('common.error'),
              description: `${t('settings.invalidExchangeRates')} (${currencyNames[slot] || slot})`,
              variant: 'destructive',
            });
            return;
          }
        }
      }
    }

    // 2. تحقق عدد النسخ (حصراً عند تعديل تبويب الطباعة لتفادي إعاقة حفظ العملات)
    if (activeTab === 'printing') {
      const copies = Number(printSettings.copies);
      if (!Number.isFinite(copies) || copies < 1 || copies > 5) {
        toast({
          title: t('common.error'),
          description: t('settings.invalidCopies'),
          variant: 'destructive',
        });
        return;
      }
    }

    // 3. تحقق أيام النسخ الاحتياطي (حصراً عند تعديل تبويب النسخ الاحتياطي)
    if (activeTab === 'backup') {
      const keepDays = Number(backupSettings.keepDays);
      if (!Number.isFinite(keepDays) || keepDays < 7 || keepDays > 365) {
        toast({
          title: t('common.error'),
          description: t('settings.invalidKeepDays'),
          variant: 'destructive',
        });
        return;
      }
    }

    try {
      setIsSavingSettings(true);

      const existingCustomFields = loadCustomFields();
      const existingProductFields = productFieldsConfig || loadProductFieldsConfig();

      // تطهير العملات وحصرها في الثلاث بطاقات فقط
      const cleanEnabledCurrencies: Record<string, boolean> = {
        USD: enabledCurrencies.USD !== false,
      };
      if (slot1Code) cleanEnabledCurrencies[slot1Code] = enabledCurrencies[slot1Code] === true;
      if (slot2Code && slot2Code !== slot1Code) cleanEnabledCurrencies[slot2Code] = enabledCurrencies[slot2Code] === true;

      setEnabledCurrencies(cleanEnabledCurrencies);

      // تطهير عملة التقارير إذا أصبحت معطلة
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          const savedReportCur = window.localStorage.getItem('posflow_report_currency');
          if (savedReportCur && cleanEnabledCurrencies[savedReportCur] !== true) {
            window.localStorage.setItem('posflow_report_currency', 'USD');
          }
        } catch {}
      }

      // بناء خريطة أسعار الصرف والأسماء والرموز النظيفة مع منع تداخل الخانات القديمة TRY/SYP
      const cleanExchangeRates: Record<string, number> = { USD: 1 };
      for (const [k, v] of Object.entries(exchangeRates)) {
        const upperKey = k.trim().toUpperCase();
        if (v !== '' && v !== undefined) {
          const num = Number(v);
          if (Number.isFinite(num) && num > 0) {
            cleanExchangeRates[upperKey] = num;
          }
        }
      }
      if (slot1Code && exchangeRates[slot1Code] !== '' && exchangeRates[slot1Code] !== undefined) {
        const num = Number(exchangeRates[slot1Code]);
        if (Number.isFinite(num) && num > 0) cleanExchangeRates[slot1Code.toUpperCase()] = num;
      }
      if (slot2Code && exchangeRates[slot2Code] !== '' && exchangeRates[slot2Code] !== undefined) {
        const num = Number(exchangeRates[slot2Code]);
        if (Number.isFinite(num) && num > 0) cleanExchangeRates[slot2Code.toUpperCase()] = num;
      }

      // إعادة الخانات التراثية TRY و SYP لأسمائها ورموزها الأصلية إذا لم تكن هي المختارة في slot1/slot2
      // لمنع detectCurrencyCodeFromMeta من اعتقاد أن TRY هي EGP
      const cleanCurrencyNames: Record<string, string | undefined> = { ...currencyNames };
      const cleanCurrencySymbols: Record<string, string | undefined> = { ...currencySymbols };
      if (slot1Code !== 'TRY' && slot2Code !== 'TRY') {
        cleanCurrencyNames.TRY = 'ليرة تركية';
        cleanCurrencySymbols.TRY = '₺';
      }
      if (slot1Code !== 'SYP' && slot2Code !== 'SYP') {
        cleanCurrencyNames.SYP = 'ليرة سورية';
        cleanCurrencySymbols.SYP = 'ل.س';
      }

      const saveResult = await saveUnifiedStoreSettings({
        updatedAt: Date.now(),
        slot1Code,
        slot2Code,
        storeSettings,
        primaryCurrency,
        enabledCurrencies: cleanEnabledCurrencies,
        exchangeRates: cleanExchangeRates,
        currencyNames: cleanCurrencyNames,
        currencySymbols: cleanCurrencySymbols,
        currencyDisplayMode,
        taxEnabled,
        taxRate,
        discountPercentEnabled,
        discountFixedEnabled,
        barcodeScanMode,
        hideMaintenanceSection,
        trackCapital,
        initialCapital,
        notificationSettings: notificationSettings as unknown as Record<string, unknown>,
        printSettings,
        backupSettings,
        syncSettings,
        productFieldsConfig: existingProductFields,
        customFields: existingCustomFields,
      });

      localStorage.setItem('posflow_toast_duration', String((notificationSettings.durationSeconds || 2) * 1000));

      if (productFieldsConfig) {
        localStorage.setItem('posflow_product_fields_v1', JSON.stringify(productFieldsConfig));
        emitEvent(EVENTS.PRODUCT_FIELDS_UPDATED, productFieldsConfig);
      }
      setProductFieldsChanged(false);

      // Update snapshot after successful save
      settingsSnapshotRef.current = {
        storeSettings: { ...storeSettings },
        primaryCurrency,
        enabledCurrencies: { ...cleanEnabledCurrencies },
        exchangeRates: { ...exchangeRates, ...cleanExchangeRates } as any,
        currencyNames: { ...cleanCurrencyNames },
        currencySymbols: { ...cleanCurrencySymbols },
        currencyDisplayMode: { ...currencyDisplayMode },
        notificationSettings: { ...notificationSettings },
        printSettings: { ...printSettings },
        backupSettings: { ...backupSettings },
        syncSettings: { ...syncSettings },
        hideMaintenanceSection,
        productFieldsConfig: existingProductFields ? { ...existingProductFields } : null,
        taxEnabled,
        taxRate,
        discountPercentEnabled,
        discountFixedEnabled,
        barcodeScanMode,
        trackCapital,
        initialCapital,
      };

      // Activate interactive save success state in floating action banner
      setLastSaveStatus(saveResult.status);
      setIsSaveSuccess(true);
      if (saveSuccessTimeoutRef.current) {
        clearTimeout(saveSuccessTimeoutRef.current);
      }
      saveSuccessTimeoutRef.current = setTimeout(() => {
        setIsSaveSuccess(false);
      }, 2500);

      if (saveResult.status === 'synced') {
        toast({
          title: t('common.saved'),
          description: isRTL ? 'تم حفظ الإعدادات ومزامنتها سحابياً بنجاح ☁️' : 'Settings saved & synced to cloud successfully ☁️',
        });
      } else if (saveResult.status === 'queued') {
        toast({
          title: t('common.saved'),
          description: isRTL ? 'تم حفظ الإعدادات محلياً — بانتظار المزامنة عند توفر الاتصال ⏳' : 'Settings saved locally — queued for cloud sync ⏳',
        });
      } else {
        toast({
          title: t('common.saved'),
          description: isRTL ? 'تم حفظ الإعدادات محلياً بنجاح 💾' : 'Settings saved locally on this device 💾',
        });
      }
    } catch (err) {
      console.error('[Settings] Save error:', err);
      toast({
        title: t('common.error'),
        description: isRTL ? 'تعذر حفظ الإعدادات، يرجى المحاولة مرة أخرى' : 'Failed to save settings, please try again',
        variant: 'destructive',
      });
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleSaveSettings = async () => {
    // 1. فحص حالة رقم هاتف المتجر قبل الحفظ
    if (storeSettings.phone && storeSettings.phone.trim()) {
      try {
        const { data: phoneCheck } = await (supabase.rpc as any)('check_store_phone_status', {
          _phone: storeSettings.phone,
        });

        if (phoneCheck && !phoneCheck.ok && phoneCheck.status === 'conflict_no_telegram') {
          showToast.error(phoneCheck.error || 'الرقم مرتبط بحساب آخر غير مفعل لديه تيليجرام');
          return;
        }

        if (phoneCheck?.status === 'available') {
          setPhoneVerificationStatus('available');
          setPhoneVerificationOpen(true);
          return; // يتوقف ليطلب كلمة المرور في النافذة أولاً ثم يكمل الحفظ
        }

        if (phoneCheck?.status === 'requires_telegram_verification') {
          setPhoneVerificationStatus('requires_telegram_verification');
          setPhoneVerificationOpen(true);
          return; // يتوقف ليطلب رمز التيليجرام أولاً
        }
      } catch (err) {
        console.warn('Phone pre-check warning:', err);
      }
    }

    // استكمال الحفظ الفعلي كما هو...
    await executeSave();
  };

  const handleSync = () => {
    setIsSyncing(true);
    setTimeout(() => {
      setIsSyncing(false);
      setSyncSettings(prev => ({ ...prev, lastSync: formatDateTime(new Date().toISOString()) }));
      toast({
        title: t('settings.syncComplete'),
        description: t('settings.dataSynced'),
      });
    }, 2000);
  };

  const handleBackupNow = async () => {
    setIsBackingUp(true);
    try {
      const { buildFullBackup, backupFileName } = await import('@/lib/full-backup');
      const { downloadFile } = await import('@/lib/file-download');
      const backup = await buildFullBackup();
      const content = JSON.stringify(backup);
      const filename = backupFileName();
      const result = await downloadFile({ filename, content, mimeType: 'application/json' });

      const newBackup: BackupData = {
        id: Date.now().toString(),
        date: formatDateTime(new Date().toISOString()),
        size: (content.length / 1024 / 1024).toFixed(2) + ' MB',
        type: 'manual',
      };
      setBackups([newBackup, ...backups]);

      if (result.success) {
        setLastBackupResult({ ...result, filename });
        toast({
          title: t('settings.backupComplete'),
          description: isNativePlatform()
            ? `${t('settings.backupSavedDevice')} - ${result.path}/${filename}`
            : t('settings.backupDownloaded'),
        });
      } else {
        toast({ title: t('common.error'), description: t('settings.backupFailed'), variant: 'destructive' });
      }
    } catch (error) {
      console.error('Backup error:', error);
      toast({ title: t('common.error'), description: t('settings.backupFailed'), variant: 'destructive' });
    } finally {
      setIsBackingUp(false);
    }
  };

  // اختيار ملف الاستعادة: نقرؤه ونتحقق منه ثم نعرض تحذير الـ 10 ثوانٍ
  const handleImportBackup = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setIsImporting(true);
    try {
      const { decodeBackupFile, parseBackup } = await import('@/lib/full-backup');
      const parsed = await parseBackup(await decodeBackupFile(file));
      const c = parsed.counts || {};
      const summary = `منتجات: ${c.products ?? 0} • فواتير: ${c.invoices ?? 0} • مصاريف: ${c.expenses ?? 0} • عملاء: ${c.customers ?? 0} • صور: ${Object.keys(parsed.images || {}).length}`;
      setPendingRestore({ backup: parsed, fileName: file.name, summary });
    } catch (error) {
      console.error('Import error:', error);
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('settings.invalidBackupFile'),
        variant: 'destructive',
      });
    } finally {
      setIsImporting(false);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  const confirmRestore = async () => {
    if (!pendingRestore) return;
    setIsRestoring(true);
    try {
      const { restoreFullBackup } = await import('@/lib/full-backup');
      const report = await restoreFullBackup(pendingRestore.backup);
      // المزامنة إلى السحابة: النسخة المستعادة تحل محل كل النسخ السحابية السابقة
      try {
        const { replaceCloudBackupWithCurrent } = await import('@/lib/cloud-backup');
        await replaceCloudBackupWithCurrent();
      } catch (e) {
        console.warn('Cloud backup sync after restore failed:', e);
      }
      const total = Object.values(report.restored).reduce((a, b) => a + b, 0);
      toast({
        title: t('settings.restoreComplete'),
        description: report.failed.length
          ? `تمت استعادة ${total} سجل. تعذّر جزء: ${report.failed.map((f) => `${f.table} (${f.message})`).join(' | ')}`
          : `تمت استعادة ${total} سجل و${report.imagesRestored} صورة بنجاح`,
        variant: report.failed.length ? 'destructive' : undefined,
      });
      setPendingRestore(null);
      setTimeout(() => window.location.reload(), report.failed.length ? 6000 : 1500);
    } catch (error) {
      console.error('Restore error:', error);
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('settings.importFailed'),
        variant: 'destructive',
      });
    } finally {
      setIsRestoring(false);
    }
  };

  const handleRestoreBackup = (backup: BackupData) => {
    toast({
      title: t('settings.restoring'),
      description: `${t('settings.restoringFrom')} ${backup.date}`,
    });
  };

  const handleDeleteBackup = (backup: BackupData) => {
    setBackups(backups.filter(b => b.id !== backup.id));
    toast({
      title: t('common.deleted'),
      description: t('settings.backupDeleted'),
    });
  };

  const handleImportData = () => {
    toast({
      title: t('settings.importing'),
      description: t('settings.importingData'),
    });
  };

  const handleTestPrint = async () => {
    try {
      const now = new Date();
      const dateStr = now.toLocaleDateString('ar-SA');
      const timeStr = now.toLocaleTimeString('ar-SA');
      const storeName = storeSettings.name || 'PosFlow';
      const storePhone = storeSettings.phone || '';
      const storeAddress = storeSettings.address || '';
      const paperSize = printSettings.paperSize || '80mm';
      const copies = printSettings.copies || '1';
      const footer = printSettings.footer || 'شكراً لتسوقكم معنا!';

      const testContent = `
        <!DOCTYPE html>
        <html dir="rtl" lang="ar">
        <head>
          <meta charset="UTF-8">
          <title>فحص الطابعة - ${storeName}</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Cairo', system-ui, sans-serif; }
            body { width: ${paperSize === '58mm' ? '54mm' : paperSize === 'A4' ? '210mm' : '76mm'}; margin: 0 auto; padding: 8px; font-size: 12px; color: #000; }
            .header { text-align: center; border-bottom: 2px dashed #000; padding-bottom: 8px; margin-bottom: 8px; }
            .title { font-size: 16px; font-weight: bold; margin-bottom: 4px; }
            .badge { display: inline-block; background: #000; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin: 4px 0; }
            .info-row { display: flex; justify-content: space-between; font-size: 11px; margin: 3px 0; }
            table { width: 100%; border-collapse: collapse; margin: 8px 0; }
            th, td { padding: 4px; text-align: right; border-bottom: 1px dotted #ccc; font-size: 11px; }
            th { border-bottom: 1px solid #000; font-weight: bold; }
            .total-box { border-top: 2px solid #000; border-bottom: 2px solid #000; padding: 6px 0; margin: 8px 0; text-align: center; font-weight: bold; font-size: 14px; }
            .footer { text-align: center; font-size: 11px; margin-top: 8px; color: #444; }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="title">${storeName}</div>
            ${storeAddress ? '<div>' + storeAddress + '</div>' : ''}
            ${storePhone ? '<div>هاتف: ' + storePhone + '</div>' : ''}
            <div class="badge">تجربة فحص الطابعة / TEST PRINT</div>
          </div>
          <div class="info-row"><span>التاريخ:</span><span>${dateStr}</span></div>
          <div class="info-row"><span>الوقت:</span><span>${timeStr}</span></div>
          <div class="info-row"><span>مقاس الورق:</span><span>${paperSize}</span></div>
          <div class="info-row"><span>عدد النسخ:</span><span>${copies}</span></div>
          <table>
            <thead>
              <tr><th>الصنف</th><th>الكمية</th><th>السعر</th></tr>
            </thead>
            <tbody>
              <tr><td>صنف فحص تجريبي أ</td><td>1</td><td>$10.00</td></tr>
              <tr><td>صنف فحص تجريبي ب</td><td>2</td><td>$20.00</td></tr>
            </tbody>
          </table>
          <div class="total-box">
            الإجمالي التجريبي: $30.00
          </div>
          <div class="footer">
            <p>${footer}</p>
            <p style="margin-top: 4px; font-size: 9px; color: #888;">PosFlow • فحص استجابة الطابعة ناجح</p>
          </div>
        </body>
        </html>
      `;

      await printHTML(testContent);
      toast({
        title: '✓ تم إرسال الطباعة التجريبية',
        description: 'جاري تمرير الفاتورة التجريبية إلى الطابعة المحددة',
      });
    } catch (err) {
      console.error('Test print failed:', err);
      toast({
        title: 'خطأ في الطباعة',
        description: 'تعذر إرسال أمر الطباعة، يرجى التأكد من اتصال الطابعة',
        variant: 'destructive'
      });
    }
  };


  // Helper for notification categories icons
  const getCategoryIconComponent = (iconName: string) => {
    switch (iconName) {
      case 'ShoppingCart': return ShoppingCart;
      case 'FileText': return FileText;
      case 'Users': return Users;
      case 'Package': return Package;
      case 'DollarSign': return DollarSign;
      case 'Cloud': return Cloud;
      case 'Sliders': return SlidersHorizontal;
      default: return Bell;
    }
  };

  const getCategoryColorClasses = (color: string) => {
    switch (color) {
      case 'emerald':
        return {
          bg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
          badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
        };
      case 'orange':
        return {
          bg: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
          badge: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20',
        };
      case 'amber':
        return {
          bg: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
          badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
        };
      case 'blue':
        return {
          bg: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
          badge: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
        };
      case 'rose':
        return {
          bg: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
          badge: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
        };
      case 'sky':
        return {
          bg: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
          badge: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
        };
      case 'purple':
        return {
          bg: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
          badge: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20',
        };
      default:
        return {
          bg: 'bg-primary/10 text-primary',
          badge: 'bg-primary/10 text-primary border-primary/20',
        };
    }
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'profile':
        return (
          <div className="space-y-4">
            <TelegramLinkCard />
            <ProfileManagement />
          </div>
        );
      case 'productFields':
        return (
          <ProductFieldsSection
            storeType={storeSettings.type}
            onConfigChange={(config) => {
              setProductFieldsConfig(config);
              setProductFieldsChanged(true);
            }}
            pendingConfig={productFieldsConfig}
          />
        );
      case 'language':
        return <LanguageSection />;
      case 'theme':
        return <Navigate to="/appearance" replace />;
      case 'currencies':
        return (
          <div className="space-y-4">
            <Suspense fallback={<div className="p-8 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>}>
              <FinanceSettingsSection
                primaryCurrency={primaryCurrency}
                setPrimaryCurrency={setPrimaryCurrency}
                enabledCurrencies={enabledCurrencies}
                setEnabledCurrencies={setEnabledCurrencies}
                exchangeRates={exchangeRates as any}
                setExchangeRates={setExchangeRates}
                currencyNames={currencyNames}
                setCurrencyNames={setCurrencyNames}
                currencySymbols={currencySymbols}
                setCurrencySymbols={setCurrencySymbols}
                currencyDisplayMode={currencyDisplayMode}
                setCurrencyDisplayMode={setCurrencyDisplayMode}
                taxEnabled={taxEnabled}
                setTaxEnabled={setTaxEnabled}
                taxRate={taxRate}
                setTaxRate={setTaxRate}
                discountPercentEnabled={discountPercentEnabled}
                setDiscountPercentEnabled={setDiscountPercentEnabled}
                discountFixedEnabled={discountFixedEnabled}
                setDiscountFixedEnabled={setDiscountFixedEnabled}
                trackCapital={trackCapital}
                setTrackCapital={setTrackCapital}
                initialCapital={initialCapital}
                setInitialCapital={setInitialCapital}
                slot1Code={slot1Code}
                setSlot1Code={setSlot1Code}
                slot2Code={slot2Code}
                setSlot2Code={setSlot2Code}
                toggleCurrency={toggleCurrency}
                renderCurrencyDisplayOptions={renderCurrencyDisplayOptions}
                sanitizeNumberText={sanitizeNumberText}
              />
            </Suspense>
          </div>
        );
      case 'activity':

      case 'archive':

        return <ActivityArchiveSection initialView={activeTab === 'archive' ? 'archive' : undefined} />;
      case 'store':
        return (
          <div className="space-y-4">
            <Tabs defaultValue="info">
              <TabsList className="w-full mb-4">
                <TabsTrigger value="info" className="flex-1">{t('settings.storeInfoTab') || 'معلومات المتجر'}</TabsTrigger>
                <TabsTrigger value="finance" className="flex-1">{t('settings.financeTab') || 'العملات والضرائب'}</TabsTrigger>
              </TabsList>

              {/* التبويب الفرعي 1: معلومات المتجر */}
              {/* التبويب الفرعي 1: البيانات الأساسية */}
              <TabsContent value="info" className="space-y-4 mt-0">
                <Suspense fallback={<div className="p-8 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>}>
                  <StoreInfoSection
                    storeSettings={storeSettings}
                    setStoreSettings={setStoreSettings}
                    handleLogoUpload={handleLogoUpload}
                    handleRemoveLogo={handleRemoveLogo}
                    setProductFieldsConfig={setProductFieldsConfig}
                    setProductFieldsChanged={setProductFieldsChanged}
                    setPendingStoreType={setPendingStoreType}
                    setStoreTypeConfirmOpen={setStoreTypeConfirmOpen}
                    barcodeScanMode={barcodeScanMode}
                    setBarcodeScanMode={setBarcodeScanMode}
                    hideMaintenanceSection={hideMaintenanceSection}
                    setHideMaintenanceSection={setHideMaintenanceSection}
                  />
                </Suspense>
              </TabsContent>

              {/* التبويب الفرعي 2: العملات والضرائب */}
              {/* التبويب الفرعي 2: المالية والضرائب */}
              <TabsContent value="finance" className="space-y-4 mt-0">
                <Suspense fallback={<div className="p-8 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>}>
                  <FinanceSettingsSection
                    primaryCurrency={primaryCurrency}
                    setPrimaryCurrency={setPrimaryCurrency}
                    enabledCurrencies={enabledCurrencies}
                    setEnabledCurrencies={setEnabledCurrencies}
                    exchangeRates={exchangeRates as any}
                    setExchangeRates={setExchangeRates}
                    currencyNames={currencyNames}
                    setCurrencyNames={setCurrencyNames}
                    currencySymbols={currencySymbols}
                    setCurrencySymbols={setCurrencySymbols}
                    currencyDisplayMode={currencyDisplayMode}
                    setCurrencyDisplayMode={setCurrencyDisplayMode}
                    taxEnabled={taxEnabled}
                    setTaxEnabled={setTaxEnabled}
                    taxRate={taxRate}
                    setTaxRate={setTaxRate}
                    discountPercentEnabled={discountPercentEnabled}
                    setDiscountPercentEnabled={setDiscountPercentEnabled}
                    discountFixedEnabled={discountFixedEnabled}
                    setDiscountFixedEnabled={setDiscountFixedEnabled}
                    trackCapital={trackCapital}
                    setTrackCapital={setTrackCapital}
                    initialCapital={initialCapital}
                    setInitialCapital={setInitialCapital}
                    slot1Code={slot1Code}
                    setSlot1Code={setSlot1Code}
                    slot2Code={slot2Code}
                    setSlot2Code={setSlot2Code}
                    toggleCurrency={toggleCurrency}
                    renderCurrencyDisplayOptions={renderCurrencyDisplayOptions}
                    sanitizeNumberText={sanitizeNumberText}
                  />
                </Suspense>
              </TabsContent>
            </Tabs>
          </div>
        );

      // currencies tab removed - now inside store tab

      // sync tab merged into backup below

      case 'notifications':
        return (
          <div className="space-y-4">
            {/* إذن إشعارات الجهاز: يُطلب هنا فقط بضغطة من المستخدم */}
            {notificationPerm !== 'granted' && (
              <div className="p-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                    <Bell className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-foreground">إشعارات الجهاز غير مفعّلة</p>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      فعّلها ليصلك تنبيه نفاد المخزون، والديون المستحقة، وردود الدعم الفني، والتحديثات الجديدة حتى والتطبيق في الخلفية.
                    </p>
                  </div>
                </div>
                {notificationPerm === 'denied' ? (
                  <p className="text-[11px] text-muted-foreground">
                    تم رفض الإذن سابقاً. فعّله من إعدادات الهاتف: التطبيقات ← PosFlow ← الإشعارات.
                  </p>
                ) : (
                  <Button className="w-full sm:w-auto" onClick={() => void handleRequestNotificationPermission()}>
                    تفعيل إشعارات الجهاز
                  </Button>
                )}
              </div>
            )}
            {/* بطاقة التفعيل الشامل للإشعارات */}
            <div className={`p-4 rounded-2xl border transition-all flex items-center justify-between ${
              notificationSettings.masterEnabled
                ? 'bg-primary/5 border-primary/20 shadow-sm'
                : 'bg-muted/40 border-border/60'
            }`}>
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                  notificationSettings.masterEnabled ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
                }`}>
                  <Bell className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-foreground">
                    {notificationSettings.masterEnabled ? 'الإشعارات مفعلة' : 'الإشعارات معطلة'}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {notificationSettings.masterEnabled
                      ? 'سيتم إرسال جميع التنبيهات المحددة في النظام'
                      : 'لن تصلك أي تنبيهات داخلية حتى تعيد التفعيل'}
                  </p>
                </div>
              </div>
              <Switch
                checked={notificationSettings.masterEnabled}
                onCheckedChange={(checked) => setNotificationSettings({ ...notificationSettings, masterEnabled: checked })}
              />
            </div>

            {/* إعدادات الصوت ومدة العرض */}
            <div className={`bg-card/80 dark:bg-card/40 rounded-2xl border border-border/50 divide-y divide-border/40 overflow-hidden transition-opacity ${
              notificationSettings.masterEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none'
            }`}>
              <div className="px-4 py-3 bg-muted/20">
                <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">إعدادات العرض والصوت</h2>
              </div>
              {/* الصوت */}
              <div className="flex items-center justify-between px-4 py-3 hover:bg-muted/20 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    {notificationSettings.sound ? <Volume2 className="w-4 h-4 text-primary" /> : <VolumeX className="w-4 h-4 text-muted-foreground" />}
                  </div>
                  <div>
                    <span className="text-sm font-medium text-foreground block">{t('settings.sound')}</span>
                    <span className="text-xs text-muted-foreground block">
                      {notificationSettings.sound ? 'تشغيل نغمة عند وصول التنبيه' : 'كتم الصوت'}
                    </span>
                  </div>
                </div>
                <Switch
                  checked={notificationSettings.sound}
                  onCheckedChange={(checked) => setNotificationSettings({ ...notificationSettings, sound: checked })}
                />
              </div>

              {/* وقت بقاء الإشعار على الشاشة (من نصف ثانية إلى 3 ثواني) */}
              <div className="px-4 py-3.5 hover:bg-muted/20 transition-colors">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <Clock className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                      <span className="text-sm font-medium text-foreground block">وقت بقاء الإشعار</span>
                      <span className="text-xs text-muted-foreground block">
                        المدة الزمنية لظهور الإشعار على الشاشة قبل الانكماش التلقائي (من 0.5 إلى 3 ثواني)
                      </span>
                    </div>
                  </div>
                  <span className="font-mono text-xs font-bold text-primary bg-primary/10 px-2.5 py-1 rounded-lg border border-primary/20">
                    {notificationSettings.durationSeconds ?? 2} ثانية
                  </span>
                </div>
                <div dir="ltr" className="space-y-1.5 pt-1 px-1">
                  <Slider
                    value={[notificationSettings.durationSeconds ?? 2]}
                    onValueChange={([val]) => {
                      setNotificationSettings({ ...notificationSettings, durationSeconds: val });
                      localStorage.setItem('posflow_toast_duration', String(val * 1000));
                    }}
                    min={0.5}
                    max={3}
                    step={0.5}
                    className="w-full cursor-pointer"
                  />
                  <div className="flex justify-between text-[11px] font-mono text-muted-foreground">
                    <span>0.5s (خاطف)</span>
                    <span>1.5s (متوسط)</span>
                    <span>3.0s (أطول)</span>
                  </div>
                </div>
              </div>
            </div>

            {/* تصنيفات أحداث الإشعارات السبعة المفصلة */}
            <div className={`space-y-4 pt-1 transition-opacity ${
              notificationSettings.masterEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none'
            }`}>
              <div className="flex items-center justify-between px-1">
                <div>
                  <h3 className="text-sm font-bold text-foreground">تخصيص تنبيهات النظام حسب القسم</h3>
                  <p className="text-xs text-muted-foreground">تفعيل أو كتم التنبيه الفوري لكل حدث تشغيلي في النظام</p>
                </div>
              </div>

              {NOTIFICATION_EVENT_GROUPS.map((group) => {
                const IconComp = getCategoryIconComponent(group.icon);
                const colors = getCategoryColorClasses(group.color);
                const currentEvents = notificationSettings.events || {};
                
                const activeCount = group.events.filter(evt => currentEvents[evt.key] ?? evt.defaultEnabled).length;
                const totalCount = group.events.length;

                return (
                  <div
                    key={group.id}
                    className="bg-card/80 dark:bg-card/40 rounded-2xl border border-border/50 overflow-hidden shadow-sm"
                  >
                    {/* ترويسة المجموعة */}
                    <div className="px-4 py-3 bg-muted/20 border-b border-border/40 flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${colors.bg}`}>
                          <IconComp className="w-4 h-4" />
                        </div>
                        <span className="text-sm font-bold text-foreground">{group.title}</span>
                      </div>
                      <Badge variant="outline" className={`text-[11px] font-mono font-medium ${colors.badge}`}>
                        {activeCount} / {totalCount} مفعل
                      </Badge>
                    </div>

                    {/* قائمة أحداث المجموعة */}
                    <div className="divide-y divide-border/30">
                      {group.events.map((evt) => {
                        const isChecked = currentEvents[evt.key] ?? evt.defaultEnabled;
                        return (
                          <div
                            key={evt.key}
                            className="flex items-center justify-between px-4 py-3 hover:bg-muted/15 transition-colors"
                          >
                            <div className="min-w-0 pr-2">
                              <span className={`text-sm block transition-colors ${
                                isChecked ? 'font-medium text-foreground' : 'text-muted-foreground'
                              }`}>
                                {evt.title}
                              </span>
                            </div>
                            <Switch
                              checked={isChecked}
                              onCheckedChange={(checked) => {
                                setNotificationSettings({
                                  ...notificationSettings,
                                  events: {
                                    ...(notificationSettings.events || getDefaultNotificationEvents()),
                                    [evt.key]: checked,
                                  },
                                });
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );

            case 'printing':
        return (
          <Suspense fallback={<div className="p-8 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>}>
            <PrinterSettingsSection
              printerConfig={printerConfig}
              handleUpdatePrinterConfig={handleUpdatePrinterConfig}
              handleTestPrint={handleTestPrint}
              handleMainTestPrint={handleMainTestPrint}
              isTestingPrint={isTestingPrint}
              printSettings={printSettings}
              setPrintSettings={setPrintSettings}
              isPrinterConnected={isPrinterConnected}
              setShowBtDialog={setShowBtDialog}
              setShowUnpairDialog={setShowUnpairDialog}
            />
          </Suspense>
        );

      case 'users':
        return <UsersTab />;

            case 'backup':
        return (
          <Suspense fallback={<div className="p-8 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>}>
            <BackupSettingsSection
              handleBackupNow={handleBackupNow}
              isBackingUp={isBackingUp}
              handleImportBackup={handleImportBackup}
              isImporting={isImporting}
              lastBackupResult={lastBackupResult}
              backupSettings={backupSettings}
              setBackupSettings={setBackupSettings}
              syncSettings={syncSettings}
              handleSync={handleSync}
              isSyncing={isSyncing}
              backups={backups}
              handleRestoreBackup={handleRestoreBackup}
              handleDeleteBackup={handleDeleteBackup}
              importInputRef={importInputRef}
            />
          </Suspense>
        );

      case 'license':
        return (
          <div className="space-y-6">
            <Card className="mb-6 border-primary/20 bg-gradient-to-br from-card to-primary/5">
              <CardContent className="pt-6 space-y-4">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-lg">{licenseState.isTrial ? 'فترة تجريبية' : 'اشتراك مفعّل'}</h3>
                      <Badge variant={licenseState.isTrial ? 'outline' : 'default'}>
                        {(licenseState as any).planName || (licenseState as any).licenseTier || 'الترخيص الأساسي'}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      تاريخ الانتهاء: {licenseState.expiresAt ? new Date(licenseState.expiresAt).toLocaleDateString('ar-SY') : 'غير محدد'}
                    </p>
                  </div>
                  <Button onClick={() => navigate('/renew')} className="gap-2 shrink-0">
                    تجديد / ترقية الاشتراك
                  </Button>
                </div>

                {/* شريط الأيام المتبقية */}
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-medium">
                    <span>المتبقي: {licenseState.remainingDays ?? 0} يوماً</span>
                    <span>إجمالي المدة: {(licenseState as any).totalDays || 30} يوماً</span>
                  </div>
                  <div className="w-full bg-muted h-2.5 rounded-full overflow-hidden">
                    <div 
                      className={`h-full rounded-full transition-all ${
                        (licenseState.remainingDays ?? 0) <= 3 ? 'bg-destructive' : (licenseState.remainingDays ?? 0) <= 10 ? 'bg-amber-500' : 'bg-primary'
                      }`}
                      style={{ width: `${Math.min(100, Math.max(5, (((licenseState.remainingDays ?? 0)) / ((licenseState as any).totalDays || 30)) * 100))}%` }}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* إدخال كود التفعيل اليدوي مُلغى: التفعيل يتم من لوحة الإدارة فقط */}
            {/* Transfer License Button */}
            <div className="bg-card rounded-2xl border border-border p-4 space-y-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Smartphone className="w-4 h-4" />
                {t('settings.transferLicense')}
              </h3>
              <p className="text-xs text-muted-foreground">
                {isRTL
                  ? 'فك ارتباط الترخيص من هذا الجهاز لتتمكن من تفعيله على جهاز جديد. سيتم تسجيل خروجك تلقائياً.'
                  : 'Unbind the license from this device so you can activate it on a new one. You will be signed out automatically.'}
              </p>
              <Button
                variant="outline"
                className="w-full gap-2 border-orange-500/50 text-orange-600 hover:bg-orange-500/10"
                onClick={() => setTransferDialogOpen(true)}
              >
                <Smartphone className="w-4 h-4" />
                {t('settings.transferLicenseDesc')}
              </Button>
            </div>
          </div>
        );

      case 'licenses':
        return (
          <div className="space-y-6">
            <div className="bg-card rounded-2xl border border-border p-6 md:p-8 flex flex-col items-center justify-center text-center gap-4">
              <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center">
                <Shield className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-foreground mb-1">{t('settings.bossPanel')}</h3>
                <p className="text-sm text-muted-foreground">{t('settings.goToBossPanel')}</p>
              </div>
              {bossPasswordError && (
                <p className="text-sm text-destructive">{bossPasswordError}</p>
              )}
              <div className="w-full max-w-xs space-y-3">
                <div className="relative">
                  <Input
                    type={showBossPassword ? 'text' : 'password'}
                    value={bossPassword}
                    onChange={(e) => { setBossPassword(e.target.value); setBossPasswordError(''); }}
                    placeholder={t('auth.password')}
                    className="pe-10"
                    onKeyDown={(e) => { if (e.key === 'Enter') handleOpenBossPanel(); }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowBossPassword(!showBossPassword)}
                    className="absolute top-1/2 -translate-y-1/2 end-3 text-muted-foreground"
                  >
                    {showBossPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <Button
                  onClick={handleOpenBossPanel}
                  disabled={isVerifyingBossPassword || !bossPassword}
                  className="w-full gap-2"
                >
                  {isVerifyingBossPassword ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
                  {t('common.open')}
                </Button>
              </div>
            </div>
          </div>
        );

      case 'contact':
        return (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center">
                <Phone className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="font-medium text-foreground">
                  {t('license.contactDeveloper')}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {isRTL ? 'تواصل مع فريق الدعم الفني' : 'Contact the support team'}
                </p>
              </div>
            </div>
            <ContactLinksSection />
          </div>
        );

      case 'partners':
        return <Partners />;

      case 'reset':
        return <DataResetSection />;

      case 'about': {
        // Read version injected at build time by vite.config.ts from version.json
        const versionInfo = typeof __APP_VERSION__ !== 'undefined'
          ? __APP_VERSION__
          : { versionName: '1.0.59', versionCode: 289, lastUpdated: '2026-10-02T04:00:00.000Z' };

        const releaseDate = new Date(versionInfo.lastUpdated);
        const releaseDateStr = releaseDate.toLocaleDateString(isRTL ? 'ar-SA' : 'en-US', {
          year: 'numeric', month: 'long', day: 'numeric'
        });

        // Load changelog from build-time injection (limited to latest update fixes only)
        const rawChangelog = (globalThis as unknown as { __APP_CHANGELOG__?: unknown }).__APP_CHANGELOG__ ?? (typeof __APP_CHANGELOG__ !== 'undefined' ? __APP_CHANGELOG__ : null);
        const changelog: { type: 'new' | 'improved' | 'fixed'; ar: string; en: string }[] = Array.isArray(rawChangelog) && rawChangelog.length > 0
          ? rawChangelog.slice(0, 8)
          : [
            { type: 'improved', ar: 'تسريع فتح شاشة نقطة البيع واستبعاد المؤرشف ومزامنة المخزون اللحظية مع استرداد الفواتير', en: 'POS loading acceleration, archived exclusion, and real-time stock sync upon refunds' },
            { type: 'improved', ar: 'تفصيل رسائل أخطاء تسجيل الدخول وإنشاء الحساب وتوضيح أسباب الفشل بدقة', en: 'Detailed auth error messages for login and signup' },
            { type: 'improved', ar: 'تدقيق رسائل المزامنة والإنترنت وإظهار أسباب الرفض الصادرة من الخادم بدقة', en: 'Accurate sync error messages with server feedback' },
            { type: 'new', ar: 'إظهار تاريخ ووقت البناء الفعلي ورقم الإصدار في شاشة الإعدادات', en: 'Display build timestamp and version details in Settings' },
          ];

        return (
          <div className="space-y-5">
            {/* App Identity */}
            <div className="flex items-center gap-4 p-4 rounded-2xl bg-primary/5 border border-primary/10">
              <img src={appIconUrl} alt="PosFlow" className="w-16 h-16 rounded-2xl shadow-md flex-shrink-0 object-contain" />
              <div>
                <h2 className="text-xl font-bold text-foreground">PosFlow</h2>
                <p className="text-sm text-muted-foreground">{isRTL ? 'نظام نقطة البيع المتكامل' : 'Integrated Point of Sale System'}</p>
              </div>
            </div>

            {/* Version Info */}
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
              <div className="px-4 py-2.5 border-b border-border bg-muted/30">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  {isRTL ? 'معلومات الإصدار' : 'Version Info'}
                </p>
              </div>
              <div className="divide-y divide-border">
                {[
                  { label: isRTL ? 'الإصدار الحالي' : 'Current Version', value: `v${versionInfo.versionName}`, icon: '🏷️' },
                  { label: isRTL ? 'تاريخ الإصدار' : 'Release Date', value: releaseDateStr, icon: '📅' },
                  { label: isRTL ? 'المنصة' : 'Platform', value: 'Android / Web / Windows', icon: '📱' },
                  { label: isRTL ? 'المطور' : 'Developer', value: 'PosFlow Team', icon: '👨‍💻' },
                ].map((item) => (
                  <div key={item.label} className="flex items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-base">{item.icon}</span>
                      <span className="text-sm text-muted-foreground">{item.label}</span>
                    </div>
                    <span className="text-sm font-medium text-foreground font-mono">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Changelog */}
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
              <div className="px-4 py-2.5 border-b border-border bg-muted/30">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  {isRTL
                    ? `آخر التحديثات — الإصدار ${versionInfo.versionName}`
                    : `Latest Updates — v${versionInfo.versionName}`}
                </p>
              </div>
              <div className="divide-y divide-border">
                {changelog.map((item, idx) => {
                  const colors = {
                    new: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                    improved: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
                    fixed: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
                  };
                  const labels = {
                    new: isRTL ? 'جديد' : 'NEW',
                    improved: isRTL ? 'تحسين' : 'IMPROVED',
                    fixed: isRTL ? 'إصلاح' : 'FIXED',
                  };
                  return (
                    <div key={idx} className="flex items-start gap-3 px-4 py-3">
                      <span className={`mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-md flex-shrink-0 ${colors[item.type]}`}>
                        {labels[item.type]}
                      </span>
                      <p className="text-sm text-foreground leading-relaxed">{isRTL ? item.ar : item.en}</p>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Footer */}
            <p className="text-center text-xs text-muted-foreground pb-2">
              {isRTL ? 'جميع الحقوق محفوظة © ٢٠٢٦ PosFlow' : '© 2026 PosFlow. All rights reserved.'}
            </p>
          </div>
        );
      }

      default:
        return null;
    }
  };



  return (
    <div className="p-4 md:p-6 space-y-6 overflow-x-hidden max-w-full">
      {activeTab === null ? (
        <>
          {/* Header */}
          <PageHeader
            title={t('settings.title')}
            subtitle={t('settings.subtitle')}
          />

          {/* Instant Search Bar & Layout Switcher */}
          <div className="flex items-center gap-2 mb-3.5">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-muted-foreground absolute start-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <Input
                type="text"
                id="settingsSearchInput"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={isRTL ? "بحث سريع في الإعدادات، التراخيص، العملات..." : "Search settings, licenses, currencies..."}
                className="bg-card border border-border/80 rounded-2xl h-10 ps-10 pe-9 text-xs font-semibold placeholder:text-muted-foreground/60 shadow-2xs focus-visible:ring-primary/20"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 rounded-full"
                  title={isRTL ? "مسح البحث" : "Clear search"}
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Layout Toggle Buttons */}
            <div className="flex items-center bg-muted/60 p-1 rounded-2xl border border-border/70 shrink-0 h-10 gap-0.5">
              <button
                type="button"
                onClick={() => handleLayoutChange('grid')}
                className={cn(
                  "p-1.5 rounded-xl transition-all",
                  settingsLayout === 'grid'
                    ? "bg-background text-foreground shadow-xs font-bold"
                    : "text-muted-foreground hover:text-foreground"
                )}
                title={isRTL ? "عرض شبكي" : "Grid View"}
                aria-label={isRTL ? "عرض شبكي" : "Grid View"}
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => handleLayoutChange('list')}
                className={cn(
                  "p-1.5 rounded-xl transition-all",
                  settingsLayout === 'list'
                    ? "bg-background text-foreground shadow-xs font-bold"
                    : "text-muted-foreground hover:text-foreground"
                )}
                title={isRTL ? "عرض قائمة" : "List View"}
                aria-label={isRTL ? "عرض قائمة" : "List View"}
              >
                <List className="w-4 h-4" />
              </button>
            </div>
          </div>

          {(() => {
            const visibleTabs = settingsTabs.filter(tab => {
              if (isGuestDemoMode()) {
                if (tab.id === 'licenses' || tab.id === 'license') {
                  return false;
                }
              }
              if (isBoss) return true;
              if (isOwnerAdmin && !tab.bossOnly) return true;
              return !tab.adminOnly && !tab.bossOnly;
            });

            const filteredTabs = visibleTabs.filter(tab => {
              if (!searchQuery.trim()) return true;
              const q = searchQuery.toLowerCase().trim();
              const matchLabel = tab.label.toLowerCase().includes(q);
              const matchDesc = (tab.description || '').toLowerCase().includes(q);
              const matchKeywords = (tab.keywords || []).some(k => k.toLowerCase().includes(q));
              return matchLabel || matchDesc || matchKeywords;
            });

            const getStoreTypeLabel = (type: string) => {
              const map: Record<string, string> = {
                phones: isRTL ? 'هواتف وإلكترونيات' : 'Phones & Electronics',
                electronics: isRTL ? 'إلكترونيات' : 'Electronics',
                clothing: isRTL ? 'ملابس وأزياء' : 'Clothing & Fashion',
                grocery: isRTL ? 'بقالة ومواد غذائية' : 'Grocery & Food',
                supermarket: isRTL ? 'سوبرماركت' : 'Supermarket',
                perfumes: isRTL ? 'عطور ومستحضرات' : 'Perfumes & Cosmetics',
                pharmacy: isRTL ? 'صيدلية' : 'Pharmacy',
                bakery: isRTL ? 'مخبز وحلويات' : 'Bakery & Sweets',
                bookstore: isRTL ? 'مكتبة وقرطاسية' : 'Bookstore & Stationery',
                services: isRTL ? 'خدمات وصيانة' : 'Services & Maintenance',
                restaurant: isRTL ? 'مطعم ومقهى' : 'Restaurant & Cafe',
                general: isRTL ? 'نشاط تجاري عام' : 'General Store',
              };
              return map[type] || type;
            };

            const getTabColorClasses = (color?: string, danger?: boolean) => {
              if (danger) {
                return {
                  bg: 'bg-destructive/10 text-destructive border-destructive/20',
                  badge: 'bg-destructive/10 text-destructive border-destructive/25',
                };
              }
              switch (color) {
                case 'rose':
                  return {
                    bg: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
                    badge: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/20',
                  };
                case 'amber':
                  return {
                    bg: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
                    badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20',
                  };
                case 'blue':
                  return {
                    bg: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
                    badge: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/20',
                  };
                case 'purple':
                  return {
                    bg: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20',
                    badge: 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/20',
                  };
                case 'teal':
                  return {
                    bg: 'bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/20',
                    badge: 'bg-teal-500/10 text-teal-700 dark:text-teal-300 border-teal-500/20',
                  };
                case 'indigo':
                  return {
                    bg: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
                    badge: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/20',
                  };
                case 'emerald':
                  return {
                    bg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
                    badge: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20',
                  };
                case 'orange':
                  return {
                    bg: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20',
                    badge: 'bg-orange-500/10 text-orange-700 dark:text-orange-300 border-orange-500/20',
                  };
                case 'cyan':
                  return {
                    bg: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20',
                    badge: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border-cyan-500/20',
                  };
                default:
                  return {
                    bg: 'bg-primary/10 text-primary border-primary/20',
                    badge: 'bg-muted text-muted-foreground border-border/50',
                  };
              }
            };

            // Empty search state
            if (filteredTabs.length === 0) {
              return (
                <div className="py-12 text-center text-muted-foreground bg-card/50 rounded-2xl border border-dashed border-border/70 p-6 space-y-3">
                  <Search className="w-8 h-8 mx-auto text-muted-foreground/40" />
                  <p className="text-sm font-bold text-foreground">
                    {isRTL ? 'لا توجد نتائج مطابقة لبحثك' : 'No matching settings found'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {isRTL ? `لم نجد أي إعداد يطابق "${searchQuery}"` : `No setting matching "${searchQuery}"`}
                  </p>
                  <Button variant="outline" size="sm" onClick={() => setSearchQuery('')} className="rounded-xl text-xs h-8">
                    {isRTL ? 'مسح البحث' : 'Clear search'}
                  </Button>
                </div>
              );
            }

                        return settingsLayout === 'grid' ? (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5 sm:gap-3">
                {filteredTabs.map(tab => {
                  const colors = getTabColorClasses(tab.color, tab.danger);
                  return (
                    <div
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={cn(
                        "bg-card border border-border/80 rounded-2xl md:rounded-3xl p-3 md:p-3.5 text-center flex flex-col items-center justify-between hover:border-primary/50 hover:shadow-md active:scale-95 transition-[transform,box-shadow,border-color] duration-150 cursor-pointer min-h-[7.85rem] md:min-h-[8.57rem] group",
                        tab.danger && "hover:border-destructive/60"
                      )}
                    >
                      <div className={cn("size-9 md:size-10 rounded-xl flex items-center justify-center shrink-0 border group-hover:scale-105 transition-transform mb-1.5", colors.bg)}>
                        <tab.icon className="w-4.5 h-4.5 md:w-5 md:h-5" />
                      </div>
                      <div className="w-full">
                        <span className="font-bold text-xs md:text-sm text-foreground leading-tight text-center line-clamp-1 block group-hover:text-primary transition-colors">
                          {tab.label}
                        </span>
                        {tab.description && (
                          <span className="text-[10px] text-muted-foreground font-medium text-center line-clamp-1 block mt-0.5">
                            {tab.description}
                          </span>
                        )}
                      </div>
                      {tab.badge && (
                        <span className={cn("text-[9px] font-bold px-1.5 py-0.2 rounded-full border mt-1 shrink-0", colors.badge)}>
                          {tab.badge}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-2">
                {filteredTabs.map(tab => {
                  const colors = getTabColorClasses(tab.color, tab.danger);
                  return (
                    <div
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={cn(
                        "bg-card border border-border/80 rounded-2xl p-3 sm:p-3.5 flex items-center justify-between gap-3 hover:border-primary/50 hover:shadow-sm active:scale-[0.99] transition-[transform,box-shadow,border-color] duration-150 cursor-pointer group",
                        tab.danger && "hover:border-destructive/60"
                      )}
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className={cn("size-10 rounded-xl flex items-center justify-center shrink-0 border group-hover:scale-105 transition-transform", colors.bg)}>
                          <tab.icon className="w-5 h-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-xs md:text-sm text-foreground truncate group-hover:text-primary transition-colors">
                              {tab.label}
                            </span>
                            {tab.badge && (
                              <span className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded-full border shrink-0", colors.badge)}>
                                {tab.badge}
                              </span>
                            )}
                          </div>
                          {tab.description && (
                            <p className="text-[11px] text-muted-foreground font-medium truncate mt-0.5">
                              {tab.description}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="shrink-0 text-muted-foreground/50 group-hover:text-primary transition-colors">
                        {isRTL ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </>
      ) : (
        <>
          {/* Sub-page header with back button */}
          <div className="flex items-center gap-2.5 rtl:pr-12 ltr:pl-12 md:rtl:pr-0 md:ltr:pl-0">
            <button
              type="button"
              onClick={() => setActiveTab(null)}
              aria-label={t('common.back') || 'رجوع'}
              className="flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-xl border border-border/70 bg-card hover:bg-muted transition-colors flex-shrink-0 shadow-sm"
            >
              {isRTL ? <ArrowRight className="w-4 h-4 sm:w-5 sm:h-5" /> : <ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5" />}
            </button>
            {(() => {
              const current = settingsTabs.find(tab => tab.id === activeTab);
              if (!current) return null;
              return (
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
                    <current.icon className="w-4 h-4 sm:w-5 sm:h-5" />
                  </div>
                  <h1 className="text-base sm:text-xl md:text-2xl font-bold text-foreground truncate">{current.label}</h1>
                </div>
              );
            })()}
          </div>

          {/* Content */}
          <div className="bg-card/70 sm:bg-card rounded-2xl border border-border/70 sm:border-border p-3.5 sm:p-6 overflow-hidden max-w-full pb-28">
            {/* ✅ حماية كل تبويب داخل إطار معالجة الأخطاء FeatureErrorBoundary لعزل أي خطأ دون إسقاط الشاشة */}
            <FeatureErrorBoundary
              featureName={`تبويب الإعدادات: ${activeTab || 'العام'}`}
              compact
            >
              <Suspense fallback={
                <div className="flex items-center justify-center p-8 text-muted-foreground">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                </div>
              }>
                {renderTabContent()}
              </Suspense>
            </FeatureErrorBoundary>
          </div>
        </>
      )}

      {/* Transfer License Dialog */}
      <AlertDialog open={transferDialogOpen} onOpenChange={(open) => {
        setTransferDialogOpen(open);
        if (!open) { setTransferPassword(''); setShowTransferPassword(false); }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.transferLicenseDesc')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.transferLicenseConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <div className="relative">
              <Input
                type={showTransferPassword ? 'text' : 'password'}
                value={transferPassword}
                onChange={(e) => setTransferPassword(e.target.value)}
                placeholder={t('settings.password')}
                className="pe-10"
                onKeyDown={(e) => { if (e.key === 'Enter' && transferPassword) handleTransferLicense(); }}
              />
              <button
                type="button"
                onClick={() => setShowTransferPassword(!showTransferPassword)}
                className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              >
                {showTransferPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <Button
              onClick={handleTransferLicense}
              disabled={!transferPassword || isTransferring}
              className="bg-orange-600 hover:bg-orange-700 text-white"
            >
              {isTransferring ? <Loader2 className="w-4 h-4 animate-spin" /> : <Smartphone className="w-4 h-4" />}
              {t('settings.confirmUnbind')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Floating Action Buttons (FAB) موحد ومطابق للمظهر */}
      <div
        className={cn(
          "fixed bottom-[calc(1.5rem+env(safe-area-inset-bottom))] z-50 flex items-center gap-3 transition-[opacity,transform] duration-300 ease-in-out",
          isRTL ? "left-6" : "right-6",
          (hasUnsavedChanges || isSaveSuccess)
            ? "scale-100 opacity-100"
            : "scale-0 opacity-0 pointer-events-none"
        )}
      >
        <Button
          onClick={handleSaveSettings}
          disabled={isSavingSettings}
          className={cn(
            "w-14 h-14 rounded-full shadow-2xl p-0 transition-[transform,colors] duration-200",
            isSaveSuccess
              ? (lastSaveStatus === 'synced' ? "bg-emerald-600 text-white hover:bg-emerald-700" : "bg-amber-600 text-white hover:bg-amber-700")
              : "bg-primary text-primary-foreground hover:scale-105 active:scale-95"
          )}
          title={t('common.save') || (isRTL ? 'حفظ' : 'Save')}
        >
          {isSavingSettings ? (
            <Loader2 className="w-6 h-6 animate-spin" />
          ) : isSaveSuccess ? (
            lastSaveStatus === 'synced' ? <Check className="w-6 h-6 stroke-[3]" /> : <Clock className="w-6 h-6" />
          ) : (
            <Save className="w-6 h-6" />
          )}
        </Button>
        {hasUnsavedChanges && !isSaveSuccess && (
          <Button
            variant="secondary"
            onClick={handleRevert}
            className="w-14 h-14 rounded-full shadow-2xl p-0 hover:scale-105 active:scale-95 transition-transform"
            title={t('common.cancel') || (isRTL ? 'تراجع' : 'Cancel')}
          >
            <Undo2 className="w-6 h-6" />
          </Button>
        )}
      </div>

      {/* تأكيد تغيير التصنيفات عند تغيير نوع المحل */}
      <Dialog open={storeTypeConfirmOpen} onOpenChange={setStoreTypeConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.updateCategories')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('settings.updateCategoriesDesc')}
          </p>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  await saveUnifiedStoreSettings({
                    updatedAt: Date.now(),
                    storeSettings: { ...storeSettings, type: storeSettings.type },
                  });
                } catch (e) { console.warn('[Settings] Unified store_type save failed:', e); }
                setStoreTypeConfirmOpen(false);
                setPendingStoreType(null);
                emitEvent(EVENTS.STORE_TYPE_CHANGED);
                toast({
                  title: t('settings.updated'),
                  description: t('settings.fieldsOnlyUpdated'),
                });
              }}
            >
              {t('settings.keepCurrentCategories')}
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (pendingStoreType) {
                  const defaultCats = getDefaultCategories(pendingStoreType);
                  const newCategories: Category[] = defaultCats.map((name, i) => ({
                    id: `auto_${Date.now()}_${i}`,
                    name,
                    createdAt: new Date().toISOString(),
                  }));
                  saveCategories(newCategories);
                  // Sync categories to cloud
                  (async () => {
                    try {
                      const { loadCategoriesCloud, deleteCategoryCloud, addCategoryCloud, invalidateCategoriesCache } = await import('@/lib/cloud/categories-cloud');
                      const existing = await loadCategoriesCloud();
                      await Promise.allSettled(existing.map(c => deleteCategoryCloud(c.id)));
                      invalidateCategoriesCache();
                      await Promise.allSettled(defaultCats.map(name => addCategoryCloud(name)));
                    } catch (e) {
                      console.warn('[Settings] Cloud category sync failed:', e);
                    }
                  })();
                }
                try {
                  await saveUnifiedStoreSettings({
                    updatedAt: Date.now(),
                    storeSettings: { ...storeSettings, type: storeSettings.type },
                  });
                } catch (e) { console.warn('[Settings] Unified store_type save failed:', e); }
                setStoreTypeConfirmOpen(false);
                setPendingStoreType(null);
                emitEvent(EVENTS.STORE_TYPE_CHANGED);
                toast({
                  title: t('settings.updated'),
                  description: t('settings.fieldsAndCategoriesUpdated'),
                });
              }}
            >
              {t('settings.replaceCategories')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* نافذة إضافة واقتران طابعة البلوتوث */}
      <BluetoothPrinterDialog
        open={showBtDialog}
        onOpenChange={setShowBtDialog}
        isRTL={isRTL}
        paperWidth={(printerConfig.paperWidth === 'A4' ? '80mm' : printerConfig.paperWidth) as PaperWidth}
        onSaved={() => {
          setPrinterConfig(getStoredPrinterConfig());
          setIsPrinterConnected(true);
        }}
      />

      {/* AlertDialog تأكيد فصل الطابعة */}
      <AlertDialog open={showUnpairDialog} onOpenChange={setShowUnpairDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('printer.disconnectTitle') || 'فصل الطابعة؟'}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('printer.disconnectBody') || 'ما رح نحذف الاقتران من إعدادات الهاتف، بس التطبيق بيوقف الطباعة على هالطابعة. تقدر تربطها من جديد بأي وقت.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel') || 'إلغاء'}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmUnpair} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">
              {t('printer.unpair') || 'فصل'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* نافذة التحقق من ملكية رقم هاتف المتجر ونقله */}
      <RestoreWarningDialog
        open={!!pendingRestore}
        fileName={pendingRestore?.fileName || ''}
        summary={pendingRestore?.summary || ''}
        busy={isRestoring}
        onConfirm={confirmRestore}
        onCancel={() => setPendingRestore(null)}
      />
      <StorePhoneVerificationDialog
        open={phoneVerificationOpen}
        onOpenChange={setPhoneVerificationOpen}
        phone={storeSettings.phone}
        status={phoneVerificationStatus}
        onSuccess={() => {
          // استكمال حفظ باقي الإعدادات فور نجاح التحقق
          executeSave();
        }}
      />

    </div>
  );
}
