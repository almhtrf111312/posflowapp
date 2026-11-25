import { createContext, useContext } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { User, Session } from '@supabase/supabase-js';
import { isGuestDemoMode } from '@/lib/demo-data';

// Helper function to check if account is active and license is not revoked
export async function checkUserAccountStatus(userId: string, timeoutMs: number = 1500): Promise<{ blocked: boolean; reason?: string }> {
  try {
    const statusPromise = (async (): Promise<{ blocked: boolean; reason?: string }> => {
      // 1. Check user_roles for is_active and role
      const { data: roleData, error: roleError } = await supabase
        .from('user_roles')
        .select('role, owner_id, is_active')
        .eq('user_id', userId)
        .maybeSingle();

      if (roleError) {
        console.warn('[AccountCheck] Error querying user_roles:', roleError);
      }

      if (roleData) {
        // Boss accounts are superadmins, never blocked
        if (roleData.role === 'boss') {
          return { blocked: false };
        }

        // Check if user account is deactivated
        if (roleData.is_active === false) {
          return { blocked: true, reason: 'inactive' };
        }

        // If cashier, also check if owner is deactivated
        if (roleData.role === 'cashier' && roleData.owner_id) {
          const { data: ownerRole } = await supabase
            .from('user_roles')
            .select('is_active')
            .eq('user_id', roleData.owner_id)
            .maybeSingle();

          if (ownerRole?.is_active === false) {
            return { blocked: true, reason: 'owner_inactive' };
          }
        }

        // Check owner license if cashier, or own license
        const targetUserId = (roleData.role === 'cashier' && roleData.owner_id)
          ? roleData.owner_id
          : userId;

        const { data: licenseData, error: licenseError } = await supabase
          .from('app_licenses')
          .select('is_revoked')
          .eq('user_id', targetUserId)
          .maybeSingle();

        if (licenseError) {
          console.warn('[AccountCheck] Error querying app_licenses:', licenseError);
        }

        if (licenseData?.is_revoked === true) {
          return { blocked: true, reason: 'revoked' };
        }
      } else {
        // Fallback: check app_licenses directly if no user_role record found
        const { data: licenseData } = await supabase
          .from('app_licenses')
          .select('is_revoked')
          .eq('user_id', userId)
          .maybeSingle();

        if (licenseData?.is_revoked === true) {
          return { blocked: true, reason: 'revoked' };
        }
      }

      return { blocked: false };
    })();

    const timeoutPromise = new Promise<{ blocked: boolean; reason?: string }>((resolve) => {
      setTimeout(() => resolve({ blocked: false }), timeoutMs);
    });

    return await Promise.race([statusPromise, timeoutPromise]);
  } catch (err) {
    console.warn('[AccountCheck] Exception checking account status:', err);
    return { blocked: false };
  }
}
// Session persistence keys
export const STAY_LOGGED_IN_KEY = 'posflow_stay_logged_in';
export const SESSION_CACHE_KEY = 'posflow_session_cache';
export const AUTO_LOGIN_ATTEMPTED_KEY = 'posflow_auto_login_attempted';
export interface Profile {
  id: string;
  user_id: string;
  full_name: string | null;
  phone?: string | null;
  pin_hash?: string | null;
  avatar_url: string | null;
  preferred_language: string | null;
  user_type: 'cashier' | 'distributor' | 'pos' | null;
  allowed_pages: string[] | null;
}
export type SignInResult = {
  error: Error | null;
  blockedReason?: 'inactive' | 'owner_inactive' | 'revoked' | string;
  data?: { user: User; session: Session };
};
export interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  isLoading: boolean;
  isAutoLoginChecking: boolean;
  stayLoggedIn: boolean;
  signIn: (email: string, password: string, stayLoggedIn?: boolean) => Promise<SignInResult>;
  signInWithIdToken: (token: string, nonce?: string, stayLoggedIn?: boolean) => Promise<SignInResult>;
  signUp: (email: string, password: string, fullName: string, phone?: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  setStayLoggedIn: (value: boolean) => void;
}
export const AuthContext = createContext<AuthContextType | undefined>(undefined);
// Helper to check if we should stay logged in
export const getStayLoggedInPreference = (): boolean => {
  try {
    return localStorage.getItem(STAY_LOGGED_IN_KEY) === 'true';
  } catch {
    return false;
  }
};
// Helper to cache session for faster restore
export const cacheSession = (session: Session | null) => {
  try {
    if (session) {
      localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify({
        user: session.user,
        session: session,
        expires_at: session.expires_at,
        cached_at: Date.now()
      }));
    } else {
      localStorage.removeItem(SESSION_CACHE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
};
// Get cached session for immediate UI restore (checks SESSION_CACHE_KEY and Supabase auth token keys)
export const getCachedSession = (): { user: User | null; session: Session | null } => {
  try {
    // 0. Guest Demo Mode check - instant offline demo identity
    if (isGuestDemoMode()) {
      const demoUser = {
        id: 'guest-demo-user',
        email: 'guest@posflow.demo',
        role: 'authenticated',
        aud: 'authenticated',
        app_metadata: {},
        user_metadata: { full_name: 'مستخدم تجريبي (Demo)' },
        created_at: new Date().toISOString(),
      } as unknown as User;
      const demoSession = {
        access_token: 'demo-token',
        token_type: 'bearer',
        expires_in: 86400,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        refresh_token: 'demo-refresh',
        user: demoUser,
      } as unknown as Session;
      return { user: demoUser, session: demoSession };
    }

    // 1. Check custom posflow_session_cache
    const cached = localStorage.getItem(SESSION_CACHE_KEY);
    if (cached) {
      const data = JSON.parse(cached);
      if (data?.user) {
        return {
          user: data.user as User,
          session: (data.session || data) as unknown as Session,
        };
      }
    }

    // 2. Also check any Supabase auth token stored in localStorage (e.g. sb-*-auth-token)
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('sb-') && key.endsWith('-auth-token'))) {
        const item = localStorage.getItem(key);
        if (item) {
          const parsed = JSON.parse(item);
          const foundUser = parsed?.user || parsed?.currentSession?.user || parsed?.session?.user;
          const foundSession = parsed?.session || parsed?.currentSession || (parsed?.access_token ? parsed : null);
          if (foundUser) {
            return {
              user: foundUser as User,
              session: (foundSession || { user: foundUser, access_token: 'cached-token' }) as unknown as Session,
            };
          }
        }
      }
    }
  } catch (e) {
    console.warn('[Auth] Error reading cached session:', e);
  }
  return { user: null, session: null };
};
// ✅ تفريغ شامل للبيانات المحلية وعزل الحسابات (Local Storage + IndexedDB + Cloud Caches)
export const clearAllUserSessionCaches = async () => {
  try {
    // 1. مسح جميع المفاتيح المحلية التابعة للنظام
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('posflow_') || key.startsWith('posflow_') || key.startsWith('fps_swr_'))) {
        // استثناء إعدادات اللغة والثيم والحساب وبصمة الجهاز المحفوظة الضرورية
        if (
          !key.startsWith('posflow_sync_pending_') &&
          key !== 'posflow_language' &&
          key !== 'posflow_theme' &&
          key !== 'posflow_stay_logged_in' &&
          !key.startsWith('posflow_setup_complete_') && // علم الإعداد لكل مستخدم يبقى؛ المفتاح العام القديم يُمسح
          key !== 'posflow_privacy_accepted' &&
          key !== 'posflow_privacy_version' &&
          key !== 'posflow_device_id' &&       // 👈 حماية بصمة الجهاز من المسح عند الخروج
          key !== 'hp_device_id' &&              // 👈 حماية مفتاح أمان العتاد
          key !== 'posflow_persistent_hardware_id' && // 👈 حماية البصمة الاحتياطية الدائمة
          !key.startsWith('posflow_app_lock_') && // 👈 حماية إعدادات وهاش قفل الأمان من المسح عند الخروج
          !key.startsWith('posflow_pin_reset_required_') // 👈 حماية راية إلزام تعيين الـ PIN بعد نسيانه
        ) {
          keysToRemove.push(key);
        }
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
    console.log(`[Auth] Cleared ${keysToRemove.length} storage keys`);

    // 1.1 تفريغ محرك كاش SWR الفوري من الذاكرة والتخزين لضمان العزل التام
    try {
      const { NativeSWRCache } = await import('@/lib/cache/native-swr-cache');
      NativeSWRCache.clear();
      console.log('[Auth] Cleared NativeSWRCache');
    } catch (err) {
      console.warn('[Auth] Error clearing NativeSWRCache:', err);
    }

    // 2. تفريغ IndexedDB للمنتجات والصور
    try {
      const { clearProductsIDB } = await import('@/lib/indexeddb-cache');
      await clearProductsIDB();
      if (typeof window !== 'undefined' && window.indexedDB) {
        window.indexedDB.deleteDatabase('posflow_images_cache');
      }
      console.log('[Auth] Cleared IndexedDB and image cache');
    } catch (err) {
      console.warn('[Auth] Cache cleanup error:', err);
    }

    // 3. إبطال كاش الذاكرة
    try {
      const { invalidateAllCaches } = await import('@/lib/cloud');
      invalidateAllCaches();
      console.log('[Auth] Invalidated all memory caches');
    } catch (err) {
      console.warn('[Auth] Failed to invalidate memory caches:', err);
    }
  } catch (ex) {
    console.warn('[Auth] Exception in clearAllUserSessionCaches:', ex);
  }
};
export const SAFE_AUTH_FALLBACK: AuthContextType = {
  user: null,
  session: null,
  profile: null,
  isLoading: true,
  isAutoLoginChecking: false,
  stayLoggedIn: false,
  signIn: async () => ({ error: new Error('جاري تهيئة المصادقة...') }),
  signInWithIdToken: async () => ({ error: new Error('جاري تهيئة المصادقة...') }),
  signUp: async () => ({ error: new Error('جاري تهيئة المصادقة...') }),
  signOut: async () => {},
  refreshProfile: async () => {},
  setStayLoggedIn: () => {},
};
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    console.warn('[Auth] useAuth accessed outside AuthProvider, using safe fallback');
    return SAFE_AUTH_FALLBACK;
  }
  return context;
}
