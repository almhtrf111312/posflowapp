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
