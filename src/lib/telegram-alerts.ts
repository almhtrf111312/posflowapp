import { supabase } from '@/integrations/supabase/client';

/**
 * دالة تعقيم النصوص لتفادي خطأ 400 Bad Request في تليجرام
 */
function escapeHtml(str: string = ''): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * إرسال إشعار احتياطي فوري لبوت تليجرام الخاص بالمدير العام
 */
export async function sendBossTelegramChatAlert(
  clientName: string,
  clientPhone: string,
  messageText: string,
  refCode?: string
): Promise<void> {
  try {
    let config: { bot_token?: string; chat_id?: string } | null = null;

    // 1. محاولة جلب إعدادات توكن البوت ومعرف الشات من app_settings
    const { data: settingsData } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'telegram_boss_alert_config')
      .maybeSingle();

    if (settingsData?.value) {
      config = typeof settingsData.value === 'string' ? JSON.parse(settingsData.value) : settingsData.value;
    } else {
      // 2. إذا حظرت سياسة RLS القراءة المباشرة للعميل، نجلبها عبر الدالة السحابية الآمنة SECURITY DEFINER
      try {
        const { data: rpcConfig } = await supabase.rpc('get_boss_telegram_alert_config');
        if (rpcConfig) {
          config = typeof rpcConfig === 'string' ? JSON.parse(rpcConfig) : rpcConfig;
        }
      } catch {
        // RPC might not exist yet if migration pending
      }
    }

    if (!config || !config.bot_token || !config.chat_id) return;

    const { bot_token, chat_id } = config;

    const text = [
      '🔔 <b>رسالة جديدة من عميل في PosFlow</b>',
      `👤 <b>العميل:</b> ${escapeHtml(clientName || 'غير مسجل')}`,
      `📱 <b>الهاتف:</b> <code>${escapeHtml(clientPhone || 'غير متوفر')}</code>`,
      refCode ? `🎫 <b>مرجع الطلب:</b> <code>${escapeHtml(refCode)}</code>` : '',
      `💬 <b>الرسالة:</b> ${escapeHtml(messageText)}`,
      `⏰ <b>الوقت:</b> ${new Date().toLocaleTimeString('ar-SY')}`,
    ].filter(Boolean).join('\n');

    await fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id,
        text,
        parse_mode: 'HTML',
      }),
    });
  } catch (err) {
    console.warn('Telegram alert skipped:', err);
  }
}
