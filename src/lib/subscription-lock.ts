// حالة وضع التجربة المحلي (Local-only): لا رفع إلى السحابة قبل الاشتراك.
// تُكتب من use-license عند تغيّر الترخيص، وتُقرأ بشكل متزامن من طبقات البيانات.

export const SUBSCRIPTION_REQUIRED_MESSAGE = 'هذا القسم يحتاج تفعيل اشتراك';
export const LOCAL_MODE_EVENT = 'hp-local-mode-changed';

const LOCAL_ONLY_KEY = 'hp_local_only_mode';

export function isLocalOnlyMode(): boolean {
  try {
    return localStorage.getItem(LOCAL_ONLY_KEY) === '1';
  } catch {
    return false;
  }
}

// حاجز الكتابة السحابية: يحجب الطابور عن الإرسال للحسابات غير المدفوعة.
// الحجب الحقيقي على السيرفر (trigger a_paid_write_gate)، وهذا الحاجز يمنع إرسال عمليات مرفوضة سلفاً
// ويُبقيها في الطابور دون احتساب أي محاولة فاشلة.
const CLOUD_WRITE_BLOCKED_KEY = 'hp_cloud_write_blocked';

export function isCloudWriteBlocked(): boolean {
  try {
    return localStorage.getItem(CLOUD_WRITE_BLOCKED_KEY) === '1';
  } catch {
    return false;
  }
}

export const CLOUD_WRITE_EVENT = 'hp-cloud-write-changed';
export const SYNC_PENDING_SUBSCRIPTION_MESSAGE = 'المزامنة معلّقة حتى الاشتراك';
export const SYNC_PENDING_SUBSCRIPTION_SHORT = 'معلّقة حتى الاشتراك';

// الرفع للسحابة متوقف لأن الحساب غير مشترك: العناصر محفوظة محلياً وتُرفع بعد التفعيل
export function isSyncPendingSubscription(): boolean {
  return isCloudWriteBlocked() || isLocalOnlyMode();
}

export function setCloudWriteBlocked(blocked: boolean): void {
  try {
    const previous = isCloudWriteBlocked();
    localStorage.setItem(CLOUD_WRITE_BLOCKED_KEY, blocked ? '1' : '0');
    if (previous !== blocked) window.dispatchEvent(new Event(CLOUD_WRITE_EVENT));
  } catch {
    /* التخزين غير متاح: نتجاهل */
  }
}

export function setLocalOnlyMode(enabled: boolean): void {
  try {
    const previous = isLocalOnlyMode();
    if (previous === enabled) return;
    localStorage.setItem(LOCAL_ONLY_KEY, enabled ? '1' : '0');
    window.dispatchEvent(new Event(LOCAL_MODE_EVENT));
  } catch {
    /* التخزين غير متاح: نتجاهل */
  }
}
