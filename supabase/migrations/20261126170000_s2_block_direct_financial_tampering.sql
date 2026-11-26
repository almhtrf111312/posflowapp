-- S-2 (security audit 2026-11-26, owner-approved): block tampering with financial rows through direct REST writes.
-- Owner's conditions: nobody loses access to read their own data, and the store owner / boss keep managing the store.
-- Only DIRECT client writes are checked (current_user authenticated/anon). SECURITY DEFINER RPCs run as their owner and Edge
-- Functions as service_role, so every atomic operation, store reset and boss tool keeps working unchanged.
-- The app still makes some legitimate direct inserts (drawer movements, opening a shift, stock deduction on a sale, maintenance
-- invoices); those stay allowed, but existing financial history can no longer be edited or deleted directly.
--   shift_transactions : append-only for clients; a new movement must go to an OPEN shift of the same store with amount > 0.
--                        A movement for a closed shift is refused with (F-20) so the offline queue parks it for manual review.
--   debts              : no direct insert; no direct change of amounts, status, invoice link or cash flag.
--   profit_records     : no direct insert or delete; only a store manager may mark a record reversed.
--   cash_shifts        : a closed shift is read-only; opening balance and closing figures cannot be edited directly.
--   invoices / invoice_items / products : a cashier (not the store manager) cannot change invoice amounts or status,
--                        invoice lines, or a product's cost.
-- receive_stock_wac and post_shift_sale_atomic are internal (not called by the app): no client EXECUTE.

CREATE OR REPLACE FUNCTION public._direct_client_write()
 RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $$ SELECT current_user IN ('authenticated', 'anon') $$;

CREATE OR REPLACE FUNCTION public._caller_is_store_manager()
 RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $$ SELECT auth.uid() IS NOT NULL AND (public.is_boss(auth.uid()) OR public.is_store_owner(auth.uid())) $$;

-- All guard functions are SECURITY INVOKER on purpose: inside a SECURITY DEFINER RPC current_user is the RPC owner.
CREATE OR REPLACE FUNCTION public.guard_shift_transactions_direct()
 RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public'
AS $function$
DECLARE _shift record;
BEGIN
  IF NOT public._direct_client_write() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'حركات الصندوق سجل ثابت: لا تعديل ولا حذف مباشر' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(NEW.amount, 0) <= 0 THEN
    RAISE EXCEPTION 'مبلغ حركة الصندوق يجب أن يكون أكبر من الصفر' USING ERRCODE = '23514';
  END IF;
  SELECT id, user_id, closed_at INTO _shift FROM public.cash_shifts WHERE id = NEW.shift_id;
  IF NOT FOUND OR _shift.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'الوردية غير موجودة لهذا المتجر' USING ERRCODE = '42501';
  END IF;
  IF _shift.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'حركة لوردية مغلقة: تبقى معلقة للمطابقة اليدوية من المالك (F-20)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.guard_debts_direct()
 RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._direct_client_write() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'الدين يُنشأ عبر العملية الذرية فقط' USING ERRCODE = '42501';
  END IF;
  IF NEW.total_debt IS DISTINCT FROM OLD.total_debt OR NEW.total_paid IS DISTINCT FROM OLD.total_paid
     OR NEW.remaining_debt IS DISTINCT FROM OLD.remaining_debt OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.is_cash_debt IS DISTINCT FROM OLD.is_cash_debt
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'مبالغ الدين وحالته تتغير عبر عمليات السداد والإلغاء فقط' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.guard_profit_records_direct()
 RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._direct_client_write() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP IN ('INSERT', 'DELETE') THEN
    RAISE EXCEPTION 'سجل الربح يكتبه الخادم فقط' USING ERRCODE = '42501';
  END IF;
  -- Only marking a record reversed (invoice cancelled by the store manager) is allowed.
  IF NOT public._caller_is_store_manager()
     OR NEW.gross_profit IS DISTINCT FROM OLD.gross_profit OR NEW.cogs IS DISTINCT FROM OLD.cogs
     OR NEW.revenue IS DISTINCT FROM OLD.revenue OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
     OR (OLD.is_reversed AND NOT NEW.is_reversed) THEN
    RAISE EXCEPTION 'لا يمكن تعديل سجل الربح مباشرة' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.guard_cash_shifts_direct()
 RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._direct_client_write() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    -- variance defaults to 0 on a new shift; only a non-zero value means closing figures were sent.
    IF NEW.closed_at IS NOT NULL OR NEW.actual_balance IS NOT NULL OR COALESCE(NEW.variance, 0) <> 0 OR COALESCE(NEW.opening_balance, 0) < 0 THEN
      RAISE EXCEPTION 'الوردية تُفتح فقط؛ الإغلاق عبر العملية الذرية' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'الوردية مغلقة ولا تُعدَّل' USING ERRCODE = '42501';
  END IF;
  IF NEW.opening_balance IS DISTINCT FROM OLD.opening_balance OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
     OR NEW.actual_balance IS DISTINCT FROM OLD.actual_balance OR NEW.variance IS DISTINCT FROM OLD.variance
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.cashier_id IS DISTINCT FROM OLD.cashier_id THEN
    RAISE EXCEPTION 'رصيد الافتتاح والإغلاق يتغيران عبر العمليات الذرية فقط' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.guard_invoices_cashier_direct()
 RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._direct_client_write() OR public._caller_is_store_manager() THEN RETURN NEW; END IF;
  IF NEW.total IS DISTINCT FROM OLD.total OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
     OR NEW.discount IS DISTINCT FROM OLD.discount OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount
     OR NEW.profit IS DISTINCT FROM OLD.profit OR NEW.debt_paid IS DISTINCT FROM OLD.debt_paid
     OR NEW.debt_remaining IS DISTINCT FROM OLD.debt_remaining OR NEW.payment_type IS DISTINCT FROM OLD.payment_type
     OR NEW.status IS DISTINCT FROM OLD.status OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'تعديل مبالغ الفاتورة أو حالتها مخصص لمدير المتجر' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.guard_invoice_items_cashier_direct()
 RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._direct_client_write() OR public._caller_is_store_manager() THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'تعديل بنود الفاتورة مخصص لمدير المتجر' USING ERRCODE = '42501';
