
-- ===== public.account_encryption_keys =====
CREATE POLICY "owner inserts own encryption key once" ON public.account_encryption_keys
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "owner reads own encryption key" ON public.account_encryption_keys
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));


-- ===== public.accounting_period_closures =====
CREATE POLICY "Store members read closures" ON public.accounting_period_closures
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = get_owner_id(auth.uid())));


-- ===== public.activation_codes =====
CREATE POLICY "Boss can manage activation codes" ON public.activation_codes
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_boss(auth.uid()))
  WITH CHECK (is_boss(auth.uid()));


-- ===== public.activity_log =====
CREATE POLICY "Users insert own activity log" ON public.activity_log
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((user_id = get_owner_id(auth.uid())));

CREATE POLICY "Users view own activity log" ON public.activity_log
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = get_owner_id(auth.uid())));


-- ===== public.app_broadcasts =====
CREATE POLICY "Boss manages broadcasts" ON public.app_broadcasts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_boss(auth.uid()))
  WITH CHECK (is_boss(auth.uid()));

CREATE POLICY "Users read active broadcasts" ON public.app_broadcasts
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_active OR is_boss(auth.uid())));


-- ===== public.app_licenses =====
CREATE POLICY "Boss can delete licenses" ON public.app_licenses
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (is_boss(auth.uid()));

CREATE POLICY "Boss can update any license" ON public.app_licenses
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (is_boss(auth.uid()))
  WITH CHECK (is_boss(auth.uid()));

CREATE POLICY "Only service role can insert licenses" ON public.app_licenses
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (false);

CREATE POLICY "Users can update own license device_id" ON public.app_licenses
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can view own license" ON public.app_licenses
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((user_id = auth.uid()) OR is_boss(auth.uid()) OR (EXISTS ( SELECT 1
   FROM user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'cashier'::app_role) AND (user_roles.owner_id = app_licenses.user_id))))));


-- ===== public.app_settings =====
CREATE POLICY "Boss can manage app settings" ON public.app_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_boss(auth.uid()))
  WITH CHECK (is_boss(auth.uid()));


-- ===== public.auth_recovery_codes =====
CREATE POLICY "No public access to recovery codes" ON public.auth_recovery_codes
  AS PERMISSIVE FOR ALL TO public
  USING (false);


-- ===== public.book_loans =====
CREATE POLICY "Users manage own book loans" ON public.book_loans
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.broadcast_reads =====
CREATE POLICY "Users own broadcast reads" ON public.broadcast_reads
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = auth.uid()));


-- ===== public.cash_shifts =====
CREATE POLICY "Users manage own cash shifts" ON public.cash_shifts
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.categories =====
CREATE POLICY "Users manage own categories" ON public.categories
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.client_versions =====
CREATE POLICY "Read own or boss reads all versions" ON public.client_versions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((user_id = auth.uid()) OR is_boss(auth.uid())));

CREATE POLICY "Users update own version" ON public.client_versions
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

CREATE POLICY "Users upsert own version" ON public.client_versions
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((user_id = auth.uid()));


-- ===== public.customers =====
CREATE POLICY "Users manage own customers" ON public.customers
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.debt_payments =====
CREATE POLICY "Owner reads debt payments" ON public.debt_payments
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = get_owner_id(auth.uid())));


-- ===== public.debt_writeoffs =====
CREATE POLICY "Users manage own debt writeoffs" ON public.debt_writeoffs
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.debts =====
CREATE POLICY "Store isolation debts" ON public.debts
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));

CREATE POLICY "Users manage own debts" ON public.debts
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.error_logs =====
CREATE POLICY "Boss and owners can view error logs" ON public.error_logs
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_boss(auth.uid()) OR (user_id = auth.uid())));

CREATE POLICY "Only boss can delete error logs" ON public.error_logs
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (is_boss(auth.uid()));

CREATE POLICY "Only boss can update error logs" ON public.error_logs
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (is_boss(auth.uid()))
  WITH CHECK (is_boss(auth.uid()));

