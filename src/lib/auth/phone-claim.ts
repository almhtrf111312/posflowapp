/**
 * ربط رقم الهاتف بالحساب مع فحص الاستخدام المسبق (نفس دوال الإعدادات الموجودة):
 * - متاح / رقم الحساب نفسه → يُحفظ مباشرة.
 * - مستخدم في حساب آخر لديه تيليجرام → يلزم رمز تأكيد (StorePhoneVerificationDialog).
 * - مستخدم في حساب آخر بدون تيليجرام → مرفوض مع رسالة واضحة.
 */
import { supabase } from '@/integrations/supabase/client';

export type PhoneClaimResult =
  | { kind: 'ok' }
  | { kind: 'needs_telegram' }
  | { kind: 'conflict'; message: string }
  | { kind: 'error'; message: string };

export async function claimAccountPhone(phone: string): Promise<PhoneClaimResult> {
  const rpc = supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: { message: string } | null }>;
  try {
    const { data: check, error } = await rpc('check_store_phone_status', { _phone: phone });
    if (error) return { kind: 'error', message: error.message };
    if (check?.status === 'requires_telegram_verification') return { kind: 'needs_telegram' };
    if (check && check.ok === false) {
      return { kind: 'conflict', message: check.error || 'هذا الرقم مستخدم في حساب آخر. استخدم رقماً آخر أو تواصل مع الدعم.' };
    }
    const { data: res, error: assignErr } = await rpc('assign_store_and_profile_phone', { _phone: phone });
    if (assignErr || res?.ok === false) {
      return { kind: 'error', message: assignErr?.message || res?.error || 'تعذّر حفظ الرقم' };
    }
    return { kind: 'ok' };
  } catch (e) {
    return { kind: 'error', message: String((e as Error)?.message || e) };
  }
}

/** هل حساب المستخدم الحالي مربوط بتيليجرام؟ (null = غير معروف/لا اتصال) */
export async function fetchTelegramLinked(userId: string): Promise<boolean | null> {
  try {
    const { data, error } = await supabase.from('profiles').select('telegram_chat_id').eq('user_id', userId).maybeSingle();
    if (error) return null;
    return !!String((data as { telegram_chat_id?: string | null } | null)?.telegram_chat_id || '').trim();
  } catch {
    return null;
  }
}

const DEFAULT_BOT_LINK = 'https://t.me/flowpos_helper_bot';

export async function getTelegramBotLink(): Promise<string> {
  try {
    const { data } = await supabase.functions.invoke('telegram-auth', { body: { action: 'get_bot_info' } });
    const link = (data as { bot_link?: string } | null)?.bot_link;
    if (link && /^https:\/\/t\.me\//.test(link)) return link;
  } catch { /* ignore */ }
  return DEFAULT_BOT_LINK;
}
