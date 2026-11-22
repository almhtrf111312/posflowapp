-- Rollback for 20261122120000_posflow_invoices_restrictive_license_and_warranty.sql
-- Restores the previous PERMISSIVE form of the license policy. This re-opens the
-- cross-store INSERT hole, so use it only to diagnose a legitimate insert failure.
DROP POLICY IF EXISTS "Enforce device license on invoice insert" ON public.invoices;
CREATE POLICY "Enforce device license on invoice insert"
  ON public.invoices
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (EXISTS (SELECT 1 FROM public.user_roles WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'boss'::app_role))
    OR NOT (EXISTS (SELECT 1 FROM public.app_licenses WHERE app_licenses.user_id = public.get_owner_id(auth.uid()) AND app_licenses.is_revoked = true))
  );
NOTIFY pgrst, 'reload schema';