CREATE POLICY "Signed-in users insert own error logs" ON public.error_logs
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((user_id = auth.uid()));


-- ===== public.expenses =====
CREATE POLICY "Users manage own expenses" ON public.expenses
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.invoice_items =====
CREATE POLICY "Users manage own invoice items" ON public.invoice_items
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((invoice_id IN ( SELECT invoices.id
   FROM invoices
  WHERE (invoices.user_id = get_owner_id(auth.uid())))))
  WITH CHECK ((invoice_id IN ( SELECT invoices.id
   FROM invoices
  WHERE (invoices.user_id = get_owner_id(auth.uid())))));


-- ===== public.invoice_sequences =====
CREATE POLICY "Users view own sequence" ON public.invoice_sequences
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = get_owner_id(auth.uid())));


-- ===== public.invoices =====
CREATE POLICY "Enforce device license on invoice insert" ON public.invoices
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((EXISTS ( SELECT 1
   FROM user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'boss'::app_role)))) OR (NOT (EXISTS ( SELECT 1
   FROM app_licenses
  WHERE ((app_licenses.user_id = get_owner_id(auth.uid())) AND (app_licenses.is_revoked = true)))))));

CREATE POLICY "Licensed users read own invoices" ON public.invoices
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((user_id = get_owner_id(auth.uid())) AND (is_license_valid(auth.uid()) OR is_boss(auth.uid()))));

CREATE POLICY "Store isolation invoices" ON public.invoices
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));

CREATE POLICY "Users delete own invoices" ON public.invoices
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((user_id = get_owner_id(auth.uid())));

CREATE POLICY "Users insert own invoices" ON public.invoices
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((user_id = get_owner_id(auth.uid())));

CREATE POLICY "Users update own invoices" ON public.invoices
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.library_members =====
CREATE POLICY "Users manage own library members" ON public.library_members
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.maintenance_services =====
CREATE POLICY "Users manage own maintenance" ON public.maintenance_services
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.partners =====
CREATE POLICY "Owners can delete partners" ON public.partners
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (((user_id = auth.uid()) AND (has_role(auth.uid(), 'admin'::app_role) OR is_boss(auth.uid()))));

CREATE POLICY "Owners can insert partners" ON public.partners
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((user_id = auth.uid()) AND (has_role(auth.uid(), 'admin'::app_role) OR is_boss(auth.uid()))));

CREATE POLICY "Owners can update partners" ON public.partners
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((user_id = get_owner_id(auth.uid())) AND (has_role(auth.uid(), 'admin'::app_role) OR is_boss(auth.uid()))))
  WITH CHECK (((user_id = get_owner_id(auth.uid())) AND (has_role(auth.uid(), 'admin'::app_role) OR is_boss(auth.uid()))));

CREATE POLICY "Owners can view partners" ON public.partners
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((user_id = get_owner_id(auth.uid())) AND (has_role(auth.uid(), 'admin'::app_role) OR is_boss(auth.uid()))));

CREATE POLICY "Owners only manage partners" ON public.partners
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((user_id = get_owner_id(auth.uid())) AND (has_role(auth.uid(), 'admin'::app_role) OR is_boss(auth.uid()))))
  WITH CHECK (((user_id = get_owner_id(auth.uid())) AND (has_role(auth.uid(), 'admin'::app_role) OR is_boss(auth.uid()))));

CREATE POLICY "Owners only view partners" ON public.partners
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((user_id = get_owner_id(auth.uid())) AND (has_role(auth.uid(), 'admin'::app_role) OR is_boss(auth.uid()))));


-- ===== public.payment_methods =====
CREATE POLICY "Boss full access methods" ON public.payment_methods
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_boss(auth.uid()))
  WITH CHECK (is_boss(auth.uid()));

CREATE POLICY "Public read enabled methods" ON public.payment_methods
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((enabled = true) OR is_boss(auth.uid())));


-- ===== public.phone_transfer_requests =====
CREATE POLICY "service_role_transfer_requests_all" ON public.phone_transfer_requests
  AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);


