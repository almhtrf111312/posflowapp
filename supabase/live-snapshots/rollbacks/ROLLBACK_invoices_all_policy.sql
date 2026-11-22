-- Rollback for 20261121030100_posflow_invoices_drop_permissive_all_policy.sql
DROP POLICY IF EXISTS "Store isolation invoices" ON public.invoices;
CREATE POLICY "Store isolation invoices"
  ON public.invoices
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (user_id = get_owner_id(auth.uid()))
  WITH CHECK (user_id = get_owner_id(auth.uid()));
NOTIFY pgrst, 'reload schema';
