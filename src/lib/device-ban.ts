/**
 * حظر الجهاز: يُفحص رقم الجهاز (Hardware ID) مع السيرفر قبل تسجيل الدخول وبعده.
 * - الأوفلاين: يُعتمد آخر حكم محفوظ محلياً حتى لا يتخطى المحظور الحظر بقطع الإنترنت.
 * - حكم السيرفر "غير محظور" يمسح العلامة المحلية (رفع الحظر).
 */
import { supabase } from '@/integrations/supabase/client';
import { getDeviceId, getStableDeviceId } from '@/lib/device-fingerprint';

const BAN_FLAG_KEY = 'hp_device_banned';

export const isDeviceBannedLocally = (): boolean => {
  try {
    return localStorage.getItem(BAN_FLAG_KEY) === '1';
  } catch {
    return false;
  }
};

/** يرجع true=محظور، false=غير محظور، null=تعذّر الفحص (يُعتمد الحكم المحلي). */
export async function checkDeviceBanned(): Promise<boolean | null> {
  try {
    // الترخيص قد يكون مربوطاً بالمعرّف الثابت أو بمعرّف قديم لنفس الجهاز: نفحص كلها
    const ids = new Set<string>();
    try { const v = await getStableDeviceId(); if (v) ids.add(v); } catch { /* noop */ }
    try { const v = await getDeviceId(); if (v) ids.add(v); } catch { /* noop */ }
    try { const { getDeviceKey } = await import('@/lib/secure-storage'); const v = getDeviceKey(); if (v) ids.add(v); } catch { /* noop */ }
    if (ids.size === 0) return null;
    const client = supabase as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
    };
    let banned = false;
    for (const id of ids) {
      const { data, error } = await client.rpc('is_device_banned', { p_device_id: id });
      if (error) return null;
      if (data === true) { banned = true; break; }
    }
    try {
      if (banned) localStorage.setItem(BAN_FLAG_KEY, '1');
      else localStorage.removeItem(BAN_FLAG_KEY);
    } catch { /* noop */ }
    return banned;
  } catch {
    return null;
  }
}