-- ===== public.products =====
CREATE POLICY "Store isolation products" ON public.products
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));

CREATE POLICY "Users manage own products" ON public.products
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.profiles =====
CREATE POLICY "Admins can update owned profiles" ON public.profiles
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((EXISTS ( SELECT 1
   FROM user_roles
  WHERE ((user_roles.user_id = profiles.user_id) AND (user_roles.owner_id = auth.uid())))) AND has_role(auth.uid(), 'admin'::app_role)))
  WITH CHECK (((EXISTS ( SELECT 1
   FROM user_roles
  WHERE ((user_roles.user_id = profiles.user_id) AND (user_roles.owner_id = auth.uid())))) AND has_role(auth.uid(), 'admin'::app_role)));

CREATE POLICY "Admins can view owned profiles" ON public.profiles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((EXISTS ( SELECT 1
   FROM user_roles
  WHERE ((user_roles.user_id = profiles.user_id) AND (user_roles.owner_id = auth.uid())))) AND has_role(auth.uid(), 'admin'::app_role)));

CREATE POLICY "Boss can update all profiles" ON public.profiles
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (is_boss(auth.uid()))
  WITH CHECK (is_boss(auth.uid()));

CREATE POLICY "Boss can view all profiles" ON public.profiles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_boss(auth.uid()));

CREATE POLICY "Users can insert own profile" ON public.profiles
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can update own profile" ON public.profiles
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can view own profile" ON public.profiles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));


-- ===== public.profit_records =====
CREATE POLICY "Users manage own profit records" ON public.profit_records
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.purchase_invoice_items =====
CREATE POLICY "Users manage own purchase invoice items" ON public.purchase_invoice_items
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((invoice_id IN ( SELECT purchase_invoices.id
   FROM purchase_invoices
  WHERE (purchase_invoices.user_id = get_owner_id(auth.uid())))))
  WITH CHECK ((invoice_id IN ( SELECT purchase_invoices.id
   FROM purchase_invoices
  WHERE (purchase_invoices.user_id = get_owner_id(auth.uid())))));


-- ===== public.purchase_invoices =====
CREATE POLICY "Users manage own purchase invoices" ON public.purchase_invoices
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.recurring_expenses =====
CREATE POLICY "Users manage own recurring expenses" ON public.recurring_expenses
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.security_tamper_logs =====
CREATE POLICY "Boss and admin view security tamper logs" ON public.security_tamper_logs
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_boss(auth.uid()) OR (EXISTS ( SELECT 1
   FROM user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = ANY (ARRAY['admin'::app_role, 'boss'::app_role])))))));

CREATE POLICY "Devices report security tamper logs" ON public.security_tamper_logs
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((user_id = auth.uid()) OR (user_id IS NULL)));


-- ===== public.shift_transactions =====
CREATE POLICY "Users manage own shift transactions" ON public.shift_transactions
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.stock_count_items =====
CREATE POLICY "Users manage own stock count items" ON public.stock_count_items
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((count_id IN ( SELECT stock_counts.id
   FROM stock_counts
  WHERE (stock_counts.user_id = get_owner_id(auth.uid())))))
  WITH CHECK ((count_id IN ( SELECT stock_counts.id
   FROM stock_counts
  WHERE (stock_counts.user_id = get_owner_id(auth.uid())))));


-- ===== public.stock_counts =====
CREATE POLICY "Users manage own stock counts" ON public.stock_counts
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.stock_damages =====
CREATE POLICY "Users manage own stock damages" ON public.stock_damages
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.stock_movements =====
CREATE POLICY "Users view owner stock movements" ON public.stock_movements
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = get_owner_id(auth.uid())));


-- ===== public.stock_transfer_items =====
CREATE POLICY "Users see transfer items" ON public.stock_transfer_items
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((transfer_id IN ( SELECT stock_transfers.id
   FROM stock_transfers
  WHERE (stock_transfers.user_id = get_owner_id(auth.uid())))))
  WITH CHECK ((transfer_id IN ( SELECT stock_transfers.id
   FROM stock_transfers
  WHERE (stock_transfers.user_id = get_owner_id(auth.uid())))));


