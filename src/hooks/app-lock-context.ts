import { createContext, useContext } from 'react';
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

export const AppLockContext = createContext<AppLockContextType | undefined>(undefined);

// دالة تعيين رمز PIN في واجهة المستخدم مع التقاط الأخطاء الصريحة
export async function setUserPinSecurely(targetUserId: string, rawPin: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await (supabase as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }).rpc('set_user_pin', {
      _target_user_id: targetUserId,
      _raw_pin: rawPin.trim(),
    });

    if (error) {
      console.error('[Security] set_user_pin error:', error.message);
      return { success: false, error: error.message };
    }

    return { success: !!data };
  } catch (err: unknown) {
    const msg = typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : '';
    return { success: false, error: msg || 'فشل تعيين رمز الأمان' };
  }
}

// دالة التحقق الآمن مع التأكد من وجود جلسة مسجلة قبل الاستدعاء
export async function verifyPinSecurely(userId: string, enteredPin: string): Promise<boolean> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    console.warn('[Security] محاولة تحقق من PIN دون جلسة نشطة - تم المنع محلياً');
    return false;
  }

  const { data, error } = await (supabase as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }).rpc('verify_user_pin', {
    _user_id: userId,
    _entered_pin: enteredPin.trim(),
  });

  if (error) {
    console.error('[Security] verify_user_pin failed:', error.message);
    return false;
  }

  return !!data;
}

// تحويل مصفوفة بايت إلى تمثيل سداسي عشري
export function bufferToHex(buffer: ArrayBuffer): string {
  const byteArray = new Uint8Array(buffer);
  let hexString = '';
  for (let i = 0; i < byteArray.length; i++) {
    hexString += byteArray[i].toString(16).padStart(2, '0');
  }
  return hexString;
}

export function generateRandomSalt(): string {
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

export async function computePinHash(salt: string, rawPin: string): Promise<string> {
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

export function useAppLock(): AppLockContextType {
  const context = useContext(AppLockContext);
  if (!context) {
    throw new Error('useAppLock must be used within an AppLockProvider');
  }
  return context;
}
