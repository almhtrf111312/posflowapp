-- Rollback for 20261122130000_posflow_rls_wrap_auth_uid_initplan.sql
-- Unwraps (SELECT auth.uid() AS uid) back to a bare auth.uid() in every public policy.
-- Same semantics, only slower at scale (re-evaluated per row).
DO $$
DECLARE
  r record;
  _q text; _w text; _sql text;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (coalesce(qual,'') LIKE '%SELECT auth.uid() AS uid%' OR coalesce(with_check,'') LIKE '%SELECT auth.uid() AS uid%')
  LOOP
    _q := r.qual; _w := r.with_check;
    IF _q IS NOT NULL THEN
      _q := replace(replace(_q, '( SELECT auth.uid() AS uid)', 'auth.uid()'), '(SELECT auth.uid() AS uid)', 'auth.uid()');
    END IF;
    IF _w IS NOT NULL THEN
      _w := replace(replace(_w, '( SELECT auth.uid() AS uid)', 'auth.uid()'), '(SELECT auth.uid() AS uid)', 'auth.uid()');
    END IF;
    _sql := format('ALTER POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    IF _q IS NOT NULL THEN _sql := _sql || ' USING (' || _q || ')'; END IF;
    IF _w IS NOT NULL THEN _sql := _sql || ' WITH CHECK (' || _w || ')'; END IF;
    EXECUTE _sql;
  END LOOP;
END
$$;
NOTIFY pgrst, 'reload schema';
