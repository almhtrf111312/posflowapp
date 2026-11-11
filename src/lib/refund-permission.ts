// صلاحية الاسترداد للكاشير: يمنحها مالك المتجر لكل كاشير (user_roles.can_refund).
// الخادم هو المرجع (دالتا المرتجع ترفضان من لا يملك الصلاحية)، وهذا الملف يضبط الواجهة فقط.
import { supabase } from '@/integrations/supabase/client';

const CACHE_KEY = 'hp_can_refund';

// العمود can_refund يُضاف بـ migration المرحلة 1 وغير موجود في الأنواع المولّدة بعد
const db = supabase as unknown as { from: (table: string) => any };

function readCache(userId: string): boolean | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { userId?: string; allowed?: boolean };
    return parsed.userId === userId && typeof parsed.allowed === 'boolean' ? parsed.allowed : null;
  } catch {
    return null;
  }
}

function writeCache(userId: string, allowed: boolean): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ userId, allowed }));
  } catch {
    /* noop */
  }
}

/**
 * هل منح المالكُ الكاشيرَ الحالي صلاحية الاسترداد؟
 * عند تعذّر السؤال (بلا إنترنت أو العمود غير موجود بعد) يُستخدم آخر جواب محفوظ، وإن لم يوجد فالجواب "لا".
 */
export async function getOwnRefundPermission(): Promise<boolean> {
  let userId: string | null = null;
  try {
    const { data } = await supabase.auth.getSession();
    userId = data.session?.user?.id ?? null;
  } catch {
    userId = null;
  }
  if (!userId) return false;

  try {
    const { data, error } = await db
      .from('user_roles')
      .select('can_refund')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) return readCache(userId) ?? false;
    const allowed = data.can_refund === true;
    writeCache(userId, allowed);
    return allowed;
  } catch {
    return readCache(userId) ?? false;
  }
}
