-- رجوع عن 20261112040000_security_round2.sql: يعيد assert_period_open و activate_code_strict الأصليتين
-- (سياسات app_settings المحذوفة لا تُعاد: كانت تكشف كل الإعدادات)
BEGIN;
DO $$
DECLARE f text; r record;
BEGIN
  FOREACH f IN ARRAY ARRAY['assert_period_open','activate_code_strict'] LOOP
    FOR r IN SELECT pg_get_function_identity_arguments(p.oid) AS args
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = f || '__impl'
    LOOP
      EXECUTE format('DROP FUNCTION IF EXISTS public.%I(%s)', f, r.args);
      EXECUTE format('ALTER FUNCTION public.%I(%s) RENAME TO %I', f || '__impl', r.args, f);
      IF f = 'assert_period_open' THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated, service_role', f, r.args);
      ELSE
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', f, r.args);
      END IF;
    END LOOP;
  END LOOP;
END $$;
COMMIT;
