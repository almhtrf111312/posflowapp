import React, { memo, ReactNode, useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react';
import { useLocation, Outlet } from 'react-router-dom';
import { RoleGuard } from '@/components/auth/RoleGuard';
import { FeatureErrorBoundary } from '@/components/debug/FeatureErrorBoundary';
import { PageActivityProvider } from '@/contexts/PageActivityContext';
import { useAuth } from '@/hooks/auth-context';
import { Loader2 } from 'lucide-react';
import { performanceMetrics } from '@/lib/performance-metrics';
import { getBaseTabPath } from '@/components/layout/tab-paths';

/**
 * KeepAliveTab Component
 * حاوية تبويب تحتفظ بالشجرة البرمجية في الذاكرة RAM وتتحكم بالظهور باستخدام GPU Acceleration
 * contentVisibility: hidden و contain: strict لمنع هدم الـ DOM وإعادة تصييره
 */
export interface KeepAliveTabProps {
  activePath: string;
  tabPath: string;
  children: ReactNode;
}

export const KeepAliveTab = memo(({ activePath, tabPath, children }: KeepAliveTabProps) => {
  const isMatch = activePath === tabPath;

  useEffect(() => {
    if (isMatch) {
      performanceMetrics.markUsefulRender(tabPath);
    }
  }, [isMatch, tabPath]);

  return (
    <PageActivityProvider isActive={isMatch} activePath={activePath}>
      <div
        role="tabpanel"
        aria-hidden={!isMatch}
        className={`w-full h-full flex-1 flex flex-col native-instant-tab ${
          isMatch 
            ? 'relative opacity-100 pointer-events-auto z-10' 
            : 'hidden opacity-0 pointer-events-none z-0'
        }`}
        style={{
          // تحسين أداء المعالجة الرسومية GPU عبر Hardware Acceleration
          contain: isMatch ? 'none' : 'strict',
          contentVisibility: isMatch ? 'visible' : 'hidden',
        }}
      >
        {children}
      </div>
    </PageActivityProvider>
  );
});

KeepAliveTab.displayName = 'KeepAliveTab';

// Lazy load primary tab components
const Products = lazy(() => import('@/pages/Products'));
const Customers = lazy(() => import('@/pages/Customers'));
const Services = lazy(() => import('@/pages/Services'));
const Invoices = lazy(() => import('@/pages/Invoices'));
const Expenses = lazy(() => import('@/pages/Expenses'));
const Settings = lazy(() => import('@/pages/Settings'));
const Reports = lazy(() => import('@/pages/Reports'));
const Purchases = lazy(() => import('@/pages/Purchases'));
const Appearance = lazy(() => import('@/pages/Appearance'));

// المؤشر يظهر فقط إذا طال التحميل: الشاشات المحمّلة مسبقاً تفتح دون وميض مؤشر
const TabFallback = () => {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), 400);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-[50vh] gap-3 p-4">
      {show && <Loader2 className="w-8 h-8 animate-spin text-primary opacity-80" />}
    </div>
  );
};

/**
 * الحد الأقصى لعدد التبويبات المحتفظ بها في الذاكرة الحية RAM في نفس الوقت
 * 8 تبويبات تضمن تجربة تنقل فائقة السلاسة ولحظية 100% مع الاستفادة من contentVisibility: hidden
 */
const MAX_MOUNTED_TABS = 5;

/**
 * NativeTabHost
 * المضيف الذكي للتبويبات المستمرة:
 * يُبقي الشاشات الرئيسية محملة في الخلفية دون إعادة جلب البيانات أو تفكيك الـ DOM عند التنقل
 * مع تطبيق سياسة LRU Eviction منضبطة لمنع تراكم الذاكرة.
 */
