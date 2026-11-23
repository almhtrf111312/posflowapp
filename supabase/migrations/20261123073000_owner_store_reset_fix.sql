-- FINANCE LAW KD-08 — owner store reset (owner decision, 2026-11-23). Replaces the reset path that never worked.
--
-- Why the old reset failed (verified on the live database):
--   1. the guards (block_direct_invoice_delete, prevent_direct_debt_delete, ...) need a context the function never set;
--   2. reset_user_store_data caught every error and returned {success:false}; the client ignored it and wiped the
--      local copy while the cloud was untouched.
--
-- What changes:
--   * the store OWNER (not only Boss) may purge THIS store's own data; every statement filters by the owner id,
--     so other stores are never touched. A cashier cannot run it (the function refuses non-owners).
--   * the guards accept the purge context for the owner too (helper _owner_purge_allowed); normal operation is unchanged
--     because the context is set only inside reset_user_store_data and only for the current transaction.
--   * errors are RAISED (the client sees them); nothing is swallowed into success:false.
--   * kept: products (names, prices, settings, categories), warehouses, store/profile/licence/user records.
--     Products' stock quantities are set to 0 because the stock history that produced them is deleted.
--   * deleted: invoices and their items/profit/accounting events, sales settlements, stock movements/counts/transfers,
--     purchases and supplier ledger, debts/payments/write-offs, customers and their credit ledger, shifts and drawer
--     movements, expenses (recurring too), maintenance services, partners and their ledger, library, period closures.
--   * activity_log is kept, and one 'store_reset' entry is written.

CREATE OR REPLACE FUNCTION public._owner_purge_allowed()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(current_setting('app.purge_context', true), '') = 'owner_purge'
     AND auth.uid() IS NOT NULL
     AND (public.is_boss(auth.uid()) OR public.is_store_owner(auth.uid()));
$$;

-- ---------------------------------------------------------------------------------------------
-- Guards: only the purge branch changes (is_boss -> _owner_purge_allowed); everything else is the live body.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_direct_debt_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR current_setting('role', true) = 'service_role' THEN
    RETURN OLD;
  END IF;
  IF public._owner_purge_allowed() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'الحذف المباشر لسجلات الديون والشطب ممنوع محاسبياً' USING ERRCODE = '42501';
END;
$function$;

CREATE OR REPLACE FUNCTION public._partner_ledger_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND public._owner_purge_allowed() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'سجل الشركاء غير قابل للتعديل أو الحذف';
END
$function$;

