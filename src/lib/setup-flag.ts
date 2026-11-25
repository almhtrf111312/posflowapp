/**
 * علم اكتمال معالج الإعداد — مرتبط بمعرّف المستخدم حتى لا يتسرّب من حساب لآخر على نفس الجهاز.
 * المفتاح العام القديم `posflow_setup_complete` يبقى يُكتب للتوافق مع الشاشات القديمة،
 * لكنه يُمسح عند تسجيل الخروج/تبديل المستخدم، فلا يصلح كمرجع بين الحسابات.
 */
const LEGACY_KEY = 'posflow_setup_complete';
const DEFAULT_STORE_NAMES = ['PosFlow Store', 'متجر فلو التجريبي'];

export const setupFlagKey = (uid: string) => `${LEGACY_KEY}_${uid}`;

/** هل في الجهاز إعدادات متجر حقيقية (اسم غير افتراضي)؟ */
export function hasRealConfiguredStore(): boolean {
  try {
    const raw = localStorage.getItem('posflow_settings_v1');
    if (!raw) return false;
    const name = String(JSON.parse(raw)?.storeSettings?.name || '').trim();
    return name.length > 0 && !DEFAULT_STORE_NAMES.includes(name);
  } catch {
    return false;
  }
}

/** قراءة حالة الاكتمال للمستخدم الحالي (أو بدون مستخدم: اعتماداً على إعدادات المتجر فقط). */
export function isSetupCompleteFor(uid?: string | null): boolean {
  try {
    if (uid) {
      const flag = localStorage.getItem(setupFlagKey(uid));
      if (flag === 'true') return true;
      if (flag === 'false') return false;
    }
    return hasRealConfiguredStore();
  } catch {
    return false;
  }
}

/** تعليم الإعداد كمكتمل للمستخدم (ويكتب المفتاح العام للتوافق). */
export function markSetupComplete(uid?: string | null): void {
  try {
    if (uid) localStorage.setItem(setupFlagKey(uid), 'true');
    localStorage.setItem(LEGACY_KEY, 'true');
  } catch { /* ignore */ }
}

/** هل صف المتجر السحابي مهيّأً فعلاً؟ (نوع نشاط غير general، أو اسم غير افتراضي) */
export function isConfiguredStoreRow(row: { name?: string | null; store_type?: string | null } | null | undefined): boolean {
  if (!row) return false;
  const type = String(row.store_type || '').trim();
  const name = String(row.name || '').trim();
  return (type.length > 0 && type !== 'general') || (name.length > 0 && !DEFAULT_STORE_NAMES.includes(name));
}

/** Google-only identity (no email/password identity). */
export function isGoogleOnlyIdentities(identities?: ReadonlyArray<{ provider?: string | null }> | null): boolean {
  return !!identities && identities.length > 0 && !identities.some((i) => i?.provider === 'email');
}

/**
 * A Google sign-in is a NEW account (phone + setup wizard) only when it is Google-only AND its cloud store is not
 * configured yet. A default role is created for every Google signup, so the role alone cannot tell them apart.
 */
export function isNewGoogleAccount(
  identities: ReadonlyArray<{ provider?: string | null }> | null | undefined,
  storeConfigured: boolean
): boolean {
  return isGoogleOnlyIdentities(identities) && !storeConfigured;
}
