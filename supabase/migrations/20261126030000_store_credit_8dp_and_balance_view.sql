-- Store credit at 8 decimals (F-02) and the balance view in the repo.
-- 1) public.customer_credit_balances existed only on the live database (the app reads a customer's credit from it). It is created here with the
--    live definition and security_invoker (RLS of the caller applies), except that store_credit is rounded to 8 decimals instead of 4.
-- 2) customer_credit_ledger.amount was numeric(18,4), so any amount was cut to 4 decimals when stored. It is widened to numeric(20,8)
--    (lossless; the view depends on it, so the view is dropped first and recreated).
-- 3) issue_store_credit_atomic, payout_store_credit_atomic and apply_store_credit_to_debt_atomic rounded amounts to 4 decimals; F-02 requires 8.
--    apply_store_credit_to_debt_atomic also allowed spending 0.0001 more than the balance; it now compares at 8 decimals.
--    Only the rounding precision changes; each body is otherwise the latest definition
--    (20261125090000 for payout, 20261126010000 for issue, 20261126020000 for apply).
-- Approved by the owner on 2026-11-26 ("نفذ المهام كلها").

DROP VIEW IF EXISTS public.customer_credit_balances;
ALTER TABLE public.customer_credit_ledger ALTER COLUMN amount TYPE numeric(20,8);

CREATE VIEW public.customer_credit_balances WITH (security_invoker = true) AS
 SELECT c.id AS customer_id,
    c.user_id,
    c.name,
    c.credit_limit,
    c.total_debt,
    round(COALESCE(sum(l.amount), 0::numeric), 8) AS store_credit
   FROM public.customers c
     LEFT JOIN public.customer_credit_ledger l ON l.customer_id = c.id
  GROUP BY c.id;

GRANT SELECT ON public.customer_credit_balances TO authenticated;

