-- get_boss_telegram_alert_config()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.get_boss_telegram_alert_config()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_val text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  SELECT value INTO v_val FROM public.app_settings WHERE key = 'telegram_boss_alert_config';
  IF v_val IS NULL THEN RETURN NULL; END IF;
  RETURN v_val::jsonb;
END; $function$
;
