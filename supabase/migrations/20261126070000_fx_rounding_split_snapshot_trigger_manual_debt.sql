-- Audit round 2 (external review of v1.5.283), owner-approved fixes:
-- 1) F-26/F-27: when a debt payment is credited at the invoice rate, record_debt_payment_atomic put the snapping difference (<= 0.05)
--    into fx_difference_usd and zeroed rounding_adjustment. Now: fx_difference_usd = cash received - credit at the invoice rate,
--    rounding_adjustment = settlement - credit. Identity kept for R-06: fx = amount - settled_amount + rounding_adjustment.
-- 2) D-12: the original profit snapshot is written on the server when the sale commits (deferred trigger), so a partial refund that
--    happens before the client's snapshot call can no longer block it. record_sale_profit_snapshot counts only original rows
--    (revenue >= 0; refund rows are negative) and refuses to rebuild a snapshot after a refund (the invoice profit is reduced by then).
-- 3) F-25: a manual (cash) debt was inserted into public.debts directly from the client. New RPC create_manual_debt_atomic,
--    idempotent by the client id. No drawer movement, same as before.

DO $do$
DECLARE
  v_def text;
  v_old text := $o$    v_fx_difference := round(v_cash_amount - v_settlement, 8);   -- > 0 gain, < 0 loss
    v_rounding_adjustment := 0;
    v_rounding_note := CASE WHEN v_fx_difference <> 0 THEN ' (فرق صرف: ' || v_fx_difference::text || ' USD)' ELSE '' END;$o$;
  v_new text := $n$    v_fx_difference := round(v_cash_amount - v_credit, 8);   -- > 0 gain, < 0 loss (rate difference only)
    v_rounding_adjustment := round(v_settlement - v_credit, 8);   -- F-26 snapping, kept apart from the FX difference
    v_rounding_note := CASE WHEN v_fx_difference <> 0 THEN ' (فرق صرف: ' || v_fx_difference::text || ' USD)' ELSE '' END
      || CASE WHEN v_rounding_adjustment <> 0 THEN ' (تعديل تقريب: ' || v_rounding_adjustment::text || ' USD)' ELSE '' END;$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'record_debt_payment_atomic' AND p.pronargs = 8;
  v_def := replace(v_def, chr(13) || chr(10), chr(10));   -- the live body was saved with CRLF line endings
  IF v_def IS NULL OR position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'record_debt_payment_atomic: expected FX block not found';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END $do$;

