-- Fix: the owner could not change a cashier's refund permission ("تعذّر تحديث صلاحية الاسترداد").
-- Live error: "infinite recursion detected in policy for relation user_roles" — the UPDATE policy checked the caller's
-- admin role with a sub-select on user_roles itself. It now uses has_role() (SECURITY DEFINER), like the other
-- user_roles policies. Same rule as before: the store admin updates only the cashiers it owns, and they stay cashiers.
DROP POLICY IF EXISTS "Admins can update owned users" ON public.user_roles;
CREATE POLICY "Admins can update owned users" ON public.user_roles FOR UPDATE
  USING (owner_id = (SELECT auth.uid()) AND public.has_role((SELECT auth.uid()), 'admin'::app_role))
  WITH CHECK (role = 'cashier'::app_role AND owner_id = (SELECT auth.uid()));
