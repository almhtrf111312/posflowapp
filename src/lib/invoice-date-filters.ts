// Date-range helpers for the invoices list filters.

export const getLocalDateString = (d: Date = new Date()) => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export type DateQuickFilter = 'today' | 'week' | 'month' | 'year' | 'all' | 'custom';

/**
 * فحص مطابقة تاريخ الفاتورة مع تاريخ اليوم بمعالجة فروق التوقيت المحلي وUTC ومنتصف الليل
 */
export function isInvoiceToday(createdAt?: string | null): boolean {
  if (!createdAt) return false;
  try {
    const invDate = new Date(createdAt);
    if (isNaN(invDate.getTime())) return false;
    const now = new Date();

    // 1. مطابقة التاريخ المحلي (نفس اليوم والشهر والسنة في توقيت جهاز المستخدم)
    if (
      invDate.getFullYear() === now.getFullYear() &&
      invDate.getMonth() === now.getMonth() &&
      invDate.getDate() === now.getDate()
    ) {
      return true;
    }

    // 2. مطابقة نص التاريخ المحلي toDateString
    if (invDate.toDateString() === now.toDateString()) {
      return true;
    }

    // 3. مطابقة تاريخ UTC (لتغطية أي فارق توقيت بين خادم Supabase وجهاز المستخدم حول منتصف الليل)
    if (
      invDate.getUTCFullYear() === now.getUTCFullYear() &&
      invDate.getUTCMonth() === now.getUTCMonth() &&
      invDate.getUTCDate() === now.getUTCDate()
    ) {
      return true;
    }

    // 4. مطابقة البادئة النصية (YYYY-MM-DD)
    const localToday = getLocalDateString(now);
    const utcToday = now.toISOString().slice(0, 10);
    if (createdAt.startsWith(localToday) || createdAt.startsWith(utcToday)) {
      return true;
    }
  } catch { /* intentionally empty */ }
  return false;
}

/**
 * فحص مطابقة تاريخ الفاتورة خلال آخر 7 أيام
 */
export function isInvoiceThisWeek(createdAt?: string | null): boolean {
  if (!createdAt) return false;
  try {
    const invDate = new Date(createdAt);
    if (isNaN(invDate.getTime())) return false;
    const now = new Date();
    const diffMs = now.getTime() - invDate.getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    if (diffMs >= -86400000 && diffMs <= sevenDaysMs) {
      return true;
    }
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    weekAgo.setHours(0, 0, 0, 0);
    if (invDate >= weekAgo) {
      return true;
    }
  } catch { /* intentionally empty */ }
  return false;
}

/**
 * فحص مطابقة تاريخ الفاتورة للشهر الحالي
 */
export function isInvoiceThisMonth(createdAt?: string | null): boolean {
  if (!createdAt) return false;
  try {
    const invDate = new Date(createdAt);
    if (isNaN(invDate.getTime())) return false;
    const now = new Date();
    if (invDate.getFullYear() === now.getFullYear() && invDate.getMonth() === now.getMonth()) {
      return true;
    }
    if (invDate.getUTCFullYear() === now.getUTCFullYear() && invDate.getUTCMonth() === now.getUTCMonth()) {
      return true;
    }
  } catch { /* intentionally empty */ }
  return false;
}

/**
 * فحص مطابقة تاريخ الفاتورة للسنة الحالية
 */
export function isInvoiceThisYear(createdAt?: string | null): boolean {
  if (!createdAt) return false;
  try {
    const invDate = new Date(createdAt);
    if (isNaN(invDate.getTime())) return false;
    const now = new Date();
    if (invDate.getFullYear() === now.getFullYear()) {
      return true;
    }
    if (invDate.getUTCFullYear() === now.getUTCFullYear()) {
      return true;
    }
  } catch { /* intentionally empty */ }
  return false;
}

/**
 * فحص مطابقة تاريخ الفاتورة مع تاريخ مخصص محدد
 */
export function isInvoiceCustomDate(createdAt?: string | null, targetDate?: string): boolean {
  if (!createdAt || !targetDate) return true;
  try {
    if (createdAt.startsWith(targetDate)) return true;
    const invDate = new Date(createdAt);
    if (isNaN(invDate.getTime())) return false;
    if (getLocalDateString(invDate) === targetDate) return true;
    if (invDate.toISOString().slice(0, 10) === targetDate) return true;
  } catch { /* intentionally empty */ }
  return false;
}

/**
 * فحص مطابقة تاريخ الفاتورة ضمن نطاق زمني (من تاريخ إلى تاريخ)
 */
export function isInvoiceInRange(createdAt?: string | null, from?: string, to?: string): boolean {
  if (!createdAt) return false;
  if (!from && !to) return true;
  try {
    const invDate = getLocalDateString(new Date(createdAt));
    if (from && invDate < from) return false;
    if (to && invDate > to) return false;
    return true;
  } catch {
    return false;
  }
}
