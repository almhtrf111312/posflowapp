import { useState, useEffect, lazy, Suspense, type ReactElement } from 'react';
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Routes, Route, useSearchParams, useNavigate, useLocation, Outlet, Navigate } from "react-router-dom";
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { MainLayout } from "./components/layout/MainLayout";
import { NativeTabHost } from "./components/layout/NativeTabKeepAlive";
import { NotificationsProvider } from "./hooks/use-notifications";
import { AuthProvider } from "./hooks/use-auth";
import { AppLockProvider, useAppLock } from "./hooks/use-app-lock";
import { AppLockOverlay } from "./components/auth/AppLockOverlay";
import { MandatoryPinSetupModal } from "./components/auth/MandatoryPinSetupModal";
import { LanguageProvider, useLanguage } from "./hooks/use-language";
import { ThemeProvider } from "./hooks/use-theme";
import { LicenseProvider } from "./hooks/use-license";
import { UserRoleProvider } from "./hooks/use-user-role";
import { ProtectedRoute } from "./components/auth/ProtectedRoute";
import { RoleGuard } from "./components/auth/RoleGuard";
import { ExitConfirmDialog } from "./components/ExitConfirmDialog";
import { SetupWizard } from "./components/setup/SetupWizard";
import { useAuth } from "./hooks/use-auth";
import { useUserRole } from "./hooks/use-user-role";
import { Button } from "@/components/ui/button";
import { Loader2, Store, AlertCircle, RefreshCw, LogOut } from 'lucide-react';
import { LicenseGuard } from "./components/license/LicenseGuard";
import { RemoteUpdatesGate } from "./components/updates/RemoteUpdatesGate";
import { NotificationPermissionPrompt } from "./components/NotificationPermissionPrompt";
import { LicenseWarningBadge } from "./components/license/LicenseWarningBadge";
import { OfflineProtectionBanner } from "./components/license/OfflineProtectionBanner";
import { DemoModeBanner } from "./components/demo/DemoModeBanner";
import { CloudSyncProvider } from "./providers/CloudSyncProvider";
import { clearDemoDataOnce } from "./lib/clear-demo-data";
import { checkSettingsVersion } from "./lib/settings-version";
import { EVENTS } from "./lib/events";
import { saveLastRoute } from "./lib/last-route";
import { hideSplashScreen } from "./lib/splash-screen";
import { resolveEffectivePerformanceMode } from "./lib/performance-mode";
// Demo data loading removed - app uses cloud sync for data persistence
import { ClickProbe } from "./components/debug/ClickProbe";
import { SafeModeScreen } from "./components/debug/SafeModeScreen";
import { PrivacyPolicyScreen, usePrivacyAccepted } from "./components/PrivacyPolicyScreen";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";
import { FeatureErrorBoundary } from "@/components/debug/FeatureErrorBoundary";

// Lazy-loaded heavy pages to keep the initial startup bundle ultra-fast
// نقطة البيع هي الشاشة الأولى: يبدأ تحميلها فوراً مع الإقلاع بدلاً من انتظار أول رسم (يلغي شاشة "جاري تحميل الصفحة")
const posModule = import("./pages/POS");
const POS = lazy(() => posModule);
const Products = lazy(() => import("./pages/Products"));
const Customers = lazy(() => import("./pages/Customers"));
const Services = lazy(() => import("./pages/Services"));
const Invoices = lazy(() => import("./pages/Invoices"));
const InvoiceTracking = lazy(() => import("./pages/InvoiceTracking"));
const Expenses = lazy(() => import("./pages/Expenses"));
const CashShifts = lazy(() => import("./pages/CashShifts"));
const Settings = lazy(() => import("./pages/Settings"));
const Reports = lazy(() => import("./pages/Reports"));
const BossPanel = lazy(() => import("./pages/BossPanel"));
const Purchases = lazy(() => import("./pages/Purchases"));
const Appearance = lazy(() => import("./pages/Appearance"));
const LibraryMembers = lazy(() => import("./pages/LibraryMembers"));

