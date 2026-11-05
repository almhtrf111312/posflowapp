/**
 * تطبيع موحد لأرقام الهواتف لمنع التكرار باختلاف الصيغ
 */
export function normalizePhoneNumber(rawPhone?: string | null): string {
  if (!rawPhone) return '';
  // إزالة المسافات والأقواس والرموز غير الرقمية ما عدا +
  let cleaned = rawPhone.trim().replace(/[^\+0-9]/g, '');

  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.substring(2);
  }

  // سوريا: 09XXXXXXXX -> +9639XXXXXXXX
  if (/^09[0-9]{8}$/.test(cleaned)) {
    return '+963' + cleaned.substring(1);
  }

  // تركيا: 05XXXXXXXXX -> +905XXXXXXXXX
  if (/^05[0-9]{9}$/.test(cleaned)) {
    return '+90' + cleaned.substring(1);
  }

  return cleaned;
}

/**
 * فحص صلاحية وتنسيق رقم الهاتف إن وُجد
 */
export function isValidPhoneNumber(phone?: string | null): boolean {
  if (!phone || !phone.trim()) return true;
  const normalized = normalizePhoneNumber(phone);
  return /^\+?[0-9]{7,15}$/.test(normalized);
}