-- ===== public.stock_transfers =====
CREATE POLICY "Owners manage stock transfers" ON public.stock_transfers
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.store_settings =====
CREATE POLICY "Users own their store settings" ON public.store_settings
  AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id));


-- ===== public.stores =====
CREATE POLICY "Users can update their own store" ON public.stores
  AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

CREATE POLICY "Users manage own store" ON public.stores
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = get_owner_id(auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== public.subscription_plans =====
CREATE POLICY "Boss full access plans" ON public.subscription_plans
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_boss(auth.uid()))
  WITH CHECK (is_boss(auth.uid()));

CREATE POLICY "Public read enabled plans" ON public.subscription_plans
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((enabled = true) OR is_boss(auth.uid())));


-- ===== public.subscription_requests =====
CREATE POLICY "Boss manage all subscription requests" ON public.subscription_requests
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_boss(auth.uid()))
  WITH CHECK (is_boss(auth.uid()));

CREATE POLICY "Users create requests" ON public.subscription_requests
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((user_id = auth.uid()) AND ((status IS NULL) OR (status = 'pending'::text)) AND (confirmed_by IS NULL) AND (confirmed_at IS NULL)));

CREATE POLICY "Users read own requests" ON public.subscription_requests
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((user_id = auth.uid()) OR is_boss(auth.uid())));

CREATE POLICY "Users update own pending proof only" ON public.subscription_requests
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((user_id = auth.uid()) AND (status = 'pending'::text)))
  WITH CHECK (((user_id = auth.uid()) AND (status = 'pending'::text) AND (confirmed_by IS NULL) AND (confirmed_at IS NULL)));


-- ===== public.support_conversations =====
CREATE POLICY "Boss can update conversations" ON public.support_conversations
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((is_boss(auth.uid()) OR (user_id = auth.uid())));

CREATE POLICY "Users and boss view support conversations" ON public.support_conversations
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((user_id = auth.uid()) OR (owner_id = get_owner_id(auth.uid())) OR is_boss(auth.uid())));

CREATE POLICY "Users can create own conversation" ON public.support_conversations
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((user_id = auth.uid()) OR is_boss(auth.uid())));

CREATE POLICY "Users can view own conversation" ON public.support_conversations
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((user_id = auth.uid()) OR (owner_id = get_owner_id(auth.uid())) OR is_boss(auth.uid())));


-- ===== public.support_messages =====
CREATE POLICY "Users and boss update support messages" ON public.support_messages
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((is_boss(auth.uid()) OR (EXISTS ( SELECT 1
   FROM support_conversations c
  WHERE ((c.id = support_messages.conversation_id) AND ((c.user_id = auth.uid()) OR (c.owner_id = get_owner_id(auth.uid()))))))))
  WITH CHECK ((is_boss(auth.uid()) OR (EXISTS ( SELECT 1
   FROM support_conversations c
  WHERE ((c.id = support_messages.conversation_id) AND ((c.user_id = auth.uid()) OR (c.owner_id = get_owner_id(auth.uid()))))))));

CREATE POLICY "Users and boss view support messages" ON public.support_messages
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_boss(auth.uid()) OR (EXISTS ( SELECT 1
   FROM support_conversations c
  WHERE ((c.id = support_messages.conversation_id) AND ((c.user_id = auth.uid()) OR (c.owner_id = get_owner_id(auth.uid()))))))));

CREATE POLICY "Users can insert messages into own conversation" ON public.support_messages
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((sender_id = auth.uid()) AND (is_boss(auth.uid()) OR (EXISTS ( SELECT 1
   FROM support_conversations c
  WHERE ((c.id = support_messages.conversation_id) AND ((c.user_id = auth.uid()) OR (c.owner_id = get_owner_id(auth.uid())))))))));