/** يفتح القسم فقط لنوع المتجر الخاص به (مثل المكتبة)، وإلا يرجع للرئيسية — يتبع تغيير نوع المتجر فوراً */
function StoreTypeRoute({ types, children }: { types: string[]; children: ReactElement }) {
  const { storeType } = useLanguage();
  if (!types.includes(storeType)) return <Navigate to="/" replace />;
  return children;
}
const Help = lazy(() => import("./pages/Help"));
const ContactDeveloper = lazy(() => import("./pages/ContactDeveloper"));
const Renew = lazy(() => import("./pages/Renew"));
const Notifications = lazy(() => import("./pages/Notifications"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const Signup = lazy(() => import("./pages/Signup"));
import { WarehouseProvider } from "./hooks/use-warehouse";
import { useLicenseReminder } from "./hooks/use-license-reminder";
import { useDueExpensesChecker } from "./hooks/use-due-expenses-checker";
import { useNativeChatAlerts } from "./hooks/use-native-chat-alerts";
import { SmartToast } from '@/components/ui/SmartToast';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
  },
});

// Redirect components for merged routes
const DebtsRedirect = () => {
  const navigate = useNavigate();
  useEffect(() => { navigate('/customers?tab=debts', { replace: true }); }, [navigate]);
  return null;
};
const PartnersRedirect = () => {
  const navigate = useNavigate();
  useEffect(() => { navigate('/settings?tab=partners', { replace: true }); }, [navigate]);
  return null;
};

const IndexRoute = () => <POS />;

const MainLayoutWithKeepAlive = () => {
  const { user } = useAuth();
  return (
    <MainLayout>
      <NativeTabHost key={user?.id || 'guest'} />
    </MainLayout>
  );
};