CREATE OR REPLACE FUNCTION public.record_sale_profit_snapshot(_invoice_number text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _owner uuid := public.get_owner_id(auth.uid());
  _inv public.invoices%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  SELECT * INTO _inv FROM public.invoices WHERE user_id = _owner AND invoice_number = _invoice_number LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'الفاتورة غير موجودة'; END IF;
  RETURN public._write_original_profit_snapshot(_inv.id);
END $function$;
GRANT EXECUTE ON FUNCTION public.record_sale_profit_snapshot(text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.record_sale_profit_snapshot(text) FROM anon;

-- Writes the original profit snapshot of one sale invoice once. Not callable by clients.
CREATE OR REPLACE FUNCTION public._write_original_profit_snapshot(_invoice_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE;
  _cogs numeric;
BEGIN
  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF COALESCE(_inv.invoice_type, 'sale') NOT IN ('sale', 'maintenance') THEN RETURN false; END IF;
  IF COALESCE(_inv.status, '') IN ('refunded', 'cancelled') THEN RETURN false; END IF;
  -- One original snapshot per invoice (refund rows have negative revenue and do not count).
  IF EXISTS (SELECT 1 FROM public.profit_records WHERE user_id = _inv.user_id AND invoice_id IN (_inv.invoice_number, _inv.id::text)
               AND revenue >= 0) THEN RETURN false; END IF;
  -- After a refund the invoice profit is already reduced: the original cannot be rebuilt from it.
  IF EXISTS (SELECT 1 FROM public.profit_records WHERE user_id = _inv.user_id AND invoice_id IN (_inv.invoice_number, _inv.id::text)
               AND revenue < 0)
     OR EXISTS (SELECT 1 FROM public.sales_refund_allocations WHERE user_id = _inv.user_id AND invoice_id = _inv.id) THEN
    RETURN false;
  END IF;
  SELECT COALESCE(SUM(COALESCE(cost_price, 0) * COALESCE(quantity, 0)), 0) INTO _cogs FROM public.invoice_items WHERE invoice_id = _inv.id;
  INSERT INTO public.profit_records(user_id, invoice_id, gross_profit, cogs, revenue, currency, recorded_at)
  VALUES (_inv.user_id, _inv.invoice_number, round(COALESCE(_inv.profit, 0), 8), round(_cogs, 8),
          round(COALESCE(_inv.total, 0) - COALESCE(_inv.tax_amount, 0), 8), 'USD', COALESCE(_inv.created_at, now()));
  RETURN true;
END $function$;
REVOKE EXECUTE ON FUNCTION public._write_original_profit_snapshot(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_invoice_profit_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._write_original_profit_snapshot(NEW.id);
  RETURN NULL;
END $function$;
REVOKE EXECUTE ON FUNCTION public.trg_invoice_profit_snapshot() FROM PUBLIC, anon, authenticated;

-- Deferred to commit: the sale RPC inserts the invoice first and its items/profit after, in the same transaction.
DROP TRIGGER IF EXISTS invoice_profit_snapshot ON public.invoices;
CREATE CONSTRAINT TRIGGER invoice_profit_snapshot
  AFTER INSERT ON public.invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_invoice_profit_snapshot();

CREATE OR REPLACE FUNCTION public.create_manual_debt_atomic(
  _id uuid, _invoice_id text, _customer_name text, _customer_phone text, _total_debt numeric,
  _due_date date DEFAULT NULL, _notes text DEFAULT NULL, _is_cash_debt boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _owner uuid := public.get_owner_id(auth.uid());
  _total numeric := round(COALESCE(_total_debt, 0)::numeric, 8);
  _row public.debts%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF _id IS NULL THEN RAISE EXCEPTION 'معرّف الدين مطلوب'; END IF;
  -- Replay of the same client id: return the stored row, write nothing.
  SELECT * INTO _row FROM public.debts WHERE id = _id;
  IF FOUND THEN
    IF _row.user_id <> _owner THEN RAISE EXCEPTION 'غير مصرح'; END IF;
    RETURN to_jsonb(_row) || jsonb_build_object('replayed', true);
  END IF;
  IF _total <= 0 THEN RAISE EXCEPTION 'أدخل مبلغًا صحيحًا أكبر من الصفر'; END IF;
  IF NULLIF(trim(COALESCE(_customer_name, '')), '') IS NULL THEN RAISE EXCEPTION 'اسم العميل مطلوب'; END IF;
  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'إنشاء دين');
  INSERT INTO public.debts(id, user_id, invoice_id, customer_name, customer_phone, total_debt, total_paid, remaining_debt,
                           due_date, status, notes, is_cash_debt, cashier_id)
  VALUES (_id, _owner, NULLIF(trim(COALESCE(_invoice_id, '')), ''), trim(_customer_name), NULLIF(trim(COALESCE(_customer_phone, '')), ''),
          _total, 0, _total, _due_date, CASE WHEN _due_date IS NOT NULL AND _due_date < CURRENT_DATE THEN 'overdue' ELSE 'due' END,
          NULLIF(_notes, ''), COALESCE(_is_cash_debt, true), auth.uid())
  RETURNING * INTO _row;
  RETURN to_jsonb(_row) || jsonb_build_object('replayed', false);
END $function$;
GRANT EXECUTE ON FUNCTION public.create_manual_debt_atomic(uuid, text, text, text, numeric, date, text, boolean) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.create_manual_debt_atomic(uuid, text, text, text, numeric, date, text, boolean) FROM anon;