CREATE OR REPLACE FUNCTION public.issue_store_credit_atomic(_customer_id uuid, _amount numeric, _reason text, _invoice_number text, _operation_id text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _o uuid := public._credit_actor(true); _id uuid;
BEGIN
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  IF COALESCE(_operation_id,'') = '' THEN RAISE EXCEPTION 'معرّف العملية مطلوب'; END IF;
  PERFORM 1 FROM public.customers WHERE id=_customer_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'العميل غير موجود'; END IF;
  SELECT id INTO _id FROM public.customer_credit_ledger WHERE user_id=_o AND operation_id=_operation_id AND entry_type='issue';
  IF _id IS NOT NULL THEN RETURN _id; END IF;
  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'إصدار رصيد عميل');
  INSERT INTO public.customer_credit_ledger(user_id,customer_id,entry_type,amount,invoice_number,reason,operation_id,created_by)
  VALUES (_o,_customer_id,'issue',round(_amount,8),_invoice_number,_reason,_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END $function$;

CREATE OR REPLACE FUNCTION public.payout_store_credit_atomic(_customer_id uuid, _amount numeric, _shift_id uuid, _operation_id text, _currency text DEFAULT 'USD'::text, _currency_amount numeric DEFAULT NULL::numeric, _rate numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _o uuid := public._credit_actor(true);
  _id uuid;
  _bal numeric;
  _amt numeric := round(COALESCE(_amount, 0), 8);
  _ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  _eff_rate numeric;
  _eff_ccy_amt numeric;
BEGIN
  IF _amt <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  IF _shift_id IS NULL THEN RAISE EXCEPTION 'صرف الرصيد نقداً يتطلب وردية مفتوحة'; END IF;
  IF COALESCE(_operation_id,'') = '' THEN RAISE EXCEPTION 'معرّف العملية مطلوب'; END IF;

  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'صرف رصيد عميل');

  IF _ccy = 'USD' THEN
    _eff_rate := 1;
    _eff_ccy_amt := _amt;
  ELSE
    _eff_rate := COALESCE(_rate, (SELECT NULLIF((ss.exchange_rates->>_ccy)::numeric, 0) FROM public.store_settings ss WHERE ss.user_id = _o LIMIT 1));
    IF _eff_rate IS NULL OR _eff_rate <= 0 THEN
      RAISE EXCEPTION 'سعر صرف العملة % غير صالح', _ccy;
    END IF;
    _eff_ccy_amt := round(COALESCE(NULLIF(_currency_amount, 0), _amt * _eff_rate), 8);
    IF _eff_ccy_amt <= 0 THEN
      RAISE EXCEPTION 'مبلغ العملة % غير صالح', _ccy;
    END IF;
    IF _currency_amount IS NOT NULL AND _currency_amount > 0 THEN
      IF abs(_eff_ccy_amt - (_amount * _eff_rate)) > GREATEST(0.05, (_amount * _eff_rate) * 0.01) THEN
        RAISE EXCEPTION 'مبلغ العملة (%) لا يطابق القيمة المحوّلة (% × %)', _eff_ccy_amt, _amount, _eff_rate;
      END IF;
    END IF;
  END IF;

  PERFORM 1 FROM public.customers WHERE id=_customer_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'العميل غير موجود'; END IF;
  SELECT id INTO _id FROM public.customer_credit_ledger WHERE user_id=_o AND operation_id=_operation_id AND entry_type='payout';
  IF _id IS NOT NULL THEN RETURN _id; END IF;

  SELECT round(COALESCE(SUM(amount),0), 8) INTO _bal FROM public.customer_credit_ledger WHERE customer_id=_customer_id;
  IF _amt > _bal THEN RAISE EXCEPTION 'رصيد العميل (%) أقل من المبلغ المطلوب', round(_bal,2); END IF;

  PERFORM 1 FROM public.cash_shifts WHERE id=_shift_id AND user_id=_o AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'لا توجد وردية مفتوحة'; END IF;

  INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,reference_id,notes,currency,currency_amount,exchange_rate)
  VALUES (_shift_id,_o,'store_credit_refund',_amt,_operation_id,'صرف رصيد عميل نقداً',_ccy,_eff_ccy_amt,_eff_rate);

  UPDATE public.cash_shifts
     SET expected_balance = round(COALESCE(expected_balance, 0) - _amt, 8),
         updated_at = now()
   WHERE id = _shift_id AND user_id = _o AND closed_at IS NULL;

  INSERT INTO public.customer_credit_ledger(user_id,customer_id,entry_type,amount,shift_id,reason,operation_id,created_by)
  VALUES (_o,_customer_id,'payout',-_amt,_shift_id,'صرف رصيد نقداً',_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_store_credit_to_debt_atomic(_debt_id uuid, _amount numeric, _operation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _o uuid := public._credit_actor(false); _d public.debts%ROWTYPE; _bal numeric; _res jsonb; _existing uuid;
BEGIN
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  IF COALESCE(length(_operation_id),0) < 8 THEN RAISE EXCEPTION 'معرّف العملية غير صالح'; END IF;
  SELECT * INTO _d FROM public.debts WHERE id=_debt_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الدين غير موجود'; END IF;
  IF _d.customer_id IS NULL THEN RAISE EXCEPTION 'الدين غير مرتبط بعميل مسجّل'; END IF;
  PERFORM 1 FROM public.customers WHERE id=_d.customer_id FOR UPDATE;
  SELECT id INTO _existing FROM public.customer_credit_ledger WHERE user_id=_o AND operation_id=_operation_id AND entry_type='spend';
  IF _existing IS NOT NULL THEN RETURN jsonb_build_object('success',true,'already_processed',true); END IF;
  SELECT COALESCE(SUM(amount),0) INTO _bal FROM public.customer_credit_ledger WHERE customer_id=_d.customer_id;
  IF round(_amount, 8) > round(_bal, 8) THEN RAISE EXCEPTION 'رصيد العميل (%) أقل من المبلغ المطلوب', round(_bal,2); END IF;
  _res := public.record_debt_payment_atomic(_debt_id, _amount, 'credit:'||_operation_id, NULL, NULL, NULL, NULL, 'transfer');
  INSERT INTO public.customer_credit_ledger(user_id,customer_id,entry_type,amount,debt_id,reason,operation_id,created_by)
  VALUES (_o,_d.customer_id,'spend',-round(_amount,8),_debt_id,'تسديد دين من رصيد العميل',_operation_id,auth.uid());
  PERFORM public.recalc_customer_open_debt(_o,_d.customer_id);
  RETURN _res;
END $function$;