const AppContent = () => {
  const { isLocked, requiresPinSetup } = useAppLock();
  const [searchParams] = useSearchParams();
  const location = useLocation();

  // Save last active route silently on navigation (used only on cold start restore)
  useEffect(() => {
    saveLastRoute(location.pathname + location.search);
  }, [location]);

  // Hide native splash screen immediately after initial layout render without waiting for cloud
  useEffect(() => {
    requestAnimationFrame(() => {
      hideSplashScreen();
    });
  }, []);

  // تفريغ السلة وحالتها من التخزين عند تشغيل التطبيق بالكامل (Cold Start) لضمان بدء السلة مغلقة دائماً
  useEffect(() => {
    try {
      localStorage.removeItem('hyperpos_temp_cart');
      localStorage.removeItem('hyperpos_cart_open');
      sessionStorage.removeItem('hyperpos_cart_open');
      localStorage.removeItem('hyperpos_cart_customer');
      localStorage.removeItem('hyperpos_cart_discount');
    } catch (e) {
      console.warn('[App] Failed to clear cart storage on startup:', e);
    }
  }, []);

  const isSafeMode = searchParams.get('safe') === '1';
  const isDebugClick = searchParams.get('debugclick') === '1';
  const isReset = searchParams.get('reset') === '1';


  // License expiration reminder toasts
  useLicenseReminder();

  // Android heads-up system tray and native chat notifications
  useNativeChatAlerts();

  // Staged & Progressive Bundle Pre-warming during idle time (Native Feel Pillar 4)
  useEffect(() => {
    // Respect Data Saver mode if user enabled it on mobile / slow connection
    if (typeof navigator !== 'undefined' && (navigator as any).connection?.saveData) {
      return;
    }

    const warmUpRoutes = () => {
      // Prioritized sequence: highest-frequency user paths loaded first
      const prioritizedTargets = [
        () => import("./pages/POS"),
        () => import("./pages/Products"),
        () => import("./pages/Invoices"),
        () => import("./pages/Customers"),
        () => import("./pages/Purchases"),
        () => import("./pages/Expenses"),
        () => import("./pages/Reports"),
        () => import("./pages/Services"),
        () => import("./pages/Settings"),
        () => import("./pages/Appearance"),
      ];

      // على الأجهزة الضعيفة (الوضع الخفيف) نجهّز الشاشات الثلاث الأكثر استخداماً فقط
      const targets = resolveEffectivePerformanceMode() === 'lite'
        ? prioritizedTargets.slice(0, 5)
        : prioritizedTargets;

      // شاشة واحدة في كل فترة خمول للمعالج (بدلاً من شاشة كل 350ms) حتى لا يتقطع التطبيق في ثوانيه الأولى
      let index = 0;
      const scheduleNext = () => {
        if (cancelled || index >= targets.length) return;
        const run = () => {
          if (cancelled) return;
          try { targets[index]().catch(() => {}); } catch {}
          index++;
          warmTimer = setTimeout(scheduleNext, 250);
        };
        if ('requestIdleCallback' in window) {
          (window as any).requestIdleCallback(run, { timeout: 1500 });
        } else {
          warmTimer = setTimeout(run, 500);
        }
      };
      scheduleNext();
    };

    let cancelled = false;
    let warmTimer: ReturnType<typeof setTimeout> | undefined;
    // البدء بعد استقرار الإقلاع بدلاً من التنافس مع الرسم الأول
    const startTimer = setTimeout(warmUpRoutes, 1200);
    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      if (warmTimer) clearTimeout(warmTimer);
    };
  }, []);

  // Privacy policy acceptance
  const { accepted: privacyAccepted, accept: acceptPrivacy } = usePrivacyAccepted();

  // Setup wizard state for fresh installations
  const { user, isLoading: authLoading, signOut } = useAuth();
  const { role, isLoading: roleLoading, refreshRole } = useUserRole();

  // 🔔 فحص المصاريف المستحقة والدفع التلقائي عند بدء تشغيل التطبيق
  useDueExpensesChecker();

  const [setupComplete, setSetupComplete] = useState<boolean>(() => {
    try {
      // Prioritize new signup flag over existing device settings
      if (sessionStorage.getItem('hyperpos_just_signed_up') === 'true') {
        return localStorage.getItem('hyperpos_setup_complete') === 'true';
      }
      return localStorage.getItem('hyperpos_setup_complete') === 'true' || !!localStorage.getItem('hyperpos_settings_v1');
    } catch { return true; }
  });

  // Re-read flag whenever the user changes (after login/logout) or settings are updated
  useEffect(() => {
    const checkState = () => {
      try {
        const isNew = sessionStorage.getItem('hyperpos_just_signed_up') === 'true';
        if (isNew) {
          // إذا كان المستخدم في جلسة إنشاء حساب جديد، لا تقم بضبط setupComplete إلى true من خلال أحداث المزامنة
          return;
        } else {
          setSetupComplete(localStorage.getItem('hyperpos_setup_complete') === 'true' || !!localStorage.getItem('hyperpos_settings_v1'));
        }
      } catch {}
    };
    checkState();
    window.addEventListener(EVENTS.SETTINGS_UPDATED, checkState);
    return () => window.removeEventListener(EVENTS.SETTINGS_UPDATED, checkState);
  }, [user?.id]);

  // Setup wizard state (can also be launched on demand from Settings or Help)
  const [manualShowSetup, setManualShowSetup] = useState(false);
  useEffect(() => {
    const handleOpenWizard = () => setManualShowSetup(true);
    window.addEventListener('hyperpos:open-setup-wizard', handleOpenWizard);
    return () => window.removeEventListener('hyperpos:open-setup-wizard', handleOpenWizard);
  }, []);

  // Handle reset mode
  useEffect(() => {
    if (isReset) {
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && (key.startsWith('hyperpos') || key === 'setup_complete') &&
              key !== 'hyperpos_privacy_accepted' &&
              key !== 'hyperpos_privacy_version' &&
              key !== 'hyperpos_language' &&
              key !== 'hyperpos_theme') {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));
        console.log('[App] Reset: cleared', keysToRemove.length, 'keys');
        window.location.href = '/';
      } catch (error) {
        console.error('[App] Reset failed:', error);
      }
    }
  }, [isReset]);

  // Clear any existing demo data on app start (one-time migration)
  useEffect(() => {
    if (isSafeMode) return;
    try {
      checkSettingsVersion();
      clearDemoDataOnce();
    } catch (error) {
      console.error('[App] Failed to initialize:', error);
    }
  }, [isSafeMode]);

  // ✅ Handle app restored result (camera data after app kill) - Native only
  useEffect(() => {
    // Only setup listener on native platforms
    if (!Capacitor.isNativePlatform()) return;

    let listenerHandle: any = null;

    const setupListener = async () => {
      listenerHandle = await CapApp.addListener('appRestoredResult', (data) => {
        console.log('[App Restored] Plugin data received:', data);

        // Handle Camera plugin data
        if (data.pluginId === 'Camera' && data.data) {
          try {
            // Save pending camera result for components to pick up
            localStorage.setItem('pendingCameraResult', JSON.stringify(data.data));

            // Emit custom event for immediate handling
            window.dispatchEvent(new CustomEvent('camera-restored', {
              detail: data.data
            }));

            console.log('[App Restored] Camera data saved successfully');
          } catch (e) {
            console.error('[App Restored] Failed to save camera data:', e);
          }
        }

        // Handle Barcode Scanner plugin data (ML Kit pluginId = 'BarcodeScanner')
        if ((data.pluginId === 'BarcodeScanner' || data.pluginId === 'CapacitorBarcodeScanner') && data.data) {
          try {
            // Extract barcode from all possible result shapes
            let scanResult: string | null = null;
            const d = data.data as any;
            if (d?.barcodes?.[0]?.rawValue) {
              scanResult = d.barcodes[0].rawValue;
            } else if (d?.rawValue) {
              scanResult = d.rawValue;
            } else if (d?.ScanResult) {
              scanResult = d.ScanResult;
            } else if (d?.result) {
              scanResult = d.result;
            } else if (typeof d === 'string') {
              scanResult = d;
            }

            if (scanResult) {
              console.log('[App Restored] Barcode scan result:', scanResult);
              localStorage.setItem('hyperpos_pending_scan', scanResult);

              // Emit custom event for immediate handling
              window.dispatchEvent(new CustomEvent('barcode-restored', {
                detail: scanResult
              }));
            }
          } catch (e) {
            console.error('[App Restored] Failed to save barcode data:', e);
          }
        }
      });
    };

    setupListener();

    return () => {
      if (listenerHandle) {
        listenerHandle.remove();
      }
    };
  }, []);

  // Handle new signup setup flow with explicit state guarding
  const isNewSignup = (() => {
    try {
      return sessionStorage.getItem('hyperpos_just_signed_up') === 'true';
    } catch { return false; }
  })();

  const [roleFallbackTimeout, setRoleFallbackTimeout] = useState(false);

  useEffect(() => {
    if (isNewSignup && roleLoading) {
      const timer = setTimeout(() => {
        setRoleFallbackTimeout(true);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [isNewSignup, roleLoading]);

  // Safe Mode - minimal UI for testing
  if (isSafeMode) {
    return (
      <>
        {isDebugClick && <ClickProbe />}
        <SafeModeScreen />
      </>
    );
  }

  // Privacy policy check
  if (!privacyAccepted) {
    return <PrivacyPolicyScreen onAccept={acceptPrivacy} />;
  }

  // Show setup wizard on manual trigger (from Settings or Help)
  if (manualShowSetup) {
    return (
      <SetupWizard
        isPreview={true}
        onComplete={() => {
          setManualShowSetup(false);
        }}
      />
    );
  }

  if (isNewSignup) {
    // 1. While auth state is resolving for new signup, show waiting screen
    if (authLoading) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background via-muted/30 to-background p-4" dir="rtl">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center animate-pulse">
              <Store className="w-7 h-7 text-primary" />
            </div>
            <div className="flex items-center gap-2 text-sm font-bold text-foreground">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              <span>جاري تهيئة حسابك الجديد...</span>
            </div>
            <p className="text-xs text-muted-foreground">يرجى الانتظار لحظات لإعداد متجرك</p>
          </div>
        </div>
      );
    }

    // 2. If user is authenticated, handle role resolution and setup wizard guard
    if (user) {
      const effectiveRole = role || (roleFallbackTimeout ? 'admin' : null);

      // 2a. Still determining user role -> display loading state only within 2s timeout
      if (roleLoading && !roleFallbackTimeout && !role) {
        return (
          <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background via-muted/30 to-background p-4" dir="rtl">
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center animate-pulse">
                <Store className="w-7 h-7 text-primary" />
              </div>
              <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span>جاري التحقق من صلاحيات الحساب وتجهيز المعالج...</span>
              </div>
              <p className="text-xs text-muted-foreground">نقوم بتهيئة إعدادات المتجر المناسبة لصلاحياتك</p>
            </div>
          </div>
        );
      }

      // 2b. Role is cashier: Cashiers do not initialize a store
      if (effectiveRole === 'cashier') {
        try {
          sessionStorage.removeItem('hyperpos_just_signed_up');
          localStorage.setItem('hyperpos_setup_complete', 'true');
        } catch {}
      } else if (!setupComplete) {
        // 2c. Store owners (boss/admin) or offline fallback -> display SetupWizard
        return (
          <SetupWizard onComplete={() => {
            try {
              sessionStorage.removeItem('hyperpos_just_signed_up');
              localStorage.setItem('hyperpos_setup_complete', 'true');
            } catch {}
            setSetupComplete(true);
            setManualShowSetup(false);
          }} />
        );
      }
    }
  }

// المؤشر يظهر فقط إذا طال التحميل: الشاشات المحمّلة مسبقاً تفتح دون وميض مؤشر
const PageFallback = () => {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), 400);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-[50vh] gap-3 p-4">
      {show && <Loader2 className="w-8 h-8 animate-spin text-primary" />}
    </div>
  );
};

  // لا يتم تطبيق inert إلا إذا كان المستخدم مسجلاً فعلياً والقفل أو تعيين الـ PIN نشط
  const isPublicAuthRoute = ['/login', '/signup', '/reset-password', '/contact-developer', '/contact'].includes(location.pathname);
  const shouldBeInert = Boolean(user && !isPublicAuthRoute && (isLocked || requiresPinSetup));

  return (
    <>
      <AppLockOverlay />
      <MandatoryPinSetupModal />
      <div id="app-main-layout" {...({ inert: shouldBeInert ? '' : undefined } as Record<string, unknown>)} className="contents">
        {isDebugClick && <ClickProbe />}
      <ExitConfirmDialog />
      <Suspense fallback={<PageFallback />}>
        <Routes>
        {/* Public routes */}
        <Route path="/login" element={<FeatureErrorBoundary featureName="تسجيل الدخول"><Login /></FeatureErrorBoundary>} />
        <Route path="/signup" element={<FeatureErrorBoundary featureName="إنشاء حساب"><Signup /></FeatureErrorBoundary>} />
        <Route path="/reset-password" element={<FeatureErrorBoundary featureName="استعادة كلمة المرور"><ResetPassword /></FeatureErrorBoundary>} />
        <Route path="/contact-developer" element={<FeatureErrorBoundary featureName="تواصل مع المطور"><ContactDeveloper /></FeatureErrorBoundary>} />

        {/* Full-screen protected routes (no MainLayout) */}
        <Route path="/" element={<ProtectedRoute><FeatureErrorBoundary featureName="نقطة البيع"><IndexRoute /></FeatureErrorBoundary></ProtectedRoute>} />
        <Route path="/pos" element={<ProtectedRoute><FeatureErrorBoundary featureName="نقطة البيع"><POS /></FeatureErrorBoundary></ProtectedRoute>} />
        <Route path="/help" element={<ProtectedRoute><FeatureErrorBoundary featureName="المساعدة والدعم"><Help /></FeatureErrorBoundary></ProtectedRoute>} />
        <Route path="/boss" element={<ProtectedRoute><RoleGuard allowedRoles={['boss']}><FeatureErrorBoundary featureName="لوحة الإدارة"><BossPanel /></FeatureErrorBoundary></RoleGuard></ProtectedRoute>} />

        {/* Protected routes wrapped by a single persistent MainLayout with NativeTabHost Keep-Alive and user-scoped key */}
        <Route element={<ProtectedRoute><MainLayoutWithKeepAlive /></ProtectedRoute>}>
          {/* Non-keepalive routes handled by Outlet */}
          <Route path="/debts" element={<DebtsRedirect />} />
          <Route path="/partners" element={<RoleGuard allowedRoles={['boss', 'admin']}><PartnersRedirect /></RoleGuard>} />
          <Route path="/dashboard" element={<Navigate to="/reports" replace />} />
          <Route path="/invoice-tracking" element={<FeatureErrorBoundary featureName="تتبع الفواتير"><InvoiceTracking /></FeatureErrorBoundary>} />
          <Route path="/cash-shifts" element={<FeatureErrorBoundary featureName="ورديات الصندوق"><CashShifts /></FeatureErrorBoundary>} />
          <Route path="/library" element={<StoreTypeRoute types={["bookstore"]}><FeatureErrorBoundary featureName="المكتبة"><LibraryMembers /></FeatureErrorBoundary></StoreTypeRoute>} />
          <Route path="/notifications" element={<FeatureErrorBoundary featureName="الإشعارات"><Notifications /></FeatureErrorBoundary>} />
          <Route path="/contact" element={<FeatureErrorBoundary featureName="تواصل مع المطور"><ContactDeveloper /></FeatureErrorBoundary>} />
          <Route path="/renew" element={<FeatureErrorBoundary featureName="تجديد وترقية الاشتراك"><Renew /></FeatureErrorBoundary>} />
          {/* FROZEN: warehouses & stock transfer disabled — redirect home */}
          <Route path="/warehouses" element={<Navigate to="/" replace />} />
          <Route path="/stock-transfer" element={<Navigate to="/" replace />} />

          {/* Keep-alive routes placeholders so react-router matches the URL without 404 */}
          <Route path="/customers" element={null} />
          <Route path="/customers/*" element={null} />
          <Route path="/invoices" element={null} />
          <Route path="/services" element={null} />
          <Route path="/services/*" element={null} />
          <Route path="/expenses" element={null} />
          <Route path="/appearance" element={null} />
          <Route path="/products" element={null} />
          <Route path="/products/*" element={null} />
          <Route path="/purchases" element={null} />
          <Route path="/reports" element={null} />
          <Route path="/settings" element={null} />
          <Route path="/settings/*" element={null} />
        </Route>

        <Route path="*" element={<FeatureErrorBoundary featureName="الصفحة غير موجودة"><NotFound /></FeatureErrorBoundary>} />
      </Routes>
      </Suspense>
      </div>
    </>
  );
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <HashRouter>
        <LanguageProvider>
          <ThemeProvider>
            <AuthProvider>
              <AppLockProvider>
                <CloudSyncProvider>
                <LicenseProvider>
                  <UserRoleProvider>
                    <WarehouseProvider>
                      <NotificationsProvider>
                        <SmartToast />
                        {/* LicenseWarningBadge is OUTSIDE LicenseGuard so it always renders */}
                        <LicenseWarningBadge />
                        <OfflineProtectionBanner />
                        <DemoModeBanner />
                        <RemoteUpdatesGate />
                        <LicenseGuard>
                          <AppContent />
                          {/* شرح إذن الإشعارات بدلاً من طلبه تلقائياً عند الإقلاع */}
                          <NotificationPermissionPrompt />
                        </LicenseGuard>
                      </NotificationsProvider>
                    </WarehouseProvider>
                  </UserRoleProvider>
                </LicenseProvider>
              </CloudSyncProvider>
              </AppLockProvider>
            </AuthProvider>
          </ThemeProvider>
        </LanguageProvider>
      </HashRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
