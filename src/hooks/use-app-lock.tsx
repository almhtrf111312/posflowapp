import React, { createContext, useContext, useState, useEffect, useRef, useCallback, ReactNode } from 'react';
import { useAuth } from './use-auth';
import { useAppLifecycle } from './use-app-lifecycle';

export interface AppLockConfig {
  enabled: boolean;
  timeoutSeconds: number; // 0 = فوري، 60 = دقيقة، 300 = 5 دقائق
}

export interface AppLockContextType {
  isLocked: boolean;
  isLockEnabled: boolean;
  lockTimeout: number;
  failedAttempts: number;
  lockoutRemainingSeconds: number;
  isLockedOut: boolean;
  lockApp: () => void;
  unlockApp: (pin: string) => Promise<boolean>;
  setLockConfig: (config: AppLockConfig) => Promise<void>;
  updatePin: (newPin: string) => Promise<void>;
}

const AppLockContext = createContext<AppLockContextType | undefined>(undefined);

// دوال مساعدة لتوليد الملح والهاش أوفلاين
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
  // Fallback عشوائي آمن في حال عدم توفر Web Crypto
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

  // مفاتيح التخزين المنسوبة للمستخدم الحالي
  const getStorageKey = useCallback((suffix: string) => {
    return userId ? `flowpos_app_lock_${userId}_${suffix}` : null;
  }, [userId]);

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

  // حالة القفل اللحظية - تهيئة متزامنة لمنع أي وميض بصري (Zero Flash)
  const [isLocked, setIsLocked] = useState<boolean>(() => {
    if (!userId) return false;
    const enabled = localStorage.getItem(`flowpos_app_lock_${userId}_enabled`) === 'true';
    const hasHash = !!localStorage.getItem(`flowpos_app_lock_${userId}_hash`);
    // فحص ما إذا كان المستخدم قد فتح القفل بالفعل في جلسة المتصفح الحالية
    const sessionUnlocked = sessionStorage.getItem(`flowpos_app_lock_${userId}_session_unlocked`) === 'true';
    return enabled && hasHash && !sessionUnlocked;
  });

  const [failedAttempts, setFailedAttempts] = useState<number>(0);
  const [lockoutRemainingSeconds, setLockoutRemainingSeconds] = useState<number>(0);

  const pauseTimestampRef = useRef<number | null>(null);
  const isLockedRef = useRef(isLocked);
  isLockedRef.current = isLocked;

  // مزامنة حالة التفعيل والمهلة عند تبديل المستخدم أو تسجيل الدخول
  useEffect(() => {
    if (!userId || authLoading) {
      setIsLocked(false);
      setIsLockEnabled(false);
      return;
    }

    const enabled = localStorage.getItem(`flowpos_app_lock_${userId}_enabled`) === 'true';
    const hasHash = !!localStorage.getItem(`flowpos_app_lock_${userId}_hash`);
    const timeoutVal = localStorage.getItem(`flowpos_app_lock_${userId}_timeout`);
    const sessionUnlocked = sessionStorage.getItem(`flowpos_app_lock_${userId}_session_unlocked`) === 'true';

    setIsLockEnabled(enabled);
    setLockTimeout(timeoutVal ? parseInt(timeoutVal, 10) : 0);

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

  // استهلاك دورة حياة التطبيق (useAppLifecycle) دون أي تعديل على ملف البنية التحتية
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
      // إغلاق أمني صارم (Fail-Closed): غياب أو مسح بيانات التجزئة يمنع فتح القفل تماماً
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

  const setLockConfig = useCallback(async (config: AppLockConfig) => {
    if (!userId) return;

    localStorage.setItem(`flowpos_app_lock_${userId}_enabled`, String(config.enabled));
    localStorage.setItem(`flowpos_app_lock_${userId}_timeout`, String(config.timeoutSeconds));

    setIsLockEnabled(config.enabled);
    setLockTimeout(config.timeoutSeconds);

    if (!config.enabled) {
      setIsLocked(false);
      sessionStorage.removeItem(`flowpos_app_lock_${userId}_session_unlocked`);
    }
  }, [userId]);

  const updatePin = useCallback(async (newPin: string) => {
    if (!userId) return;

    const salt = generateRandomSalt();
    const hash = await computePinHash(salt, newPin);

    localStorage.setItem(`flowpos_app_lock_${userId}_salt`, salt);
    localStorage.setItem(`flowpos_app_lock_${userId}_hash`, hash);
    localStorage.setItem(`flowpos_app_lock_${userId}_enabled`, 'true');

    setIsLockEnabled(true);
  }, [userId]);

  const isLockedOut = lockoutRemainingSeconds > 0;

  return (
    <AppLockContext.Provider
      value={{
        isLocked: isLocked && !!user && !authLoading,
        isLockEnabled,
        lockTimeout,
        failedAttempts,
        lockoutRemainingSeconds,
        isLockedOut,
        lockApp,
        unlockApp,
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
