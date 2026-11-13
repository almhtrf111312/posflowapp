/**
 * تسجيل الدخول بجوجل — وحدة مستقلة وقابلة للإزالة بالكامل.
 *
 * للإيقاف السريع: اجعل GOOGLE_SIGN_IN_ENABLED = false (الزر يختفي فوراً).
 * للإزالة الكاملة: احذف هذا الملف + GoogleSignInButton.tsx + سطرين في Login.tsx
 * + FlowPosGoogleAuthPlugin.java وسطر تسجيله في MainActivity + تبعيات googleid في android/app/build.gradle
 * + كتلة "Google sign-in" في electron/main.js و protocols في electron/package.json.
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

export const isElectron = (): boolean =>
  typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent);

export const isNativeAndroid = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

/** هل يظهر الزر على هذه المنصة؟ */
export function isGoogleSignInAvailable(): boolean {
  if (!GOOGLE_SIGN_IN_ENABLED) return false;
  if (isElectron()) return true; // ويندوز: المتصفح الخارجي ثم العودة عبر flowpos://
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
export async function checkGoogleAccountAllowed(
  userId: string,
  identities?: ReadonlyArray<{ provider?: string | null }> | null,
): Promise<{ allowed: boolean; reason?: 'no_account' | 'role' }> {
  // حساب جوجل جديد يُنشأ تلقائياً مع دور افتراضي (trigger)، لذلك وجود الدور لا يكفي:
  // الحساب الموجود فعلاً له هوية بريد/كلمة مرور، وجوجل تُربط به لاحقاً.
  if (identities && identities.length > 0 && !identities.some((i) => i?.provider === 'email')) {
    return { allowed: false, reason: 'no_account' };
  }
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

export const DESKTOP_REDIRECT_URL = 'flowpos://auth-callback';

/** الكمبيوتر: يفتح صفحة جوجل في المتصفح الافتراضي (جوجل تمنع الدخول داخل نافذة التطبيق). */
export async function startDesktopGoogleSignIn(): Promise<{ error: Error | null }> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: DESKTOP_REDIRECT_URL, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } },
  });
  if (error || !data?.url) return { error: new Error(error?.message || 'no auth url') };
  window.open(data.url, '_blank'); // Electron يحوّلها للمتصفح الخارجي
  return { error: null };
}

export type DesktopCallback =
  | { ok: true; accessToken: string; refreshToken: string }
  | { ok: false; message: string };

/** يقرأ الرموز من رابط العودة (#access_token=...&refresh_token=...) */
export function parseDesktopCallback(rawUrl: string): DesktopCallback {
  if (!rawUrl || !rawUrl.startsWith(DESKTOP_REDIRECT_URL)) return { ok: false, message: 'invalid callback' };
  const hashIndex = rawUrl.indexOf('#');
  const queryIndex = rawUrl.indexOf('?');
  const params = new URLSearchParams();
  if (queryIndex >= 0) new URLSearchParams(rawUrl.slice(queryIndex + 1, hashIndex >= 0 && hashIndex > queryIndex ? hashIndex : undefined)).forEach((v, k) => params.set(k, v));
  if (hashIndex >= 0) new URLSearchParams(rawUrl.slice(hashIndex + 1)).forEach((v, k) => params.set(k, v));
  const err = params.get('error_description') || params.get('error');
  if (err) return { ok: false, message: err };
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return { ok: false, message: params.get('code') ? 'unexpected code flow' : 'missing tokens' };
  return { ok: true, accessToken, refreshToken };
}
