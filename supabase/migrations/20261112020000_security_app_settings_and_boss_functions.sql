-- =========================================================================
-- FlowPOS Pro — إغلاق تسريب app_settings وتوكن التيليجرام + منع الزوار من دوال البوس
-- آمن لإعادة التشغيل. لا يحذف بيانات ولا يغيّر أي منطق مالي.
-- انسخ الملف كاملاً وشغّله مرة واحدة. آخر استعلام يعرض نتيجة التحقق (كل الأعمدة true).
-- الرجوع: supabase/live-snapshots/2026-11-12/ROLLBACK_security_app_settings.sql
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- 1. app_settings: لا يقرأ العميل إلا المفاتيح التي يحتاجها التطبيق فعلاً
--    (روابط التواصل، رقم المطور، إعدادات الإصدار). الباقي للبوس فقط.
-- -------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can read app settings" ON public.app_settings;

DROP POLICY IF EXISTS "Public contact settings are readable" ON public.app_settings;
CREATE POLICY "Public contact settings are readable"
  ON public.app_settings FOR SELECT
  TO anon, authenticated
  USING (key = ANY (ARRAY['developer_phone'::text, 'contact_links'::text]));

DROP POLICY IF EXISTS "Authenticated read release config" ON public.app_settings;
CREATE POLICY "Authenticated read release config"
  ON public.app_settings FOR SELECT
  TO authenticated
  USING (key = 'release_config'::text);

DROP POLICY IF EXISTS "Boss can read all app settings" ON public.app_settings;
CREATE POLICY "Boss can read all app settings"
  ON public.app_settings FOR SELECT
  TO authenticated
  USING (public.is_boss(auth.uid()));

-- -------------------------------------------------------------------------
-- 2. توكن بوت التيليجرام: كانت الدالة تعيده لأي مستخدم مسجّل دخول.
--    الآن للبوس فقط. (إشعار طلب التجديد داخل التطبيق يصل للبوس عبر trigger في الخادم.)
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_boss_telegram_alert_config()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_val text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_boss(auth.uid()) THEN
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

REVOKE ALL ON FUNCTION public.get_boss_telegram_alert_config() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_boss_telegram_alert_config() TO authenticated, service_role;

-- -------------------------------------------------------------------------
-- 3. دوال البوس: لا ينفذها زائر بلا تسجيل دخول.
--    تُطبَّق على كل نسخ الدالة الموجودة أياً كانت معاملاتها (لا يفشل إن اختلف التوقيع أو غابت الدالة).
--    وتُمنح صراحة للمستخدمين المسجلين حتى لا يتوقف البوس (كل دالة تتحقق من البوس داخلياً).
-- -------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'boss_direct_activate_by_plan',
        'approve_subscription_request_atomic',
        'boss_set_single_device',
        'boss_activate_license',
        'boss_change_user_password',
        'boss_hard_delete_user',
        'boss_revoke_user_license',
        'boss_reactivate_user_license',
        'clean_old_error_logs'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END $$;

-- مسار بحث ثابت لدالة تنظيف السجلات (حماية من تبديل مسار البحث) دون تغيير محتواها
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'clean_old_error_logs'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', r.sig);
  END LOOP;
END $$;

COMMIT;

-- -------------------------------------------------------------------------
-- التحقق (قراءة فقط): كل الأعمدة يجب أن تكون true
-- -------------------------------------------------------------------------
SELECT
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'app_settings'
              AND policyname = 'Authenticated users can read app settings')              AS open_policy_removed,
  EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'app_settings'
          AND policyname = 'Public contact settings are readable')                        AS contact_policy_ok,
  EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'app_settings'
          AND policyname = 'Authenticated read release config')                           AS release_policy_ok,
  EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'app_settings'
          AND policyname = 'Boss can read all app settings')                              AS boss_policy_ok,
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'app_settings'
              AND cmd IN ('SELECT', 'ALL') AND qual IN ('true', '(true)'))                 AS no_other_open_read,
  position('is_boss' in pg_get_functiondef('public.get_boss_telegram_alert_config()'::regprocedure)) > 0
                                                                                          AS telegram_token_boss_only,
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('boss_direct_activate_by_plan','approve_subscription_request_atomic','boss_set_single_device',
                        'boss_activate_license','boss_change_user_password','boss_hard_delete_user',
                        'boss_revoke_user_license','boss_reactivate_user_license','clean_old_error_logs',
                        'get_boss_telegram_alert_config')
      AND has_function_privilege('anon', p.oid, 'execute'))                               AS anon_blocked,
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('boss_activate_license','boss_change_user_password','boss_hard_delete_user',
                        'boss_revoke_user_license','boss_reactivate_user_license')
      AND NOT has_function_privilege('authenticated', p.oid, 'execute'))                  AS boss_still_works;
