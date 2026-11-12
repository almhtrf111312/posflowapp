-- رجوع عن 20261112020000_security_app_settings_and_boss_functions.sql (يعيد الوضع السابق المفتوح)
BEGIN;
DROP POLICY IF EXISTS "Public contact settings are readable" ON public.app_settings;
DROP POLICY IF EXISTS "Authenticated read release config" ON public.app_settings;
DROP POLICY IF EXISTS "Boss can read all app settings" ON public.app_settings;
DROP POLICY IF EXISTS "Authenticated users can read app settings" ON public.app_settings;
CREATE POLICY "Authenticated users can read app settings"
  ON public.app_settings FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.get_boss_telegram_alert_config()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_val text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  SELECT value INTO v_val FROM public.app_settings WHERE key = 'telegram_boss_alert_config';
  IF v_val IS NULL THEN RETURN NULL; END IF;
  RETURN v_val::jsonb;
END; $$;
GRANT EXECUTE ON FUNCTION public.get_boss_telegram_alert_config() TO authenticated;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('boss_direct_activate_by_plan','approve_subscription_request_atomic',
      'boss_set_single_device','boss_activate_license','boss_change_user_password','boss_hard_delete_user',
      'boss_revoke_user_license','boss_reactivate_user_license','clean_old_error_logs')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', r.sig);
  END LOOP;
END $$;
COMMIT;
