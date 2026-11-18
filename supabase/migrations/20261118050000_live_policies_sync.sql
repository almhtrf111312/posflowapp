-- Align RLS policies with the live database.
DROP POLICY IF EXISTS "Users can delete own broadcast reads" ON public.broadcast_reads;
DROP POLICY IF EXISTS "Users can insert own broadcast reads" ON public.broadcast_reads;
DROP POLICY IF EXISTS "Users can update own broadcast reads" ON public.broadcast_reads;
DROP POLICY IF EXISTS "Users can view own broadcast reads" ON public.broadcast_reads;
DROP POLICY IF EXISTS "Boss only read telegram config" ON public.app_settings;
DROP POLICY IF EXISTS "Users and boss create support conversations" ON public.support_conversations;
DROP POLICY IF EXISTS "Users and boss update support conversations" ON public.support_conversations;
DROP POLICY IF EXISTS "Users and boss insert support messages" ON public.support_messages;
DROP POLICY IF EXISTS "Owners manage recurring expenses" ON public.recurring_expenses;
DROP POLICY IF EXISTS "Boss can manage subscription plans" ON public.subscription_plans;
DROP POLICY IF EXISTS "Anyone can view enabled subscription plans" ON public.subscription_plans;

ALTER TABLE public.auth_recovery_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "No public access to recovery codes" ON public.auth_recovery_codes;
CREATE POLICY "No public access to recovery codes" ON public.auth_recovery_codes AS PERMISSIVE FOR ALL TO public USING (false);

DROP POLICY IF EXISTS "Users manage own recurring expenses" ON public.recurring_expenses;
CREATE POLICY "Users manage own recurring expenses" ON public.recurring_expenses AS PERMISSIVE FOR ALL TO authenticated
  USING (user_id = get_owner_id(auth.uid())) WITH CHECK (user_id = get_owner_id(auth.uid()));

DROP POLICY IF EXISTS "Enforce device license on invoice insert" ON public.invoices;
CREATE POLICY "Enforce device license on invoice insert" ON public.invoices AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'boss'::app_role)
    OR NOT EXISTS (SELECT 1 FROM app_licenses WHERE app_licenses.user_id = get_owner_id(auth.uid()) AND app_licenses.is_revoked = true)
  );

DROP POLICY IF EXISTS "Users can update their own store" ON public.stores;
CREATE POLICY "Users can update their own store" ON public.stores AS PERMISSIVE FOR UPDATE TO public USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Public read enabled plans" ON public.subscription_plans;
CREATE POLICY "Public read enabled plans" ON public.subscription_plans AS PERMISSIVE FOR SELECT TO authenticated
  USING (enabled = true OR is_boss(auth.uid()));
DROP POLICY IF EXISTS "Boss full access plans" ON public.subscription_plans;
CREATE POLICY "Boss full access plans" ON public.subscription_plans AS PERMISSIVE FOR ALL TO authenticated
  USING (is_boss(auth.uid())) WITH CHECK (is_boss(auth.uid()));

DROP POLICY IF EXISTS "Public read enabled methods" ON public.payment_methods;
CREATE POLICY "Public read enabled methods" ON public.payment_methods AS PERMISSIVE FOR SELECT TO authenticated
  USING (enabled = true OR is_boss(auth.uid()));

DROP POLICY IF EXISTS "Users create requests" ON public.subscription_requests;
CREATE POLICY "Users create requests" ON public.subscription_requests AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND (status IS NULL OR status = 'pending') AND confirmed_by IS NULL AND confirmed_at IS NULL);
DROP POLICY IF EXISTS "Users update own pending proof only" ON public.subscription_requests;
CREATE POLICY "Users update own pending proof only" ON public.subscription_requests AS PERMISSIVE FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND status = 'pending')
  WITH CHECK (user_id = auth.uid() AND status = 'pending' AND confirmed_by IS NULL AND confirmed_at IS NULL);

DROP POLICY IF EXISTS "Admins can update owned users" ON public.user_roles;
CREATE POLICY "Admins can update owned users" ON public.user_roles AS PERMISSIVE FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() AND EXISTS (SELECT 1 FROM user_roles user_roles_1 WHERE user_roles_1.user_id = auth.uid() AND user_roles_1.role = 'admin'::app_role))
  WITH CHECK (role = 'cashier'::app_role AND owner_id = auth.uid());