CREATE OR REPLACE FUNCTION public.prevent_customer_deletion_with_dues()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public, pg_temp'
AS $function$
BEGIN
  IF public._owner_purge_allowed() THEN
    RETURN OLD;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.debts
    WHERE user_id = OLD.user_id
      AND customer_name = OLD.name
      AND remaining_debt > 0.001
  ) THEN
    RAISE EXCEPTION 'لا يمكن حذف العميل: توجد ديون وذمم مالية قائمة ومستحقة';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.invoices
    WHERE user_id = OLD.user_id
      AND customer_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'لا يمكن حذف العميل: توجد فواتير مبيعات سابقة مسجلة باسمه';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_expenses_assert_period_open()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT public._owner_purge_allowed() THEN
      PERFORM public.assert_period_open(OLD.user_id, OLD.date, 'تعديل المصروفات');
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF current_setting('app.internal_expense_reverse', true) = '1'
       AND NOT COALESCE(OLD.is_reversed, false) AND NEW.is_reversed
       AND (to_jsonb(OLD) - ARRAY['is_reversed','reversed_at','reversed_by','reversed_reason'])
         = (to_jsonb(NEW) - ARRAY['is_reversed','reversed_at','reversed_by','reversed_reason']) THEN
      PERFORM public._assert_accounting_posting_open(NEW.user_id, NEW.reversed_at, 'عكس مصروف');
      RETURN NEW;
    END IF;
    IF OLD.date IS DISTINCT FROM NEW.date THEN
      PERFORM public.assert_period_open(OLD.user_id, OLD.date, 'تعديل المصروفات');
    END IF;
  END IF;

  PERFORM public.assert_period_open(NEW.user_id, NEW.date, 'تعديل المصروفات');
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- The reset itself. Same name and no arguments, so the app keeps calling it unchanged.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_user_store_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_owner_id uuid;
  v_is_boss boolean;
  v_n integer;
  v_counts jsonb := '{}'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'يجب تسجيل الدخول أولاً' USING ERRCODE = '42501';
  END IF;

  v_is_boss := public.is_boss(v_uid);
  v_owner_id := public.get_owner_id(v_uid);
  IF NOT v_is_boss AND (v_owner_id IS NULL OR v_owner_id <> v_uid) THEN
    RAISE EXCEPTION 'صلاحية غير كافية: العملية تتطلب مالك المتجر أو Boss' USING ERRCODE = '42501';
  END IF;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'لم يتم العثور على حساب المتجر';
  END IF;

  -- Transaction-local contexts read by the guards above. They end with the transaction.
  PERFORM set_config('app.invoice_delete_context', 'allowed', true);
  PERFORM set_config('app.purge_context', 'owner_purge', true);

  -- 1. Serials and stock history (children first)
  DELETE FROM public.product_serial_events WHERE user_id = v_owner_id;
  DELETE FROM public.product_serials WHERE user_id = v_owner_id;
  DELETE FROM public.stock_count_items WHERE count_id IN (SELECT id FROM public.stock_counts WHERE user_id = v_owner_id);
  DELETE FROM public.stock_counts WHERE user_id = v_owner_id;
  DELETE FROM public.stock_damages WHERE user_id = v_owner_id;
  DELETE FROM public.stock_transfer_items WHERE transfer_id IN (SELECT id FROM public.stock_transfers WHERE user_id = v_owner_id);
  DELETE FROM public.stock_transfers WHERE user_id = v_owner_id;
  DELETE FROM public.stock_movements WHERE user_id = v_owner_id;

  -- 2. Sales and their accounting records
  DELETE FROM public.invoice_accounting_events WHERE user_id = v_owner_id;
  DELETE FROM public.sales_refund_allocations WHERE user_id = v_owner_id;
  DELETE FROM public.sales_settlement_replays WHERE user_id = v_owner_id;
  DELETE FROM public.accounting_rpc_receipts WHERE user_id = v_owner_id;
  DELETE FROM public.invoice_items WHERE invoice_id IN (SELECT id FROM public.invoices WHERE user_id = v_owner_id);
  DELETE FROM public.profit_records WHERE user_id = v_owner_id;
  DELETE FROM public.invoices WHERE user_id = v_owner_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('invoices', v_n);

  -- 3. Purchases and suppliers
  DELETE FROM public.purchase_return_items WHERE return_id IN (SELECT id FROM public.purchase_returns WHERE user_id = v_owner_id);
  DELETE FROM public.purchase_returns WHERE user_id = v_owner_id;
  DELETE FROM public.purchase_invoice_items WHERE invoice_id IN (SELECT id FROM public.purchase_invoices WHERE user_id = v_owner_id);
  DELETE FROM public.purchase_invoices WHERE user_id = v_owner_id;
  DELETE FROM public.purchase_audit_logs WHERE user_id = v_owner_id;
  DELETE FROM public.supplier_ledger_entries WHERE user_id = v_owner_id;
  DELETE FROM public.suppliers WHERE user_id = v_owner_id;

  -- 4. Debts and customers
  DELETE FROM public.debt_payments WHERE user_id = v_owner_id;
  DELETE FROM public.debt_writeoffs WHERE user_id = v_owner_id;
  DELETE FROM public.debts WHERE user_id = v_owner_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('debts', v_n);
  DELETE FROM public.customer_credit_ledger WHERE user_id = v_owner_id;
  DELETE FROM public.customers WHERE user_id = v_owner_id;

  -- 5. Drawer, expenses, partners, periods
  DELETE FROM public.shift_transactions WHERE user_id = v_owner_id
     OR shift_id IN (SELECT id FROM public.cash_shifts WHERE user_id = v_owner_id);
  DELETE FROM public.cash_shifts WHERE user_id = v_owner_id;
  DELETE FROM public.expenses WHERE user_id = v_owner_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('expenses', v_n);
  DELETE FROM public.recurring_expenses WHERE user_id = v_owner_id;
  DELETE FROM public.maintenance_services WHERE user_id = v_owner_id;
  DELETE FROM public.partner_ledger_entries WHERE user_id = v_owner_id;
  DELETE FROM public.partners WHERE user_id = v_owner_id;
  DELETE FROM public.inventory_valuation_adjustments WHERE user_id = v_owner_id;
  DELETE FROM public.accounting_period_closures WHERE user_id = v_owner_id;

  -- 6. Library
  DELETE FROM public.book_loans WHERE user_id = v_owner_id;
  DELETE FROM public.library_members WHERE user_id = v_owner_id;

  -- 7. KEPT, but their stock is reset: products (prices, names, settings) and warehouse rows
  UPDATE public.warehouse_stock SET quantity = 0
   WHERE warehouse_id IN (SELECT id FROM public.warehouses WHERE user_id = v_owner_id);
  UPDATE public.products SET quantity = 0 WHERE user_id = v_owner_id;

  INSERT INTO public.activity_log(user_id, actor_id, action_type, entity_type, description, metadata)
  VALUES (v_owner_id, v_uid, 'store_reset', 'store', 'تصفير بيانات المتجر (مع الإبقاء على المنتجات)',
          jsonb_build_object('deleted', v_counts));

  RETURN jsonb_build_object(
    'success', true,
    'message', 'تم تصفير بيانات المتجر بنجاح',
    'deleted', v_counts,
    'kept_products', (SELECT count(*) FROM public.products WHERE user_id = v_owner_id)
  );
END;
$function$;
