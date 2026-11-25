import { createContext, useContext } from 'react';
import { getCanonicalDeviceId } from '@/lib/device-fingerprint';
import { supabase } from '@/integrations/supabase/client';

// رسالة مفهومة بدل "Failed to send a request to the Edge Function"
export const friendlyFunctionError = (err: unknown, fallback: string): string => {
  const msg = typeof err === 'object' && err !== null && 'message' in err ? String((err as { message?: unknown }).message || '') : '';
  if (/Failed to send a request|Failed to fetch|NetworkError|network/i.test(msg)) {
    return 'تعذّر الاتصال بالخادم، تحقق من الإنترنت ثم حاول مجدداً';
  }
  return msg || fallback;
};
/** Shape of the check-license edge function response (and of the direct app_licenses fallback built from it). */
export interface LicenseCheckResponse {
  valid: boolean;
  hasLicense: boolean;
  needsActivation: boolean;
  userNotFound?: boolean;
  isRevoked?: boolean | null;
  deviceMismatch?: boolean;
  isTrial?: boolean;
  isExpired?: boolean;
  ownerNeedsActivation?: boolean;
  expiresAt?: string | null;
  remainingDays?: number | null;
  role?: string | null;
  maxCashiers?: number | null;
  maxProducts?: number | null;
  max_products?: number | null;
  licenseTier?: string | null;
  planName?: string | null;
  plan_name?: string | null;
  planAudience?: string | null;
  plan_audience?: string | null;
  totalDays?: number | null;
  total_days?: number | null;
  expiringWarning?: boolean;
  ownerHasPhone?: unknown;
  hasPaidWriteAccess?: unknown;
}
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
export interface LicenseContextType extends LicenseState {
  checkLicense: () => Promise<void>;
  activateCode: (code: string) => Promise<{ success: boolean; error?: string; expiresAt?: string }>;
  startTrial: () => Promise<{ success: boolean; error?: string; message?: string }>;
}
export const LicenseContext = createContext<LicenseContextType | undefined>(undefined);
export const LICENSE_CACHE_KEY = 'posflow_license_cache_v1';
export function saveLicenseCache(state: Omit<LicenseState, 'isLoading' | 'error'>, userId?: string) {
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
export async function resolveLicenseDeviceId(userId: string): Promise<string> {
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
export function loadLicenseCache(): (Omit<LicenseState, 'isLoading' | 'error'>) | null {
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
export function loadLicenseCacheFallback(): (Omit<LicenseState, 'isLoading' | 'error'>) | null {
  try {
    const raw = localStorage.getItem(LICENSE_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
export function useLicense() {
  const context = useContext(LicenseContext);
  if (context === undefined) {
    throw new Error('useLicense must be used within a LicenseProvider');
  }
  return context;
}
