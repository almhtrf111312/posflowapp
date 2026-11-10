import { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
import { getDeviceKey } from '@/lib/secure-storage';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './use-auth';
import { recordServerContact, getOfflineStatus, isDataEncrypted, decryptLocalData, checkAndEnforceProtection } from '@/lib/offline-protection';
import { fetchOfflineLease, getOfflineLeaseStatus, clearOfflineLease } from '@/lib/offline-lease';
import { toast } from '@/lib/sonner-bridge';

export interface LicenseState {
  isLoading: boolean;
  isValid: boolean;
  hasLicense: boolean;
  isTrial: boolean;
  isExpired: boolean;
  isRevoked: boolean;
  needsActivation: boolean;
  ownerNeedsActivation: boolean;
  expiresAt: string | null;
  remainingDays: number | null;
  error: string | null;
  role: string | null;
  maxCashiers: number | null;
  maxProducts: number | null;
  licenseTier: string | null;
  planName?: string | null;
  planAudience?: string | null;
  totalDays?: number | null;
  expiringWarning: boolean;
  offlineDays: number;
  offlineWarning: boolean;
  dataEncrypted: boolean;
  /** تذكرة الأوفلاين محظورة (انتهاء/عبث بالساعة/بلوغ حد الفواتير) */
  offlineLeaseBlocked: boolean;
  offlineLeaseReason: string | null;
}

interface LicenseContextType extends LicenseState {
  checkLicense: () => Promise<void>;
  activateCode: (code: string) => Promise<{ success: boolean; error?: string; expiresAt?: string }>;
  startTrial: () => Promise<{ success: boolean; error?: string }>;
}

const LicenseContext = createContext<LicenseContextType | undefined>(undefined);

const LICENSE_CACHE_KEY = 'hyperpos_license_cache_v1';

function saveLicenseCache(state: Omit<LicenseState, 'isLoading' | 'error'>) {
  try {
    localStorage.setItem(LICENSE_CACHE_KEY, JSON.stringify({ ...state, _ts: Date.now() }));
  } catch { /* ignore */ }
}

function loadLicenseCache(): (Omit<LicenseState, 'isLoading' | 'error'>) | null {
  try {
    const raw = localStorage.getItem(LICENSE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Cache valid for 30 days max (aligned with offline-protection threshold)
    if (parsed._ts && Date.now() - parsed._ts > 30 * 24 * 60 * 60 * 1000) return null;
    return parsed;
  } catch { return null; }
}

/** Fallback cache loader that ignores expiry to allow instantaneous optimistic UI startup */
function loadLicenseCacheFallback(): (Omit<LicenseState, 'isLoading' | 'error'>) | null {
  try {
    const raw = localStorage.getItem(LICENSE_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

export function LicenseProvider({ children }: { children: ReactNode }) {
  const { user, isLoading: authLoading } = useAuth();
  const initialCache = loadLicenseCache();
  const fallbackCache = initialCache ? null : loadLicenseCacheFallback();
  const effectiveCache = initialCache || fallbackCache;
  
  const [state, setState] = useState<LicenseState>({
    // ✅ If cache exists, start with isLoading=false for instant UI (< 0.5s)
    isLoading: !initialCache && !fallbackCache,
    isValid: effectiveCache?.isValid ?? true,
    hasLicense: effectiveCache?.hasLicense ?? true,
    isTrial: effectiveCache?.isTrial ?? false,
    isExpired: effectiveCache?.isExpired ?? false,
    isRevoked: effectiveCache?.isRevoked ?? false,
    needsActivation: effectiveCache?.needsActivation ?? false,
    ownerNeedsActivation: effectiveCache?.ownerNeedsActivation ?? false,
    expiresAt: effectiveCache?.expiresAt ?? null,
    remainingDays: effectiveCache?.remainingDays ?? null,
    error: null,
    role: effectiveCache?.role ?? null,
    maxCashiers: effectiveCache?.maxCashiers ?? null,
    maxProducts: effectiveCache?.maxProducts ?? null,
    licenseTier: effectiveCache?.licenseTier ?? null,
    planName: effectiveCache?.planName ?? null,
    planAudience: effectiveCache?.planAudience ?? null,
    totalDays: effectiveCache?.totalDays ?? null,
    expiringWarning: effectiveCache?.expiringWarning ?? false,
    offlineDays: getOfflineStatus().daysOffline,
    offlineWarning: getOfflineStatus().shouldWarn,
    dataEncrypted: isDataEncrypted(),
    offlineLeaseBlocked: !getOfflineLeaseStatus().allowed,
    offlineLeaseReason: getOfflineLeaseStatus().reason,
  });

  // Safety failsafe: ensure isLoading never blocks the screen longer than 1500ms
  useEffect(() => {
    const timer = setTimeout(() => {
      setState(prev => {
        if (!prev.isLoading) return prev;
        console.log('[License] 1.5s safety timeout reached: releasing loading state for instant offline UI');
        const fb = loadLicenseCacheFallback();
        return {
          ...prev,
          isLoading: false,
          isValid: fb?.isValid ?? true,
          hasLicense: fb?.hasLicense ?? true,
          needsActivation: fb?.needsActivation ?? false,
        };
      });
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  const prevUserIdRef = useRef<string | null>(null);

  const checkLicense = useCallback(async () => {
    if (!user) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        isValid: false,
        hasLicense: false,
        needsActivation: false,
      }));
      return;
    }

    // Clear cache when user changes to force fresh server check
    if (prevUserIdRef.current && prevUserIdRef.current !== user.id) {
      localStorage.removeItem(LICENSE_CACHE_KEY);
      clearOfflineLease();
    }
    prevUserIdRef.current = user.id;

    try {
      // Only show loading if no cache at all
      const cached = loadLicenseCache() || loadLicenseCacheFallback();
      if (!cached) {
        setState(prev => ({ ...prev, isLoading: true, error: null }));
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setState(prev => ({
          ...prev,
          isLoading: false,
          isValid: false,
          needsActivation: false,
        }));
        return;
      }

      // 1. استدعاء دالة check-license مع مهلة 4 ثوانٍ
      let data: any = null;
      try {
        const invokePromise = supabase.functions.invoke('check-license', {
          body: { device_id: getDeviceKey() },
          headers: { Authorization: `Bearer ${session.access_token}` },
        });

        const timeoutPromise = new Promise<{ data: null; error: Error }>((_, reject) =>
          setTimeout(() => reject(new Error('license check network timeout')), 4000)
        );

        const response = await Promise.race([invokePromise, timeoutPromise]);
        if (!response.error && response.data) {
          data = response.data;
        }
      } catch (e) {
        console.warn('[License] Edge function timed out or failed, attempting direct DB fallback...');
      }

      // 2. استعلام احتياطي مباشر وفوري من جدول app_licenses (محمي بـ RLS وسريع جداً 30ms)
      if (!data && user?.id) {
        try {
          const { data: dbLicense } = await supabase
            .from('app_licenses')
            .select('*')
            .eq('user_id', user.id)
            .maybeSingle();

          if (dbLicense) {
            const now = new Date();
            const exp = new Date(dbLicense.expires_at);
            const remDays = Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
            data = {
              valid: exp > now && !dbLicense.is_revoked,
              hasLicense: true,
              isTrial: dbLicense.is_trial === true,
              expiresAt: dbLicense.expires_at,
              remainingDays: remDays,
              needsActivation: false,
              role: 'admin',
              maxCashiers: dbLicense.max_cashiers || 1,
              maxProducts: dbLicense.max_products !== null && dbLicense.max_products !== undefined ? dbLicense.max_products : 100,
              licenseTier: dbLicense.license_tier || 'standard',
              planName: dbLicense.plan_name || (dbLicense.is_trial ? 'فترة تجريبية' : 'اشتراك مفعّل'),
              planAudience: dbLicense.plan_audience || dbLicense.license_tier || 'standard',
              totalDays: dbLicense.total_days || 30,
              isRevoked: dbLicense.is_revoked,
              expiringWarning: remDays <= 7,
            };
          }
        } catch (dbErr) {
          console.warn('[License] Direct DB fallback error:', dbErr);
        }
      }

      if (!data) {
        throw new Error('Could not fetch license from edge function or database');
      }

      if (data.userNotFound) {
        console.log('User not found in database, signing out...');
        localStorage.removeItem(LICENSE_CACHE_KEY);
        await supabase.auth.signOut();
        setState(prev => ({
          ...prev, isLoading: false, isValid: false, hasLicense: false, needsActivation: false,
        }));
        return;
      }

      if (data.isRevoked) {
        console.log('[License] License is revoked, signing out immediately...');
        localStorage.removeItem(LICENSE_CACHE_KEY);
        toast.error('تم تعطيل هذا الحساب أو إلغاء ترخيصه، يرجى التواصل مع الإدارة');
        await supabase.auth.signOut();
        setState(prev => ({
          ...prev, isLoading: false, isValid: false, hasLicense: false, isRevoked: true, needsActivation: false,
        }));
        return;
      }

      const newState: LicenseState = {
        isLoading: false,
        isValid: data.valid,
        hasLicense: data.hasLicense,
        isTrial: data.isTrial === true,
        isExpired: data.isExpired || false,
        isRevoked: data.isRevoked || false,
        needsActivation: data.needsActivation,
        ownerNeedsActivation: data.ownerNeedsActivation || false,
        expiresAt: data.expiresAt || null,
        remainingDays: data.remainingDays || null,
        error: null,
        role: data.role || null,
        maxCashiers: data.maxCashiers || null,
        maxProducts: data.maxProducts !== null && data.maxProducts !== undefined ? data.maxProducts : (data.max_products || null),
        licenseTier: data.licenseTier || null,
        planName: data.planName || data.plan_name || null,
        planAudience: data.planAudience || data.plan_audience || null,
        totalDays: data.totalDays || data.total_days || null,
        expiringWarning: data.expiringWarning || false,
        offlineDays: 0,
        offlineWarning: false,
        dataEncrypted: false,
        offlineLeaseBlocked: false,
        offlineLeaseReason: null,
      };

      // Record successful server contact
      recordServerContact();

      // 🎫 إصدار/تجديد تذكرة الأوفلاين الموقّعة من الخادم (تتقدم الساعة الموثوقة ويُصفَّر عداد الفواتير)
      await fetchOfflineLease();

      // If data was encrypted, decrypt it now
      if (isDataEncrypted()) {
        console.log('[License] Data was encrypted, decrypting...');
        await decryptLocalData();
      }

      // Update offline status after successful contact
      const offlineStatus = getOfflineStatus();

      const leaseStatus = getOfflineLeaseStatus();
      setState({
        ...newState,
        offlineDays: offlineStatus.daysOffline,
        offlineWarning: offlineStatus.shouldWarn,
        dataEncrypted: isDataEncrypted(),
        offlineLeaseBlocked: !leaseStatus.allowed,
        offlineLeaseReason: leaseStatus.reason,
      });
      // Save successful result to cache
      const { isLoading: _, error: _e, ...cacheData } = newState;
      saveLicenseCache(cacheData);
    } catch (error) {
      console.warn('[License] License check error or timeout (offline/VPN mode):', error);
      // Check if offline protection should encrypt data
      await checkAndEnforceProtection();
      const offlineStatus = getOfflineStatus();
      const fallback = loadLicenseCacheFallback();

      const leaseStatus = getOfflineLeaseStatus();
      setState(prev => ({
        ...prev,
        isLoading: false,
        isValid: fallback?.isValid ?? true,
        hasLicense: fallback?.hasLicense ?? true,
        needsActivation: fallback?.needsActivation ?? false,
        error: 'وضع غير متصل بالإنترنت',
        offlineDays: offlineStatus.daysOffline,
        offlineWarning: offlineStatus.shouldWarn,
        dataEncrypted: isDataEncrypted(),
        offlineLeaseBlocked: !leaseStatus.allowed,
        offlineLeaseReason: leaseStatus.reason,
      }));
    }
  }, [user]);

  const activateCode = async (code: string): Promise<{ success: boolean; error?: string; expiresAt?: string }> => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return { success: false, error: 'يجب تسجيل الدخول أولاً' };

      const response = await supabase.functions.invoke('validate-activation-code', {
        body: { code, device_id: getDeviceKey() },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (response.error) return { success: false, error: response.error.message };
      const data = response.data;
      if (!data.success) return { success: false, error: data.error };

      await checkLicense();
      return { success: true, expiresAt: data.expiresAt };
    } catch (error) {
      console.error('Error activating code:', error);
      return { success: false, error: 'حدث خطأ أثناء تفعيل الكود' };
    }
  };

  const startTrial = async (): Promise<{ success: boolean; error?: string }> => {
    if (!user) return { success: false, error: 'يجب تسجيل الدخول أولاً' };

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return { success: false, error: 'يجب تسجيل الدخول أولاً' };

      const response = await supabase.functions.invoke('start-trial', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (response.error) return { success: false, error: response.error.message || 'حدث خطأ أثناء بدء الفترة التجريبية' };
      const data = response.data;
      if (!data.success) return { success: false, error: data.error || 'حدث خطأ أثناء بدء الفترة التجريبية' };

      await checkLicense();
      return { success: true };
    } catch (error) {
      console.error('Error starting trial:', error);
      return { success: false, error: 'حدث خطأ أثناء بدء الفترة التجريبية' };
    }
  };

  // undefined = never checked (so a signed-out cold start still runs the check
  // and releases the loading screen after app data is cleared)
  const lastCheckedUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (authLoading) return;
    const userId = user?.id ?? null;
    if (lastCheckedUserIdRef.current === userId) return;
    lastCheckedUserIdRef.current = userId;
    checkLicense();
  }, [user?.id, authLoading, checkLicense]);

  return (
    <LicenseContext.Provider value={{ ...state, checkLicense, activateCode, startTrial }}>
      {children}
    </LicenseContext.Provider>
  );
}

export function useLicense() {
  const context = useContext(LicenseContext);
  if (context === undefined) {
    throw new Error('useLicense must be used within a LicenseProvider');
  }
  return context;
}
