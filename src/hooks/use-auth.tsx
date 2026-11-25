import { useState, useEffect, ReactNode, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { User, Session } from '@supabase/supabase-js';
import { getDeviceId } from '@/lib/device-fingerprint';
import { toast } from '@/lib/sonner-bridge';
import { isGuestDemoMode, clearGuestDemoData } from '@/lib/demo-data';
import { checkUserAccountStatus, STAY_LOGGED_IN_KEY, AUTO_LOGIN_ATTEMPTED_KEY, AuthContext, getStayLoggedInPreference, cacheSession, getCachedSession, clearAllUserSessionCaches } from '@/hooks/auth-context';
import type { Profile, SignInResult } from '@/hooks/auth-context';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [cachedInitial] = useState(() => getCachedSession());
  const [user, setUser] = useState<User | null>(() => cachedInitial.user);
  const [session, setSession] = useState<Session | null>(() => cachedInitial.session);
  const [profile, setProfile] = useState<Profile | null>(() => {
    try {
      const p = localStorage.getItem('posflow_cached_profile');
      return p ? JSON.parse(p) : null;
    } catch { return null; }
  });
  // Instant boot: if cached user exists, isLoading is immediately false (0ms)!
  const [isLoading, setIsLoading] = useState<boolean>(() => !cachedInitial.user);
  const [isAutoLoginChecking, setIsAutoLoginChecking] = useState(false);
  const [stayLoggedIn, setStayLoggedInState] = useState(getStayLoggedInPreference);

  const fetchProfile = useCallback(async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        console.error('Error fetching profile:', error);
        return null;
      }
      if (data) {
        try { localStorage.setItem('posflow_cached_profile', JSON.stringify(data)); } catch { /* ignore storage error */ }
      }
      return data as Profile | null;
    } catch (err) {
      console.error('Error in fetchProfile:', err);
      return null;
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    if (user) {
      const profileData = await fetchProfile(user.id);
      setProfile(profileData);
    }
  }, [user, fetchProfile]);

  // Set stay logged in preference
  const setStayLoggedIn = useCallback((value: boolean) => {
    try {
      localStorage.setItem(STAY_LOGGED_IN_KEY, value.toString());
      setStayLoggedInState(value);
    } catch {
      // Ignore storage errors
    }
  }, []);

  // Sync auth state immediately when guest demo mode is started or ended
  useEffect(() => {
    const handleDemoAuth = () => {
      if (isGuestDemoMode()) {
        const demoData = getCachedSession();
        if (demoData.user) {
          setUser(demoData.user);
          setSession(demoData.session);
          setIsLoading(false);
        }
      } else {
        const realData = getCachedSession();
        setUser(realData.user);
        setSession(realData.session);
      }
    };
    window.addEventListener('guest-demo-started', handleDemoAuth);
    window.addEventListener('guest-demo-ended', handleDemoAuth);
    window.addEventListener('storage', handleDemoAuth);
    return () => {
      window.removeEventListener('guest-demo-started', handleDemoAuth);
      window.removeEventListener('guest-demo-ended', handleDemoAuth);
      window.removeEventListener('storage', handleDemoAuth);
    };
  }, []);

  useEffect(() => {
    // Immediately restore from cache if not already set
    const cachedData = getCachedSession();
    if (cachedData.user && !user) {
      setUser(cachedData.user);
      setSession(cachedData.session);
      setIsLoading(false);
    }

    // Set up auth state listener
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, currentSession) => {
        // In Guest Demo Mode, never let Supabase remote auth events overwrite the demo identity unless explicit SIGNED_OUT
        if (isGuestDemoMode() && event !== 'SIGNED_OUT') {
          return;
        }

        // Strict Offline-First: If supabase reports no session but we have local cache, ignore empty event
        if (!currentSession?.user && getCachedSession().user && event !== 'SIGNED_OUT') {
          return;
        }

        // Skip unnecessary state updates on TOKEN_REFRESHED to prevent re-renders that close dialogs
        if (event === 'TOKEN_REFRESHED' && currentSession?.user) {
          setSession(currentSession);
          setUser(prev => {
            if (prev?.id === currentSession.user.id) return prev;
            return currentSession.user;
          });
          cacheSession(currentSession);
          return;
        }

        if (currentSession?.user) {
          setSession(currentSession);
          setUser(currentSession.user);
          cacheSession(currentSession);
          setIsLoading(false);

          // Fetch profile asynchronously in background
          setTimeout(async () => {
            const profileData = await fetchProfile(currentSession.user.id);
            if (profileData) setProfile(profileData);
          }, 0);
        } else if (event === 'SIGNED_OUT') {
          // Explicit sign out only
          setSession(null);
          setUser(null);
          setProfile(null);
          cacheSession(null);
          setIsLoading(false);
        }
      }
    );

    // Attempt device auto-login function - runs in background with strict 1.5s timeout
    const attemptDeviceAutoLogin = async () => {
      const AUTO_LOGIN_TIMEOUT_MS = 1500;

      try {
        // Skip auto-login in Guest Demo Mode
        if (isGuestDemoMode()) {
          return true;
        }

        // If we already have a user, do not auto-login
        if (user || cachedInitial.user) {
          return true;
        }

        // Check if we already attempted auto-login recently
        const alreadyAttempted = sessionStorage.getItem(AUTO_LOGIN_ATTEMPTED_KEY);
        if (alreadyAttempted) {
          console.log('[AutoLogin] Already attempted, skipping');
          return false;
        }

        console.log('[AutoLogin] Starting device auto-login...');
        setIsAutoLoginChecking(true);

        const deviceId = await getDeviceId();
        console.log('[AutoLogin] Device ID:', deviceId);

        const invokePromise = supabase.functions.invoke('device-auto-login', {
          body: { device_id: deviceId }
        });
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('AUTO_LOGIN_TIMEOUT')), AUTO_LOGIN_TIMEOUT_MS);
        });

        const { data, error } = await Promise.race([invokePromise, timeoutPromise]);

        if (error) {
          console.error('[AutoLogin] Edge function error:', error);
          return false;
        }

        console.log('[AutoLogin] Response:', data);

        if (data?.success && data?.action_link) {
          try {
            const { data: otpData, error: otpError } = await supabase.auth.verifyOtp({
              email: data.email,
              token: data.verification_token,
              type: 'magiclink'
            });

            if (otpError) {
              console.error('[AutoLogin] OTP verification error:', otpError);
              return false;
            }

            if (otpData?.session) {
              const accountCheck = await checkUserAccountStatus(otpData.session.user.id, 1500);
              if (accountCheck.blocked) {
                console.log('[AutoLogin] User account disabled or license revoked, rejecting auto-login');
                await supabase.auth.signOut();
                cacheSession(null);
                return false;
              }
              console.log('[AutoLogin] Session restored successfully!');
              setUser(otpData.session.user);
              setSession(otpData.session);
              cacheSession(otpData.session);
              return true;
            }
          } catch (otpErr) {
            console.error('[AutoLogin] OTP exception:', otpErr);
          }
        }

        return false;
      } catch (err) {
        console.error('[AutoLogin] Exception / timeout:', err);
        return false;
      } finally {
        setIsAutoLoginChecking(false);
        sessionStorage.setItem(AUTO_LOGIN_ATTEMPTED_KEY, 'true');
      }
    };

    // Hard safety net: never keep the app stuck on the loading screen
    const loadingSafetyTimer = setTimeout(() => {
      setIsAutoLoginChecking(false);
      setIsLoading(false);
    }, 1500);

    // If in Guest Demo Mode, keep the local mock identity and skip network verification
    if (isGuestDemoMode()) {
      setIsLoading(false);
      setIsAutoLoginChecking(false);
      return () => {
        clearTimeout(loadingSafetyTimer);
        subscription.unsubscribe();
      };
    }

    // Check for existing session and verify user without blocking UI
    const sessionPromise = supabase.auth.getSession();
    const sessionTimeout = new Promise<{ data: { session: null } }>((resolve) =>
      setTimeout(() => resolve({ data: { session: null } }), 1500)
    );
    Promise.race([sessionPromise, sessionTimeout]).then(async ({ data: { session: existingSession } }) => {
      if (existingSession?.user) {
        // Active session retrieved from Supabase
        setUser(existingSession.user);
        setSession(existingSession);
        setIsLoading(false);
        cacheSession(existingSession);

        // Verify user in the background with a strict 1.5s timeout (prevents dead VPN hangs)
        try {
          const userPromise = supabase.auth.getUser();
          const timeoutPromise = new Promise<{ data: { user: null }; error: Error }>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 1500)
          );

          const { data, error: userError } = await Promise.race([userPromise, timeoutPromise]);
          const currentUser = data?.user;

          if (userError || !currentUser) {
            console.log('[Auth] Network timeout or error verifying user, keeping existing session');
            return;
          }

          // Check if user account is deactivated or license is revoked on startup
          if (currentUser) {
            const accountCheck = await checkUserAccountStatus(currentUser.id, 1500);
            if (accountCheck.blocked) {
              console.log('[Auth] Account is disabled or license is revoked, signing out immediately...');
              toast.error('تم تعطيل هذا الحساب أو إلغاء ترخيصه، يرجى التواصل مع الإدارة');
              await supabase.auth.signOut();
              cacheSession(null);
              setUser(null);
              setSession(null);
              setProfile(null);
              return;
            }
          }
        } catch {
          // Network timeout / dead VPN / offline - trust existing local session!
          console.log('[Auth] Network probe timeout (e.g. dead VPN), trusting active session');
        }
        return;
      }

      // If no session from Supabase, but we already have a cached user from localStorage
      if (cachedInitial.user) {
        setIsLoading(false);
        // Verify account silently in background with timeout (1.5s) without blocking
        checkUserAccountStatus(cachedInitial.user.id, 1500).then(async (accountCheck) => {
          if (accountCheck.blocked) {
            toast.error('تم تعطيل هذا الحساب أو إلغاء ترخيصه، يرجى التواصل مع الإدارة');
            await supabase.auth.signOut();
            cacheSession(null);
            setUser(null);
            setSession(null);
            setProfile(null);
          }
        }).catch(() => {
          // Offline / network failure -> keep session
        });
        return;
      }

      // No session and no cached user: try device auto-login in background
      const autoLoginSuccess = await attemptDeviceAutoLogin();
      if (!autoLoginSuccess) {
        setIsLoading(false);
      }
    });

    // Periodic session refresh for background (every minute)
    const refreshInterval = setInterval(async () => {
      try {
        const { data: { session: currentSession } } = await supabase.auth.getSession();
        if (currentSession) {
          const expiresAt = currentSession.expires_at;
          if (expiresAt && (expiresAt - Date.now() / 1000) < 600) {
            await supabase.auth.refreshSession();
          }
        }
      } catch {
        // Offline / network issue
      }
    }, 60000);

    return () => {
      clearTimeout(loadingSafetyTimer);
      subscription.unsubscribe();
      clearInterval(refreshInterval);
    };
    // Intentionally not keyed on `user`: this effect owns the auth subscription, so it must be created once per session
    // bootstrap; the `user` it reads is only the value at start-up (the later auto-login check is guarded by cachedInitial too).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchProfile, cachedInitial.user]);

  const signIn = (email: string, password: string, rememberMe: boolean = false): Promise<SignInResult> =>
    completeSignIn(() => supabase.auth.signInWithPassword({ email, password }), rememberMe, { email });

  // تسجيل الدخول برمز هوية (Google) — نفس فحوص الحساب والتنظيف التي يمر بها الدخول بالبريد
  const signInWithIdToken = (token: string, nonce: string | undefined, rememberMe: boolean = true): Promise<SignInResult> =>
    completeSignIn(
      () => supabase.auth.signInWithIdToken({ provider: 'google', token, ...(nonce ? { nonce } : {}) }),
      rememberMe,
      { method: 'google' },
    );

  const completeSignIn = async (
    authCall: () => Promise<{ data: { user: User | null; session: Session | null }; error: { message: string } | null }>,
    rememberMe: boolean,
    logMeta: Record<string, unknown>,
  ): Promise<SignInResult> => {
    try {
      // Cleanly wipe any demo leftovers before establishing real user session
      if (isGuestDemoMode()) {
        await clearGuestDemoData(true);
      }

      const { data, error } = await authCall();
      
      // Set stay logged in preference and cache session
      if (!error && data.session) {
        setStayLoggedIn(rememberMe);
        cacheSession(data.session);
      }
      
      // Log successful login
      if (!error && data.user) {
        // Dynamically import to avoid circular dependencies
        import('@/lib/activity-log').then(({ addActivityLog }) => {
          addActivityLog(
            'login',
            data.user.id,
            data.user.email || 'مستخدم',
            `تم تسجيل الدخول بنجاح`,
            { ...logMeta, stayLoggedIn: rememberMe }
          );
        });
      }
      
      if (error) {
        return { error: new Error(error.message) };
      }

      // Check if account is inactive or license revoked immediately upon sign in
      if (data?.user) {
        const accountCheck = await checkUserAccountStatus(data.user.id);
        if (accountCheck.blocked) {
          await supabase.auth.signOut();
          cacheSession(null);
          setUser(null);
          setSession(null);
          setProfile(null);
          return {
            error: new Error('تم تعطيل هذا الحساب أو إلغاء ترخيصه'),
            blockedReason: (accountCheck.reason as 'inactive' | 'owner_inactive' | 'revoked') || 'inactive',
          };
        }
      }
      
      // ✅ مسح شامل للبيانات المحلية لمنع تسرب بيانات الحساب السابق
      if (data.user) {
        await clearAllUserSessionCaches();
      }
      
      return { 
        error: null, 
        data: data.user && data.session ? { user: data.user, session: data.session } : undefined 
      };
    } catch (err) {
      return { error: err as Error };
    }
  };

  const signUp = async (email: string, password: string, fullName: string, phone?: string) => {
    try {
      // Cleanly wipe any demo leftovers before registering real user
      if (isGuestDemoMode()) {
        await clearGuestDemoData(true);
      }

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
            phone: phone || undefined,
          },
          emailRedirectTo: window.location.origin,
        },
      });

      if (error) {
        return { error: new Error(error.message) };
      }

      return { error: null };
    } catch (err) {
      return { error: err as Error };
    }
  };

  const signOut = async () => {
    // If in demo mode, clean up demo data and return immediately
    if (isGuestDemoMode()) {
      await clearGuestDemoData(true);
      setUser(null);
      setSession(null);
      setProfile(null);
      cacheSession(null);
      setIsLoading(false);
      return;
    }

    // Log logout before signing out
    if (user) {
      import('@/lib/activity-log').then(({ addActivityLog }) => {
        addActivityLog(
          'logout',
          user.id,
          user.email || profile?.full_name || 'مستخدم',
          `تم تسجيل الخروج`,
          {}
        );
      });

      // مسح كاش ربط الجهاز المحلي فقط دون المساس بقاعدة البيانات (الجهاز يبقى مقيداً دائماً)
      try {
        const { clearDeviceBindingCache } = await import('./use-device-binding');
        clearDeviceBindingCache();
      } catch { /* */ }
    }
    
    // Clear auto-login attempt flag so next app open can try again
    try {
      sessionStorage.removeItem(AUTO_LOGIN_ATTEMPTED_KEY);
      // Clear session cache
      cacheSession(null);
    } catch {
      // Ignore storage errors
    }
    
    // ✅ مسح شامل للبيانات المحلية وكاش الجلسة عند تسجيل الخروج
    await clearAllUserSessionCaches();

    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
    setProfile(null);
  };

  // مراقبة الجلسة: إذا ألغى المالك الجلسة من الخادم (إلغاء ربط الجهاز / تغيير كلمة المرور)
  // يبقى رمز الدخول صالحاً محلياً حتى ينتهي، لذلك نسأل الخادم دورياً ونسجّل الخروج فوراً عند رفضه.
  useEffect(() => {
    if (!user || isGuestDemoMode()) return;
    let cancelled = false;
    let running = false;
    const check = async () => {
      if (running || cancelled || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
      running = true;
      try {
        const { error } = await supabase.auth.getUser();
        if (cancelled || !error) return;
        const e = error as { status?: number; code?: string; message?: string };
        const revoked =
          e.status === 401 || e.status === 403 ||
          /session_not_found|refresh_token_not_found|user_not_found|session.*(missing|not exist)/i.test(`${e.code || ''} ${e.message || ''}`);
        if (revoked) {
          toast.error('تم تسجيل خروجك لأن المالك غيّر بيانات حسابك أو ألغى ربط الجهاز، سجّل الدخول من جديد');
          await signOut();
          window.location.reload();
        }
      } catch {
        // أخطاء الشبكة: لا نسجّل الخروج
      } finally {
        running = false;
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    const id = window.setInterval(check, 30000);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', onVisible);
    void check();
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  return (
    <AuthContext.Provider value={{
      user,
      session,
      profile,
      isLoading,
      isAutoLoginChecking,
      stayLoggedIn,
      signIn,
      signInWithIdToken,
      signUp,
      signOut,
      refreshProfile,
      setStayLoggedIn,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
