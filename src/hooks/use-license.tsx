import { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
import { getDeviceKey } from '@/lib/secure-storage';
import { getCanonicalDeviceId } from '@/lib/device-fingerprint';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './use-auth';
import { recordServerContact, getOfflineStatus, isDataEncrypted, decryptLocalData, checkAndEnforceProtection } from '@/lib/offline-protection';
import { fetchOfflineLease, getOfflineLeaseStatus, clearOfflineLease } from '@/lib/offline-lease';
import { setLocalOnlyMode, setCloudWriteBlocked } from '@/lib/subscription-lock';
import { toast } from '@/lib/sonner-bridge';


// رسالة مفهومة بدل "Failed to send a request to the Edge Function"
const friendlyFunctionError = (err: any, fallback: string): string => {
  const msg = String(err?.message || '');
  if (/Failed to send a request|Failed to fetch|NetworkError|network/i.test(msg)) {
    return 'تعذّر الاتصال بالخادم، تحقق من الإنترنت ثم حاول مجدداً';
  }
  return msg || fallback;
};

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
  /** الترخيص مربوط بجهاز آخر (ليس إلغاءً للترخيص) */
  deviceMismatch?: boolean;
  /** هل يملك صاحب المتجر رقم هاتف مسجلاً (مصدر الحقيقة من الخادم للكاشير والمالك) */
  ownerHasPhone?: boolean;
  /** هل يسمح الخادم بالكتابة السحابية للحساب الحالي */
  hasPaidWriteAccess?: boolean;
}

interface LicenseContextType extends LicenseState {
  checkLicense: () => Promise<void>;
  activateCode: (code: string) => Promise<{ success: boolean; error?: string; expiresAt?: string }>;
  startTrial: () => Promise<{ success: boolean; error?: string; message?: string }>;
}

const LicenseContext = createContext<LicenseContextType | undefined>(undefined);

const LICENSE_CACHE_KEY = 'posflow_license_cache_v1';

function saveLicenseCache(state: Omit<LicenseState, 'isLoading' | 'error'>, userId?: string) {
  try {
    localStorage.setItem(LICENSE_CACHE_KEY, JSON.stringify({ ...state, _ts: Date.now(), _uid: userId || null }));
  } catch { /* ignore */ }
}

/**
 * هل تكفي نسخة الترخيص المحفوظة على الجهاز لفتح التطبيق؟
 * وجود الملف وحده لا يكفي: يجب أن تكون صالحة وغير ملغاة ولم ينتهِ تاريخها، وتخص المستخدم الحالي.
 */
export function cachedLicenseGrantsAccess(
  cache: Partial<LicenseState> & { _uid?: string | null } | null | undefined,
  userId?: string | null
): boolean {
  if (!cache) return false;
  if (userId && cache._uid && cache._uid !== userId) return false;
  if (cache.role === 'boss') return true;
  if (!cache.isValid || !cache.hasLicense || cache.isRevoked) return false;
  if (cache.expiresAt && new Date(cache.expiresAt).getTime() <= Date.now()) return false;
  return true;
}

/** يقرأ معرّف الجهاز المربوط بالترخيص (للمالك أو لمالك الكاشير عبر RLS) ويعيد المعرّف المحلي المطابق له */
async function resolveLicenseDeviceId(userId: string): Promise<string> {
  let registered: string | null = null;
  try {
    const query = supabase.from('app_licenses').select('user_id, device_id').limit(5);
    const timeout = new Promise<{ data: null }>(resolve => setTimeout(() => resolve({ data: null }), 1500));
    const { data } = await Promise.race([query, timeout]) as { data: Array<{ user_id: string; device_id: string | null }> | null };
    if (data && data.length > 0) {
      const own = data.find(r => r.user_id === userId);
      registered = (own || (data.length === 1 ? data[0] : null))?.device_id ?? null;
    }
  } catch { /* offline */ }
  // نقل الربط القديم إلى المعرّف الثابت (لصاحب الترخيص فقط؛ الكاشير يعمل على ترخيص المالك)
  return getCanonicalDeviceId(registered, async (stableId) => {
    const { data, error } = await supabase
      .from('app_licenses')
      .update({ device_id: stableId })
      .eq('user_id', userId)
      .eq('device_id', registered as string)
      .select('id');
    // يُعتبر النقل ناجحاً فقط إذا تحدّث صف فعلاً (الكاشير لا يملك صف الترخيص فيبقى الربط القديم)
    return !error && Array.isArray(data) && data.length > 0;
  });
}