export const NativeTabHost = memo(() => {
  const location = useLocation();
  const { user } = useAuth();
  const activeTab = getBaseTabPath(location.pathname);

  // طابور LRU للتبويبات النشطة (الأحدث في نهاية المصفوفة)
  const [tabLRU, setTabLRU] = useState<string[]>(() => (activeTab ? [activeTab] : []));

  useEffect(() => {
    if (!activeTab) return;

    performanceMetrics.markRouteIntent(activeTab);

    setTabLRU(prev => {
      const filtered = prev.filter(t => t !== activeTab);
      filtered.push(activeTab);
      if (filtered.length > MAX_MOUNTED_TABS) {
        return filtered.slice(-MAX_MOUNTED_TABS);
      }
      return filtered;
    });
  }, [activeTab]);

  // إعادة ضبط التبويبات المركبة فور تغيير المستخدم لعزل الحسابات (يقرأ التبويب النشط الحالي دون أن يُعاد التشغيل عند كل تبديل تبويب)
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  useEffect(() => {
    if (activeTabRef.current) {
      setTabLRU([activeTabRef.current]);
    } else {
      setTabLRU([]);
    }
  }, [user?.id]);

  // التبويب النشط يُركَّب في نفس الإطار (كان يُضاف بعد أول رسم فتظهر شاشة بيضاء فارغة للحظة)
  const mountedTabs = useMemo(() => {
    const set = new Set(tabLRU);
    if (activeTab) set.add(activeTab);
    return set;
  }, [tabLRU, activeTab]);

  return (
    <div className="w-full flex-1 flex flex-col relative min-h-[calc(100vh-4rem)]">
      {mountedTabs.has('/products') && (
        <KeepAliveTab activePath={activeTab ?? ''} tabPath="/products">
          <RoleGuard allowedRoles={['boss', 'admin']} pageKey="products" fallback={activeTab === '/products' ? undefined : null}>
            <FeatureErrorBoundary featureName="إدارة المنتجات">
              <Suspense fallback={<TabFallback />}>
                <Products />
              </Suspense>
            </FeatureErrorBoundary>
          </RoleGuard>
        </KeepAliveTab>
      )}

      {mountedTabs.has('/invoices') && (
        <KeepAliveTab activePath={activeTab ?? ''} tabPath="/invoices">
          <FeatureErrorBoundary featureName="سجل الفواتير">
            <Suspense fallback={<TabFallback />}>
              <Invoices />
            </Suspense>
          </FeatureErrorBoundary>
        </KeepAliveTab>
      )}

      {mountedTabs.has('/customers') && (
        <KeepAliveTab activePath={activeTab ?? ''} tabPath="/customers">
          <FeatureErrorBoundary featureName="العملاء والديون">
            <Suspense fallback={<TabFallback />}>
              <Customers />
            </Suspense>
          </FeatureErrorBoundary>
        </KeepAliveTab>
      )}

      {mountedTabs.has('/services') && (
        <KeepAliveTab activePath={activeTab ?? ''} tabPath="/services">
          <FeatureErrorBoundary featureName="الخدمات">
            <Suspense fallback={<TabFallback />}>
              <Services />
            </Suspense>
          </FeatureErrorBoundary>
        </KeepAliveTab>
      )}

      {mountedTabs.has('/expenses') && (
        <KeepAliveTab activePath={activeTab ?? ''} tabPath="/expenses">
          <FeatureErrorBoundary featureName="المصاريف">
            <Suspense fallback={<TabFallback />}>
              <Expenses />
            </Suspense>
          </FeatureErrorBoundary>
        </KeepAliveTab>
      )}

      {mountedTabs.has('/purchases') && (
        <KeepAliveTab activePath={activeTab ?? ''} tabPath="/purchases">
          <RoleGuard allowedRoles={['boss', 'admin']} pageKey="purchases" fallback={activeTab === '/purchases' ? undefined : null}>
            <FeatureErrorBoundary featureName="المشتريات">
              <Suspense fallback={<TabFallback />}>
                <Purchases />
              </Suspense>
            </FeatureErrorBoundary>
          </RoleGuard>
        </KeepAliveTab>
      )}

      {mountedTabs.has('/reports') && (
        <KeepAliveTab activePath={activeTab ?? ''} tabPath="/reports">
          <RoleGuard allowedRoles={['boss', 'admin']} pageKey="reports" fallback={activeTab === '/reports' ? undefined : null}>
            <FeatureErrorBoundary featureName="التقارير">
              <Suspense fallback={<TabFallback />}>
                <Reports />
              </Suspense>
            </FeatureErrorBoundary>
          </RoleGuard>
        </KeepAliveTab>
      )}

      {mountedTabs.has('/settings') && (
        <KeepAliveTab activePath={activeTab ?? ''} tabPath="/settings">
          <FeatureErrorBoundary featureName="الإعدادات">
            <Suspense fallback={<TabFallback />}>
              <Settings />
            </Suspense>
          </FeatureErrorBoundary>
        </KeepAliveTab>
      )}

      {mountedTabs.has('/appearance') && (
        <KeepAliveTab activePath={activeTab ?? ''} tabPath="/appearance">
          <FeatureErrorBoundary featureName="المظهر">
            <Suspense fallback={<TabFallback />}>
              <Appearance />
            </Suspense>
          </FeatureErrorBoundary>
        </KeepAliveTab>
      )}

      {/* fallback للأي مسارات فرعية أخرى داخل الإطار العام */}
      {!activeTab && <Outlet />}
    </div>
  );
});

NativeTabHost.displayName = 'NativeTabHost';
