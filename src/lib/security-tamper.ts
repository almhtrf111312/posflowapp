import { supabase } from '@/integrations/supabase/client';

export type TamperType = 'clock_skew' | 'offline_limit_exceeded' | 'license_tamper' | 'pin_bruteforce';

/**
 * تسجيل واقعة أمنية في السحابة فور عودة الاتصال
 */
export async function reportSecurityTamper(
  tamperType: TamperType,
  deviceId: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();

    await (supabase.from('security_tamper_logs') as unknown as { insert: (row: Record<string, unknown>) => Promise<unknown> }).insert({
      user_id: user?.id || null,
      device_id: deviceId,
      tamper_type: tamperType,
      client_timestamp: new Date().toISOString(),
      metadata: metadata || {},
    });
  } catch (err) {
    console.warn('[Security] Failed to upload tamper log:', err);
  }
}
