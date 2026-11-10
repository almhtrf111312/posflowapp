-- =========================================================================
-- المرحلة الرابعة / التحسينات الجوهرية:
-- 1. حماية مفتاح تليجرام الخاص بالمدير العام من قراءة الكاشيرات والمستخدمين
-- 2. دالة آمنة SECURITY DEFINER لجلب إعدادات بوت التنبيه لإرسال الإشعار
-- =========================================================================

-- 1. سياسة RLS لحماية مفتاح telegram_boss_alert_config في جدول app_settings
DROP POLICY IF EXISTS "Boss only read telegram config" ON public.app_settings;
CREATE POLICY "Boss only read telegram config" 
ON public.app_settings 
FOR SELECT 
TO authenticated 
USING (
  key != 'telegram_boss_alert_config' 
  OR public.is_boss(auth.uid())
);

-- 2. دالة آمنة لجلب إعدادات التنبيه عبر السيرفر بدون كشف الجدول للمستخدمين
CREATE OR REPLACE FUNCTION public.get_boss_telegram_alert_config()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_val text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT value INTO v_val 
  FROM public.app_settings 
  WHERE key = 'telegram_boss_alert_config';

  IF v_val IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN v_val::jsonb;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_boss_telegram_alert_config() TO authenticated;
