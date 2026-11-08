import React, { createContext, useContext, useState, useEffect, useRef, useCallback, ReactNode } from 'react';
import { useAuth } from './use-auth';
import { useAppLifecycle } from './use-app-lifecycle';
import { isBiometricSupported, registerBiometricCredential, authenticateBiometric } from '@/lib/biometric-auth';
import { supabase } from '@/integrations/supabase/client';

export interface AppLockConfig {
  enabled: boolean;
  timeoutSeconds: number; // 0 = فوري، 60 = دقيقة، 300 = 5 دقائق
}

export interface AppLockContextType {
  isLocked: boolean;
  isLockEnabled: boolean;
  lockTimeout: number;
  pinLength: number;
  failedAttempts: number;
  lockoutRemainingSeconds: number;
  isLockedOut: boolean;
  isBiometricAvailable: boolean;
  isBiometricEnabled: boolean;
  requiresPinSetup: boolean;
  completePinSetup: (newPin: string) => Promise<boolean>;
  lockApp: () => void;
  unlockApp: (pin: string) => Promise<boolean>;
  unlockWithBiometrics: () => Promise<boolean>;
  toggleBiometrics: (enabled: boolean, pin?: string) => Promise<boolean>;
  setLockConfig: (config: AppLockConfig) => Promise<void>;
  updatePin: (newPin: string) => Promise<void>;
}

const AppLockContext = createContext<AppLockContextType | undefined>(undefined);

// تحويل مصفوفة بايت إلى تمثيل سداسي عشري
function bufferToHex(buffer: ArrayBuffer): string {
  const byteArray = new Uint8Array(buffer);
  let hexString = '';
  for (let i = 0; i < byteArray.length; i++) {
    hexString += byteArray[i].toString(16).padStart(2, '0');
  }
  return hexString;
}

function generateRandomSalt(): string {
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return bufferToHex(bytes.buffer);
  }
  let fallback = '';
  for (let i = 0; i < 32; i++) {
    fallback += Math.floor(Math.random() * 16).toString(16);
  }
  return fallback;
}

async function computePinHash(salt: string, rawPin: string): Promise<string> {
  const combined = `${salt}:${rawPin.trim()}`;
  if (typeof window !== 'undefined' && window.crypto?.subtle?.digest) {
    const encoder = new TextEncoder();
    const data = encoder.encode(combined);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
    return bufferToHex(hashBuffer);
  }
  
  // حماية مشددة: منع الرجوع لأي خوارزمية تجزئة ضعيفة
  throw new Error('[AppLock] Web Crypto API is required for secure PIN hashing');
}

