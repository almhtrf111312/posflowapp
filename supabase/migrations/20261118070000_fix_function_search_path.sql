-- Pin search_path on three helper functions (Supabase linter 0011).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS f
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('prevent_customer_deletion_with_dues','trigger_normalize_profile_phone','normalize_phone_number')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', r.f);
  END LOOP;
END $$;
