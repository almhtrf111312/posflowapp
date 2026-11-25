/**
 * تسجيل الدخول بجوجل — وحدة مستقلة وقابلة للإزالة بالكامل.
 *
 * للإيقاف السريع: اجعل GOOGLE_SIGN_IN_ENABLED = false (الزر يختفي فوراً).
 * للإزالة الكاملة: احذف هذا الملف + GoogleSignInButton.tsx + سطرين في Login.tsx
 * + PosFlowGoogleAuthPlugin.java وسطر تسجيله في MainActivity + تبعيات googleid في android/app/build.gradle
 * + كتلة "Google sign-in" في electron/main.js و protocols في electron/package.json.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { supabase } from '@/integrations/supabase/client';
import { isConfiguredStoreRow } from '../setup-flag';

/** مفتاح التشغيل الرئيسي */
export const GOOGLE_SIGN_IN_ENABLED = true;

/** من يُسمح له بالدخول بجوجل (القرار عند المالك؛ الافتراضي: المالك والبوس فقط) */
export const GOOGLE_ALLOWED_ROLES: ReadonlyArray<string> = ['admin', 'boss'];

/** معرّف عميل الويب (Web client ID) من Google Cloud — ليس سراً. */
export const GOOGLE_WEB_CLIENT_ID: string =
  (import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID as string | undefined)?.trim() || '';

interface PosFlowGoogleAuthPlugin {
  signIn(options: { serverClientId: string; nonce?: string }): Promise<{ idToken: string; email?: string; displayName?: string }>;
  signOut(): Promise<void>;
}

const NativeGoogle = registerPlugin<PosFlowGoogleAuthPlugin>('PosFlowGoogleAuth');

export const isElectron = (): boolean =>
  typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent);

interface DesktopGoogleBridge {
  available: boolean;
  signIn(nonceHashed: string): Promise<{ ok: true; idToken: string } | { ok: false; code: string; message: string }>;
}
const desktopBridge = (): DesktopGoogleBridge | null =>
  typeof window !== 'undefined' ? ((window as unknown as { posflowGoogle?: DesktopGoogleBridge }).posflowGoogle ?? null) : null;

export const isNativeAndroid = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

/** هل يظهر الزر على هذه المنصة؟ */
export function isGoogleSignInAvailable(): boolean {
  if (!GOOGLE_SIGN_IN_ENABLED) return false;
  if (isElectron()) return !!desktopBridge()?.available; // ويندوز: يظهر فقط إذا ضُبط عميل Desktop في البناء
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

/** هل لهذا الحساب متجر مهيّأ في السحابة؟ أي فشل = غير مهيّأ (يبقى سلوك الحساب الجديد). */
async function hasConfiguredCloudStore(userId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('stores')
      .select('name, store_type')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    return isConfiguredStoreRow(data as { name?: string | null; store_type?: string | null } | null);
  } catch {
    return false;
  }
}


/**
 * يُسمح فقط لحساب موجود مسبقاً (له دور في user_roles) وبدور مسموح.
 * حساب جوجل جديد بلا متجر يُرفض حتى يقرر المالك مسار التسجيل.
 */
export async function checkGoogleAccountAllowed(
  userId: string,
  identities?: ReadonlyArray<{ provider?: string | null }> | null,
): Promise<{ allowed: boolean; reason?: 'no_account' | 'role' | 'new_account' }> {
  // حساب جوجل جديد (هوية جوجل فقط): يُعامل كتسجيل حساب جديد → إدخال الهاتف ثم معالج الإعداد.
  // استثناء: إن كان متجر الحساب مهيّأً في السحابة فهو حساب قديم، فلا يُعاد المعالج عند كل دخول (ولا تُستبدل إعداداته).
  // (وجود الدور وحده لا يكفي: يُنشأ دور افتراضي تلقائياً لكل حساب جوجل جديد.)
  if (identities && identities.length > 0 && !identities.some((i) => i?.provider === 'email')) {
    if (!(await hasConfiguredCloudStore(userId))) {
      return { allowed: false, reason: 'new_account' };
    }
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

/** الكمبيوتر: المتصفح الخارجي + عنوان رجوع محلي (127.0.0.1) — بدون أي دومين وسيط. */
export async function getDesktopGoogleIdToken(): Promise<NativeGoogleResult> {
  const bridge = desktopBridge();
  if (!bridge?.available) return { ok: false, code: 'CONFIG', message: 'desktop google not configured' };
  const rawNonce = randomNonce();
  try {
    const hashed = await sha256Hex(rawNonce);
    const res = await bridge.signIn(hashed);
    if (res.ok === false) {
      const code = (['CANCELLED', 'CONFIG'].includes(res.code) ? res.code : 'GOOGLE_ERROR') as 'CANCELLED' | 'CONFIG' | 'GOOGLE_ERROR';
      return { ok: false, code, message: res.message };
    }
    return { ok: true, idToken: res.idToken, rawNonce };
  } catch (e) {
    return { ok: false, code: 'GOOGLE_ERROR', message: String((e as Error)?.message || e) };
  }
}

/** نفس قاعدة صفحة التسجيل: أرقام فقط (9–15) مع + اختيارية */
export function isValidSignupPhone(phone: string): boolean {
  const cleaned = phone.trim();
  if (!/^\+?\d+$/.test(cleaned)) return false;
  const digits = cleaned.replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 15;
}

/** إكمال حساب جوجل الجديد: حفظ الهاتف (والاسم) كما في التسجيل بالبريد */
export async function completeGoogleSignup(userId: string, phone: string, fullName: string): Promise<{ error: Error | null }> {
  const cleanPhone = phone.trim();
  const name = fullName.trim().slice(0, 100);
  const { error: metaError } = await supabase.auth.updateUser({ data: { phone: cleanPhone, ...(name ? { full_name: name } : {}) } });
  if (metaError) return { error: new Error(metaError.message) };
  await supabase
    .from('profiles')
    .update({ phone: cleanPhone, ...(name ? { full_name: name } : {}) } as never)
    .eq('user_id', userId);
  return { error: null };
}

/** هل الحساب جوجل فقط (لا هوية بريد/كلمة مرور)؟ */
export function isGoogleOnlyUser(user: {
  identities?: ReadonlyArray<{ provider?: string | null }> | null;
  app_metadata?: { providers?: unknown } | null;
} | null | undefined): boolean {
  if (!user) return false;
  const fromIdentities = (user.identities || []).map((i) => i?.provider).filter(Boolean) as string[];
  const rawProviders = user.app_metadata?.providers;
  const fromMeta = Array.isArray(rawProviders) ? (rawProviders as unknown[]).filter((p): p is string => typeof p === 'string') : [];
  const providers = fromIdentities.length > 0 ? fromIdentities : fromMeta;
  return providers.length > 0 && !providers.includes('email');
}