END $function$;

CREATE OR REPLACE FUNCTION public.guard_products_cost_cashier_direct()
 RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._direct_client_write() OR public._caller_is_store_manager() THEN RETURN NEW; END IF;
  IF NEW.cost_price IS DISTINCT FROM OLD.cost_price OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'تعديل كلفة المنتج مخصص لمدير المتجر' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $function$;

REVOKE EXECUTE ON FUNCTION public.guard_shift_transactions_direct(), public.guard_debts_direct(), public.guard_profit_records_direct(),
  public.guard_cash_shifts_direct(), public.guard_invoices_cashier_direct(), public.guard_invoice_items_cashier_direct(),
  public.guard_products_cost_cashier_direct() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a0_guard_direct ON public.shift_transactions;
CREATE TRIGGER a0_guard_direct BEFORE INSERT OR UPDATE OR DELETE ON public.shift_transactions
  FOR EACH ROW EXECUTE FUNCTION public.guard_shift_transactions_direct();
DROP TRIGGER IF EXISTS a0_guard_direct ON public.debts;
CREATE TRIGGER a0_guard_direct BEFORE INSERT OR UPDATE ON public.debts
  FOR EACH ROW EXECUTE FUNCTION public.guard_debts_direct();
DROP TRIGGER IF EXISTS a0_guard_direct ON public.profit_records;
CREATE TRIGGER a0_guard_direct BEFORE INSERT OR UPDATE OR DELETE ON public.profit_records
  FOR EACH ROW EXECUTE FUNCTION public.guard_profit_records_direct();
DROP TRIGGER IF EXISTS a0_guard_direct ON public.cash_shifts;
CREATE TRIGGER a0_guard_direct BEFORE INSERT OR UPDATE ON public.cash_shifts
  FOR EACH ROW EXECUTE FUNCTION public.guard_cash_shifts_direct();
DROP TRIGGER IF EXISTS a0_guard_cashier_direct ON public.invoices;
CREATE TRIGGER a0_guard_cashier_direct BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoices_cashier_direct();
DROP TRIGGER IF EXISTS a0_guard_cashier_direct ON public.invoice_items;
CREATE TRIGGER a0_guard_cashier_direct BEFORE UPDATE OR DELETE ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_items_cashier_direct();
DROP TRIGGER IF EXISTS a0_guard_cashier_direct ON public.products;
CREATE TRIGGER a0_guard_cashier_direct BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.guard_products_cost_cashier_direct();

REVOKE EXECUTE ON FUNCTION public.receive_stock_wac(uuid, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.post_shift_sale_atomic(uuid, text, numeric, text, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
