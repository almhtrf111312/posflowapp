-- رجوع عن 20261112030000_security_cross_store_lookups.sql: يعيد الدوال الأصلية بأسمائها وصلاحياتها السابقة
BEGIN;
DO $$
DECLARE
  f text;
  r record;
BEGIN
  FOREACH f IN ARRAY ARRAY['check_product_addition_limit','can_add_cashier','count_owner_cashiers','can_refund_invoices'] LOOP
    FOR r IN SELECT p.oid, pg_get_function_identity_arguments(p.oid) AS args
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = f || '__impl'
    LOOP
      EXECUTE format('DROP FUNCTION IF EXISTS public.%I(%s)', f, r.args);
      EXECUTE format('ALTER FUNCTION public.%I(%s) RENAME TO %I', f || '__impl', r.args, f);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated, service_role', f, r.args);
    END LOOP;
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname IN ('activate_code_strict','check_phone_email_availability','check_store_phone_status')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', r.sig);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS public.caller_can_query_account(uuid);
COMMIT;
