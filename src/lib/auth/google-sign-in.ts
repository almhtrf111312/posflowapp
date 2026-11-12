/**
 * تسجيل الدخول بجوجل — وحدة مستقلة وقابلة للإزالة بالكامل.
 *
 * للإيقاف السريع: اجعل GOOGLE_SIGN_IN_ENABLED = false (الزر يختفي فوراً).
 * للإزالة الكاملة: احذف هذا الملف + GoogleSignInButton.tsx + سطرين في Login.tsx
 * + FlowPosGoogleAuthPlugin.java وسطر تسجيله في MainActivity + تبعيات googleid في android/app/build.gradle.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { supabase } from '@/integrations/supabase/client';

/** مفتاح التشغيل الرئيسي */
export const GOOGLE_SIGN_IN_ENABLED = true;

/** من يُسمح له بالدخول بجوجل (القرار عند المالك؛ الافتراضي: المالك والبوس فقط) */
export const GOOGLE_ALLOWED_ROLES: ReadonlyArray<string> = ['admin', 'boss'];

/** معرّف عميل الويب (Web client ID) من Google Cloud — ليس سراً. */
export const GOOGLE_WEB_CLIENT_ID: string =
  (import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID as string | undefined)?.trim() || '';

interface FlowPosGoogleAuthPlugin {
  signIn(options: { serverClientId: string; nonce?: string }): Promise<{ idToken: string; email?: string; displayName?: string }>;
  signOut(): Promise<void>;
}

const NativeGoogle = registerPlugin<FlowPosGoogleAuthPlugin>('FlowPosGoogleAuth');

const isElectron = (): boolean =>
  typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent);

export const isNativeAndroid = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

/** هل يظهر الزر على هذه المنصة؟ */
export function isGoogleSignInAvailable(): boolean {
  if (!GOOGLE_SIGN_IN_ENABLED) return false;
  if (isElectron()) return false; // ويندوز: غير مدعوم حالياً
  if (Capacitor.isNativePlatform()) return isNativeAndroid() && GOOGLE_WEB_CLIENT_ID.length > 0;
  return true; // الويب: OAuth عبر المتصفح نفسه
}

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export type NativeGoogleResult =
  | { ok: true; idToken: string; rawNonce: string }
  | { ok: false; code: 'CANCELLED' | 'NO_CREDENTIAL' | 'CONFIG' | 'GOOGLE_ERROR'; message: string };

/** أندرويد: يفتح نافذة حسابات جوجل الأصلية ويعيد idToken (جوجل تستلم الـnonce مُجزّأ، وSupabase تستلمه خاماً). */
export async function getNativeGoogleIdToken(): Promise<NativeGoogleResult> {
  if (!GOOGLE_WEB_CLIENT_ID) return { ok: false, code: 'CONFIG', message: 'missing web client id' };
  const rawNonce = randomNonce();
  try {
    const hashed = await sha256Hex(rawNonce);
    const res = await NativeGoogle.signIn({ serverClientId: GOOGLE_WEB_CLIENT_ID, nonce: hashed });
    if (!res?.idToken) return { ok: false, code: 'GOOGLE_ERROR', message: 'empty token' };
    return { ok: true, idToken: res.idToken, rawNonce };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const code = (['CANCELLED', 'NO_CREDENTIAL', 'CONFIG'].includes(err?.code || '') ? err.code : 'GOOGLE_ERROR') as
      'CANCELLED' | 'NO_CREDENTIAL' | 'CONFIG' | 'GOOGLE_ERROR';
    return { ok: false, code, message: err?.message || String(e) };
  }
}

export const GOOGLE_WEB_RETURN_FLAG = 'google_return';

/** الويب: تحويل لصفحة جوجل ثم العودة لصفحة الدخول لإكمال الفحوص. */
export async function startWebGoogleSignIn(): Promise<{ error: Error | null }> {
  const redirectTo = `${window.location.origin}/login?${GOOGLE_WEB_RETURN_FLAG}=1`;
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, queryParams: { prompt: 'select_account' } },
  });
  return { error: error ? new Error(error.message) : null };
}

export async function nativeGoogleSignOut(): Promise<void> {
  if (!isNativeAndroid()) return;
  try { await NativeGoogle.signOut(); } catch { /* ignore */ }
}

/**
 * يُسمح فقط لحساب موجود مسبقاً (له دور في user_roles) وبدور مسموح.
 * حساب جوجل جديد بلا متجر يُرفض حتى يقرر المالك مسار التسجيل.
 */
export async function checkGoogleAccountAllowed(userId: string): Promise<{ allowed: boolean; reason?: 'no_account' | 'role' }> {
  const { data, error } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return { allowed: false, reason: 'no_account' };
  if (!GOOGLE_ALLOWED_ROLES.includes(String(data.role))) return { allowed: false, reason: 'role' };
  return { allowed: true };
}

export function googleErrorMessage(code: string): string {
  switch (code) {
    case 'CANCELLED': return '';
    case 'NO_CREDENTIAL': return 'لا يوجد حساب جوجل على الجهاز، أضف حساباً من إعدادات الهاتف';
    case 'CONFIG': return 'تسجيل الدخول بجوجل غير مُعدّ في هذه النسخة';
    case 'no_account': return 'هذا الحساب غير مرتبط بمتجر. سجّل الدخول بالبريد وكلمة المرور';
    case 'role': return 'الدخول بجوجل متاح لمالك المتجر فقط. استخدم البريد وكلمة المرور';
    default: return 'تعذّر تسجيل الدخول بجوجل، استخدم البريد وكلمة المرور';
  }
}