export function AppLockProvider({ children }: { children: ReactNode }) {
  const { user, isLoading: authLoading } = useAuth();
  const userId = user?.id;

  // حالة تفعيل القفل للمستخدم
  const [isLockEnabled, setIsLockEnabled] = useState<boolean>(() => {
    if (!userId) return false;
    return localStorage.getItem(`flowpos_app_lock_${userId}_enabled`) === 'true';
  });

  // مهلة القفل بالثواني
  const [lockTimeout, setLockTimeout] = useState<number>(() => {
    if (!userId) return 0;
    const val = localStorage.getItem(`flowpos_app_lock_${userId}_timeout`);
    return val ? parseInt(val, 10) : 0;
  });

  // طول الرمز المخزن (افتراضياً 4 خانات)
  const [pinLength, setPinLength] = useState<number>(() => {
    if (!userId) return 4;
    const val = localStorage.getItem(`flowpos_app_lock_${userId}_length`);
    return val ? parseInt(val, 10) : 4;
  });

  // راية إلزام تعيين PIN جديد بعد نسيانه وتسجيل الدخول بكلمة المرور الماستر
  const [requiresPinSetup, setRequiresPinSetup] = useState<boolean>(() => {
    if (!userId) return false;
    return localStorage.getItem(`flowpos_pin_reset_required_${userId}`) === 'true';
  });

  // دعم وأجهزة البصمة المتاحة
  const [isBiometricAvailable, setIsBiometricAvailable] = useState<boolean>(false);
  const [isBiometricEnabled, setIsBiometricEnabled] = useState<boolean>(() => {
    if (!userId) return false;
    return localStorage.getItem(`flowpos_app_lock_${userId}_biometric_enabled`) === 'true';
  });

  // حالة القفل اللحظية - تهيئة متزامنة لمنع أي وميض بصري (Zero Flash)
  const [isLocked, setIsLocked] = useState<boolean>(() => {
    if (!userId) return false;
    const enabled = localStorage.getItem(`flowpos_app_lock_${userId}_enabled`) === 'true';
    const hasHash = !!localStorage.getItem(`flowpos_app_lock_${userId}_hash`);
    const sessionUnlocked = sessionStorage.getItem(`flowpos_app_lock_${userId}_session_unlocked`) === 'true';
    return enabled && hasHash && !sessionUnlocked;
  });

  const [failedAttempts, setFailedAttempts] = useState<number>(0);
  const [lockoutRemainingSeconds, setLockoutRemainingSeconds] = useState<number>(0);

  const pauseTimestampRef = useRef<number | null>(null);
  const isLockedRef = useRef(isLocked);
  isLockedRef.current = isLocked;

  // فحص توفر أجهزة البصمة على المنصة الحالية
  useEffect(() => {
    let mounted = true;
    isBiometricSupported().then((supported) => {
      if (mounted) {
        setIsBiometricAvailable(supported);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  // مزامنة حالة التفعيل والمهلة عند تبديل المستخدم أو تسجيل الدخول
  useEffect(() => {
    if (!userId || authLoading) {
      setIsLocked(false);
      setIsLockEnabled(false);
      setIsBiometricEnabled(false);
      setRequiresPinSetup(false);
      return;
    }

    const resetRequired = localStorage.getItem(`flowpos_pin_reset_required_${userId}`) === 'true';
    if (resetRequired) {
      // 🔒 مسح الرمز المنسي محلياً فوراً لمنع فتح التطبيق مكشوفاً
      localStorage.removeItem(`flowpos_app_lock_${userId}_enabled`);
      localStorage.removeItem(`flowpos_app_lock_${userId}_hash`);
      localStorage.removeItem(`flowpos_app_lock_${userId}_salt`);
      localStorage.removeItem(`flowpos_app_lock_${userId}_length`);
      localStorage.removeItem(`flowpos_app_lock_${userId}_biometric_enabled`);
      localStorage.removeItem(`flowpos_app_lock_${userId}_biometric_cred_id`);
      localStorage.removeItem(`flowpos_app_lock_${userId}_lockout_until`);
      sessionStorage.removeItem(`flowpos_app_lock_${userId}_session_unlocked`);

      setIsLockEnabled(false);
      setIsLocked(false);
      setIsBiometricEnabled(false);
      setRequiresPinSetup(true);

      // تصفير الهاش السحابي عبر RPC
      void (supabase.rpc as any)('clear_user_pin', { _target_user_id: userId })
        .then(() => {
          console.log('[AppLock] Cloud PIN cleared successfully via RPC.');
        })
        .catch((err: any) => {
          console.warn('[AppLock] clear_user_pin RPC call notice:', err?.message || err);
        });

      return;
    }

    setRequiresPinSetup(false);

    const enabled = localStorage.getItem(`flowpos_app_lock_${userId}_enabled`) === 'true';
    const hasHash = !!localStorage.getItem(`flowpos_app_lock_${userId}_hash`);
    const timeoutVal = localStorage.getItem(`flowpos_app_lock_${userId}_timeout`);
    const lengthVal = localStorage.getItem(`flowpos_app_lock_${userId}_length`);
    const bioVal = localStorage.getItem(`flowpos_app_lock_${userId}_biometric_enabled`) === 'true';
    const sessionUnlocked = sessionStorage.getItem(`flowpos_app_lock_${userId}_session_unlocked`) === 'true';

    setIsLockEnabled(enabled);
    setLockTimeout(timeoutVal ? parseInt(timeoutVal, 10) : 0);
    setPinLength(lengthVal ? parseInt(lengthVal, 10) : 4);
    setIsBiometricEnabled(bioVal);

    // التحقق من انتهاء حظر التخمين المستمر
    const savedLockout = localStorage.getItem(`flowpos_app_lock_${userId}_lockout_until`);
    if (savedLockout) {
      const remainingMs = parseInt(savedLockout, 10) - Date.now();
      if (remainingMs > 0) {
        setLockoutRemainingSeconds(Math.ceil(remainingMs / 1000));
      } else {
        localStorage.removeItem(`flowpos_app_lock_${userId}_lockout_until`);
      }
    }

    if (enabled && hasHash && !sessionUnlocked) {
      setIsLocked(true);
    }
  }, [userId, authLoading]);

  // عداد الحظر التنازلي (Rate Limit Countdown)
  useEffect(() => {
    if (lockoutRemainingSeconds <= 0) return;

    const timer = setInterval(() => {
      setLockoutRemainingSeconds((prev) => {
        if (prev <= 1) {
          if (userId) {
            localStorage.removeItem(`flowpos_app_lock_${userId}_lockout_until`);
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [lockoutRemainingSeconds, userId]);

  // استهلاك دورة حياة التطبيق (useAppLifecycle)
  useAppLifecycle({
    onPause: useCallback(() => {
      if (!userId || !isLockEnabled) return;
      pauseTimestampRef.current = Date.now();
    }, [userId, isLockEnabled]),

    onResume: useCallback(() => {
      if (!userId || !isLockEnabled) return;
      if (isLockedRef.current) return; // التطبيق مقفل بالفعل

      const pausedAt = pauseTimestampRef.current;
      if (!pausedAt) return;

      const elapsedSeconds = (Date.now() - pausedAt) / 1000;
      if (elapsedSeconds >= lockTimeout) {
        setIsLocked(true);
        sessionStorage.removeItem(`flowpos_app_lock_${userId}_session_unlocked`);
      }
      pauseTimestampRef.current = null;
    }, [userId, isLockEnabled, lockTimeout]),
  });

  const lockApp = useCallback(() => {
    if (!userId || !isLockEnabled) return;
    setIsLocked(true);
    sessionStorage.removeItem(`flowpos_app_lock_${userId}_session_unlocked`);
  }, [userId, isLockEnabled]);

  const unlockApp = useCallback(async (pin: string): Promise<boolean> => {
    if (!userId) return false;

    // منع الإدخال أثناء سريان الحظر الزمني
    if (lockoutRemainingSeconds > 0) return false;

    const salt = localStorage.getItem(`flowpos_app_lock_${userId}_salt`);
    const storedHash = localStorage.getItem(`flowpos_app_lock_${userId}_hash`);

    if (!salt || !storedHash) {
      console.warn('[AppLock] Security parameters missing or cleared. Enforcing strict Fail-Closed.');
      setIsLocked(true);
      return false;
    }

    const calculatedHash = await computePinHash(salt, pin);

    if (calculatedHash === storedHash) {
      // رمز صحيح: إلغاء القفل وتصفير العدادات
      setIsLocked(false);
      setFailedAttempts(0);
      sessionStorage.setItem(`flowpos_app_lock_${userId}_session_unlocked`, 'true');
      localStorage.removeItem(`flowpos_app_lock_${userId}_lockout_until`);
      return true;
    }

    // رمز خاطئ: زيادة عداد الأخطاء وتطبيق الحظر بعد 5 محاولات
    const nextAttempts = failedAttempts + 1;
    setFailedAttempts(nextAttempts);

    if (nextAttempts >= 5) {
      const cooldownUntil = Date.now() + 30000; // 30 ثانية
      localStorage.setItem(`flowpos_app_lock_${userId}_lockout_until`, String(cooldownUntil));
      setLockoutRemainingSeconds(30);
      setFailedAttempts(0);
    }

    return false;
  }, [userId, lockoutRemainingSeconds, failedAttempts]);

  // فتح القفل باستخدام البصمة اللحظية
  const unlockWithBiometrics = useCallback(async (): Promise<boolean> => {
    if (!userId || !isBiometricEnabled || lockoutRemainingSeconds > 0) return false;

    const credId = localStorage.getItem(`flowpos_app_lock_${userId}_biometric_cred_id`);
    const success = await authenticateBiometric(credId);

    if (success) {
      setIsLocked(false);
      setFailedAttempts(0);
      sessionStorage.setItem(`flowpos_app_lock_${userId}_session_unlocked`, 'true');
      localStorage.removeItem(`flowpos_app_lock_${userId}_lockout_until`);
      return true;
    }
    return false;
  }, [userId, isBiometricEnabled, lockoutRemainingSeconds]);

  // تفعيل أو تعطيل الفتح بالبصمة
  const toggleBiometrics = useCallback(
    async (enabled: boolean, pin?: string): Promise<boolean> => {
      if (!userId) return false;

      if (!enabled) {
        localStorage.removeItem(`flowpos_app_lock_${userId}_biometric_enabled`);
        localStorage.removeItem(`flowpos_app_lock_${userId}_biometric_cred_id`);
        setIsBiometricEnabled(false);
        return true;
      }

      // لا يمكن تفعيل البصمة إذا كان قفل التطبيق معطلاً أو لا يوجد رمز PIN مخزن
      const storedHash = localStorage.getItem(`flowpos_app_lock_${userId}_hash`);
      if (!isLockEnabled || !storedHash) {
        console.warn('[AppLock] Cannot enable biometrics without an active PIN and App Lock.');
        return false;
      }

      // إذا تم تمرير PIN للتأكيد، نتحقق منه أولاً
      if (pin) {
        const salt = localStorage.getItem(`flowpos_app_lock_${userId}_salt`);
        if (!salt) return false;
        const calc = await computePinHash(salt, pin);
        if (calc !== storedHash) return false;
      }

      // تسجيل بيانات اعتماد البصمة على الجهاز
      const credId = await registerBiometricCredential(userId, user?.email || 'User');
      if (credId) {
        localStorage.setItem(`flowpos_app_lock_${userId}_biometric_cred_id`, credId);
      }
      localStorage.setItem(`flowpos_app_lock_${userId}_biometric_enabled`, 'true');
      setIsBiometricEnabled(true);
      return true;
    },
    [userId, user?.email, isLockEnabled]
  );

  const setLockConfig = useCallback(async (config: AppLockConfig) => {
    if (!userId) return;

    if (!config.enabled) {
      // 🔒 سياسة أمان صارمة: عند تعطيل القفل، يتم مسح الرمز المشفر والتمليح والبصمة بالكامل
      // بحيث يستحيل إعادة تفعيله إلا بإنشاء رمز PIN جديد تماماً
      localStorage.removeItem(`flowpos_app_lock_${userId}_enabled`);
      localStorage.removeItem(`flowpos_app_lock_${userId}_hash`);
      localStorage.removeItem(`flowpos_app_lock_${userId}_salt`);
      localStorage.removeItem(`flowpos_app_lock_${userId}_length`);
      localStorage.removeItem(`flowpos_app_lock_${userId}_biometric_enabled`);
      localStorage.removeItem(`flowpos_app_lock_${userId}_biometric_cred_id`);
      localStorage.removeItem(`flowpos_app_lock_${userId}_lockout_until`);
      sessionStorage.removeItem(`flowpos_app_lock_${userId}_session_unlocked`);

      setIsLockEnabled(false);
      setIsLocked(false);
      setIsBiometricEnabled(false);
      setPinLength(4);
      setFailedAttempts(0);
      setLockoutRemainingSeconds(0);
    } else {
      localStorage.setItem(`flowpos_app_lock_${userId}_enabled`, 'true');
      localStorage.setItem(`flowpos_app_lock_${userId}_timeout`, String(config.timeoutSeconds));

      setIsLockEnabled(true);
      setLockTimeout(config.timeoutSeconds);
    }
  }, [userId]);

  const updatePin = useCallback(async (newPin: string) => {
    if (!userId) return;

    const cleanPin = newPin.trim();
    const salt = generateRandomSalt();
    const hash = await computePinHash(salt, cleanPin);

    localStorage.setItem(`flowpos_app_lock_${userId}_salt`, salt);
    localStorage.setItem(`flowpos_app_lock_${userId}_hash`, hash);
    localStorage.setItem(`flowpos_app_lock_${userId}_length`, String(cleanPin.length));
    localStorage.setItem(`flowpos_app_lock_${userId}_enabled`, 'true');

    setIsLockEnabled(true);
    setPinLength(cleanPin.length);
  }, [userId]);

  // إكمال تعيين الرمز الإجباري وتأمين نقطة البيع
  const completePinSetup = useCallback(
    async (newPin: string): Promise<boolean> => {
      if (!userId) return false;

      const cleanPin = newPin.trim();
      if (cleanPin.length < 4 || cleanPin.length > 8) {
        return false;
      }

      try {
        // 1. تحديث الرمز محلياً وتفعيل القفل فوراً
        await updatePin(cleanPin);

        // 2. تحديث الرمز سحابياً لملف المستخدم
        try {
          await (supabase.rpc as any)('set_user_pin', {
            _target_user_id: userId,
            _raw_pin: cleanPin,
          });
        } catch (err: any) {
          console.warn('[AppLock] Cloud set_user_pin notice:', err?.message || err);
        }

        // 3. مسح راية طلب إعادة التعيين وتفعيل الجلسة
        localStorage.removeItem(`flowpos_pin_reset_required_${userId}`);
        sessionStorage.setItem(`flowpos_app_lock_${userId}_session_unlocked`, 'true');
        setRequiresPinSetup(false);
        return true;
      } catch (err) {
        console.error('[AppLock] Error completing PIN setup:', err);
        return false;
      }
    },
    [userId, updatePin]
  );

  const isLockedOut = lockoutRemainingSeconds > 0;

  return (
    <AppLockContext.Provider
      value={{
        isLocked: isLocked && !!user && !authLoading,
        isLockEnabled,
        lockTimeout,
        pinLength,
        failedAttempts,
        lockoutRemainingSeconds,
        isLockedOut,
        isBiometricAvailable,
        isBiometricEnabled,
        requiresPinSetup,
        completePinSetup,
        lockApp,
        unlockApp,
        unlockWithBiometrics,
        toggleBiometrics,
        setLockConfig,
        updatePin,
      }}
    >
      {children}
    </AppLockContext.Provider>
  );
}

export function useAppLock(): AppLockContextType {
  const context = useContext(AppLockContext);
  if (!context) {
    throw new Error('useAppLock must be used within an AppLockProvider');
  }
  return context;
}