CREATE POLICY "Users can view messages in own conversation" ON public.support_messages
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_boss(auth.uid()) OR (EXISTS ( SELECT 1
   FROM support_conversations c
  WHERE ((c.id = support_messages.conversation_id) AND ((c.user_id = auth.uid()) OR (c.owner_id = get_owner_id(auth.uid()))))))));


-- ===== public.user_notifications =====
CREATE POLICY "Boss insert notifications" ON public.user_notifications
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((user_id = auth.uid()) OR is_boss(auth.uid())));

CREATE POLICY "Users delete own notifications" ON public.user_notifications
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (((user_id = auth.uid()) OR is_boss(auth.uid())));

CREATE POLICY "Users read own notifications" ON public.user_notifications
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((user_id = auth.uid()) OR is_boss(auth.uid())));

CREATE POLICY "Users update own notifications" ON public.user_notifications
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));


-- ===== public.user_roles =====
CREATE POLICY "Admins can create owned users" ON public.user_roles
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((has_role(auth.uid(), 'admin'::app_role) AND (owner_id = auth.uid()) AND (role = 'cashier'::app_role)) OR is_boss(auth.uid())));

CREATE POLICY "Admins can delete owned users" ON public.user_roles
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((((owner_id = auth.uid()) AND has_role(auth.uid(), 'admin'::app_role)) OR is_boss(auth.uid())));

CREATE POLICY "Admins can update owned users" ON public.user_roles
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((owner_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM user_roles user_roles_1
  WHERE ((user_roles_1.user_id = auth.uid()) AND (user_roles_1.role = 'admin'::app_role))))))
  WITH CHECK (((role = 'cashier'::app_role) AND (owner_id = auth.uid())));

CREATE POLICY "Admins can view owned users" ON public.user_roles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((owner_id = auth.uid()) AND has_role(auth.uid(), 'admin'::app_role)));

CREATE POLICY "Boss can view all roles" ON public.user_roles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_boss(auth.uid()));

CREATE POLICY "Users can view own role" ON public.user_roles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));


-- ===== public.warehouse_stock =====
CREATE POLICY "Users see assigned warehouse stock" ON public.warehouse_stock
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((warehouse_id IN ( SELECT warehouses.id
   FROM warehouses
  WHERE ((warehouses.user_id = get_owner_id(auth.uid())) OR (warehouses.assigned_cashier_id = auth.uid())))))
  WITH CHECK ((warehouse_id IN ( SELECT warehouses.id
   FROM warehouses
  WHERE (warehouses.user_id = get_owner_id(auth.uid())))));


-- ===== public.warehouses =====
CREATE POLICY "Owners manage warehouses" ON public.warehouses
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((user_id = get_owner_id(auth.uid())) OR (assigned_cashier_id = auth.uid())))
  WITH CHECK ((user_id = get_owner_id(auth.uid())));


-- ===== storage.objects =====
CREATE POLICY "Owner-group can view product images" ON storage.objects
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((bucket_id = 'product-images'::text) AND (((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text) OR ((storage.foldername(name))[1] IN ( SELECT (ur.user_id)::text AS user_id
   FROM user_roles ur
  WHERE (get_owner_id(ur.user_id) = get_owner_id(( SELECT auth.uid() AS uid))))) OR (((storage.foldername(name))[1] = 'products'::text) AND (owner_id IN ( SELECT (ur.user_id)::text AS user_id
   FROM user_roles ur
  WHERE (get_owner_id(ur.user_id) = get_owner_id(( SELECT auth.uid() AS uid)))))))));

CREATE POLICY "Users can delete own backups" ON storage.objects
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (((bucket_id = 'backups'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

CREATE POLICY "Users can delete own product images" ON storage.objects
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (((bucket_id = 'product-images'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));

CREATE POLICY "Users can update own backups" ON storage.objects
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((bucket_id = 'backups'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

CREATE POLICY "Users can upload own backups" ON storage.objects
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((bucket_id = 'backups'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

CREATE POLICY "Users can upload product images" ON storage.objects
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((bucket_id = 'product-images'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

CREATE POLICY "Users can view own backups" ON storage.objects
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((bucket_id = 'backups'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

