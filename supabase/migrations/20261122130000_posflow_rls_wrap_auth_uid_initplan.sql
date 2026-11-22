-- =============================================================================
-- Migration: 20261122130000_posflow_rls_wrap_auth_uid_initplan.sql
-- Already applied to the live project as posflow_rls_wrap_auth_uid_initplan.
-- Rollback: supabase/live-snapshots/rollbacks/ROLLBACK_rls_wrap_auth_uid_initplan.sql
--
-- Supabase linter 0003 (auth_rls_initplan): a bare auth.uid() in a policy is re-evaluated
-- for every row. Wrapping it as (SELECT auth.uid()) makes Postgres evaluate it once per
-- query (initplan). The meaning of each policy is unchanged.
-- Applied to 108 policies in schema public. Verified afterwards: 0 unwrapped left,
-- cross-store invoice insert still blocked, own-store insert allowed, other stores' rows
-- not visible.
-- =============================================================================

DO $$
DECLARE
  r record;
  _q text; _w text; _sql text;
  _wrapped constant text := '( SELECT auth.uid() AS uid)';
  _new constant text := '(SELECT auth.uid() AS uid)';
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (coalesce(qual,'') LIKE '%auth.uid()%' OR coalesce(with_check,'') LIKE '%auth.uid()%')
  LOOP
    _q := r.qual; _w := r.with_check;
    IF _q IS NOT NULL THEN
      _q := replace(_q, _wrapped, '@@W@@'); _q := replace(_q, 'auth.uid()', _new); _q := replace(_q, '@@W@@', _wrapped);
    END IF;
    IF _w IS NOT NULL THEN
      _w := replace(_w, _wrapped, '@@W@@'); _w := replace(_w, 'auth.uid()', _new); _w := replace(_w, '@@W@@', _wrapped);
    END IF;
    IF _q IS NOT DISTINCT FROM r.qual AND _w IS NOT DISTINCT FROM r.with_check THEN CONTINUE; END IF;
    _sql := format('ALTER POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    IF _q IS NOT NULL THEN _sql := _sql || ' USING (' || _q || ')'; END IF;
    IF _w IS NOT NULL THEN _sql := _sql || ' WITH CHECK (' || _w || ')'; END IF;
    EXECUTE _sql;
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';