export function readLicenseCacheRaw(): (Partial<LicenseState> & { _uid?: string | null }) | null {
  try {
    const raw = localStorage.getItem(LICENSE_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
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
  const { user, profile, isLoading: authLoading } = useAuth();
  // التجريبي الذي سجّل رقم هاتف يُسمح له بالمزامنة (السيرفر هو الحَكَم عبر has_paid_write_access)
  const hasPhone = !!profile?.phone && profile.phone.trim().length > 0;
  const initialCache = loadLicenseCache();
  const fallbackCache = initialCache ? null : loadLicenseCacheFallback();
  const effectiveCache = initialCache || fallbackCache;
  
  const [state, setState] = useState<LicenseState>({
    // ✅ If cache exists, start with isLoading=false for instant UI (< 0.5s)
    // بدون نسخة محفوظة صالحة لا نفترض أن الترخيص ساري: ننتظر نتيجة الخادم
    isLoading: !initialCache && !fallbackCache,
    isValid: cachedLicenseGrantsAccess(effectiveCache as any),
    hasLicense: effectiveCache?.hasLicense ?? false,
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
    ownerHasPhone: effectiveCache?.ownerHasPhone,
    hasPaidWriteAccess: effectiveCache?.hasPaidWriteAccess,
  });

  // Safety failsafe: لا يبقى التحميل أكثر من 8 ثوانٍ، ولا يُمنح الدخول إلا من نسخة محفوظة صالحة فعلاً
  useEffect(() => {
    const timer = setTimeout(() => {
      setState(prev => {
        if (!prev.isLoading) return prev;
        console.log('[License] 8s safety timeout reached: releasing loading state');
        const fb = loadLicenseCacheFallback();
        return {
          ...prev,
          isLoading: false,
          isValid: cachedLicenseGrantsAccess(fb as any),
          hasLicense: fb?.hasLicense ?? false,
          needsActivation: fb?.needsActivation ?? false,
        };
      });
    }, 8000);
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

      // 1. استدعاء دالة check-license مع مهلة 4 ثوانٍ (بمعرّف الجهاز الموحّد المطابق لما رُبط به الترخيص)
      let data: any = null;
      try {
        const deviceIdForLicense = await resolveLicenseDeviceId(user.id);
        const invokePromise = supabase.functions.invoke('check-license', {
          body: { device_id: deviceIdForLicense },
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
        deviceMismatch: data.deviceMismatch === true,
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
        ownerHasPhone: typeof data.ownerHasPhone === 'boolean' ? data.ownerHasPhone : undefined,
        hasPaidWriteAccess: typeof data.hasPaidWriteAccess === 'boolean' ? data.hasPaidWriteAccess : undefined,
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
      saveLicenseCache(cacheData, user.id);
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
        // دون اتصال: يُسمح بالعمل فقط إذا كانت النسخة المحفوظة صالحة وغير منتهية وتخص هذا المستخدم
        isValid: cachedLicenseGrantsAccess(fallback as any, user?.id),
        hasLicense: fallback?.hasLicense ?? false,
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
        body: { code, device_id: user ? await resolveLicenseDeviceId(user.id) : getDeviceKey() },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (response.error) return { success: false, error: friendlyFunctionError(response.error, 'حدث خطأ أثناء تفعيل الكود') };
      const data = response.data;
      if (!data.success) return { success: false, error: data.error };

      await checkLicense();
      return { success: true, expiresAt: data.expiresAt };
    } catch (error) {
      console.error('Error activating code:', error);
      return { success: false, error: 'حدث خطأ أثناء تفعيل الكود' };
    }
  };

  const startTrial = async (): Promise<{ success: boolean; error?: string; message?: string }> => {
    if (!user) return { success: false, error: 'يجب تسجيل الدخول أولاً' };

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return { success: false, error: 'يجب تسجيل الدخول أولاً' };

      const response = await supabase.functions.invoke('start-trial', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (response.error) return { success: false, error: friendlyFunctionError(response.error, 'حدث خطأ أثناء بدء الفترة التجريبية') };
      const data = response.data;
      if (!data.success) return { success: false, error: data.error || 'حدث خطأ أثناء بدء الفترة التجريبية' };

      await checkLicense();
      return { success: true, message: typeof data.message === 'string' ? data.message : undefined };
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

  // إعادة فحص الترخيص فور وصول إشعار تفعيل/تجديد من لوحة الإدارة (دون إعادة تسجيل الدخول)
  useEffect(() => {
    const handleLicenseChanged = () => { checkLicense(); };
    window.addEventListener('posflow:license-changed', handleLicenseChanged);
    return () => window.removeEventListener('posflow:license-changed', handleLicenseChanged);
  }, [checkLicense]);

  // اعتماد رقم هاتف المالك من الخادم (لحل حجب الكاشير الذي لا يملك هاتفاً شخصياً)
  const effectiveHasPhone = state.ownerHasPhone !== undefined ? state.ownerHasPhone : hasPhone;

  // وضع التجربة المحلي: التجربة (غير المشتركة) لا ترفع بياناتها إلى السحابة
  useEffect(() => {
    if (state.isLoading) return;
    const notExpired = !state.expiresAt || new Date(state.expiresAt).getTime() > Date.now();
    const trialCanSync = (state.hasPaidWriteAccess === true || effectiveHasPhone) && state.isValid && notExpired;
    setLocalOnlyMode(!!state.isTrial && !!state.hasLicense && state.role !== 'boss' && !trialCanSync);
  }, [state.isLoading, state.isTrial, state.hasLicense, state.role, state.isValid, state.expiresAt, effectiveHasPhone, state.hasPaidWriteAccess]);

  // حاجز الكتابة السحابية: مسموح فقط لمالك/كاشير برخصة مدفوعة فعّالة، أو للـ Boss
  useEffect(() => {
    if (state.isLoading) return;
    const notExpired = !state.expiresAt || new Date(state.expiresAt).getTime() > Date.now();
    const paidActive =
      state.role === 'boss' ||
      (state.hasPaidWriteAccess === true && state.isValid && notExpired) ||
      (state.hasLicense && (!state.isTrial || effectiveHasPhone) && state.isValid && notExpired);
    setCloudWriteBlocked(!paidActive);
  }, [state.isLoading, state.hasLicense, state.isTrial, state.isValid, state.expiresAt, state.role, effectiveHasPhone, state.hasPaidWriteAccess]);

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
