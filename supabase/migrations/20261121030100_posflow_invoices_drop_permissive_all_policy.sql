-- =============================================================================
-- Migration: 20261121030100_posflow_invoices_drop_permissive_all_policy.sql
-- Rollback:  supabase/live-snapshots/rollbacks/ROLLBACK_invoices_all_policy.sql
--
-- Audit finding: the PERMISSIVE `Store isolation invoices` policy (FOR ALL,
-- user_id = get_owner_id(auth.uid())) is OR-ed with the license-checked SELECT
-- policy, so users with an expired or revoked license could still read, update
-- and hard-DELETE invoices through the REST API.
--
-- After this migration:
--   SELECT  -> "Licensed users read own invoices" (license checked)
--   INSERT  -> "Users insert own invoices" + "Enforce device license on invoice insert"
--   UPDATE  -> "Users update own invoices"
--   DELETE  -> no policy, so direct client DELETE is denied
-- No client code deletes invoices; SECURITY DEFINER RPCs are unaffected.
-- Idempotent.
-- =============================================================================

DROP POLICY IF EXISTS "Store isolation invoices" ON public.invoices;

NOTIFY pgrst, 'reload schema';
