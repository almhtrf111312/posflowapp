-- Fix: paying a debt from the customer's store credit always failed with
-- "القبض النقدي يتطلب وردية أصلية، والتحويل لا يُرحّل إلى الصندوق".
-- apply_store_credit_to_debt_atomic called record_debt_payment_atomic with no shift and the default method 'cash'; since cash and
-- transfer receipts were separated, a cash receipt must carry a shift. Store credit is not drawer money, so the payment is recorded as a
-- non-drawer ('transfer') receipt: the debt goes down, the credit ledger goes down by the same amount, and the drawer is untouched (F-18).
-- Only the record_debt_payment_atomic call changes; everything else is the definition from 20261126010000 (identical to live).
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
  IF _amount > _bal + 0.0001 THEN RAISE EXCEPTION 'رصيد العميل (%) أقل من المبلغ المطلوب', round(_bal,2); END IF;
  _res := public.record_debt_payment_atomic(_debt_id, _amount, 'credit:'||_operation_id, NULL, NULL, NULL, NULL, 'transfer');
  INSERT INTO public.customer_credit_ledger(user_id,customer_id,entry_type,amount,debt_id,reason,operation_id,created_by)
  VALUES (_o,_d.customer_id,'spend',-round(_amount,4),_debt_id,'تسديد دين من رصيد العميل',_operation_id,auth.uid());
  PERFORM public.recalc_customer_open_debt(_o,_d.customer_id);
  RETURN _res;
END $function$;
