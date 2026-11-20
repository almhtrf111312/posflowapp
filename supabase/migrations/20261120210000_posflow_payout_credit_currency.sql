DROP FUNCTION IF EXISTS public.payout_store_credit_atomic(uuid, numeric, uuid, text);
CREATE OR REPLACE FUNCTION public.payout_store_credit_atomic(_customer_id uuid, _amount numeric, _shift_id uuid, _operation_id text, _currency text DEFAULT 'USD', _currency_amount numeric DEFAULT NULL, _rate numeric DEFAULT NULL)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _o uuid := public._credit_actor(true); _id uuid; _bal numeric;
BEGIN
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  IF _shift_id IS NULL THEN RAISE EXCEPTION 'صرف الرصيد نقداً يتطلب وردية مفتوحة'; END IF;
  IF COALESCE(_operation_id,'') = '' THEN RAISE EXCEPTION 'معرّف العملية مطلوب'; END IF;
  PERFORM 1 FROM public.customers WHERE id=_customer_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'العميل غير موجود'; END IF;
  SELECT id INTO _id FROM public.customer_credit_ledger WHERE user_id=_o AND operation_id=_operation_id AND entry_type='payout';
  IF _id IS NOT NULL THEN RETURN _id; END IF;
  SELECT COALESCE(SUM(amount),0) INTO _bal FROM public.customer_credit_ledger WHERE customer_id=_customer_id;
  IF _amount > _bal + 0.0001 THEN RAISE EXCEPTION 'رصيد العميل (%) أقل من المبلغ المطلوب', round(_bal,2); END IF;
  PERFORM 1 FROM public.cash_shifts WHERE id=_shift_id AND user_id=_o AND closed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'لا توجد وردية مفتوحة'; END IF;
  INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,reference_id,notes,currency,currency_amount,exchange_rate)
  VALUES (_shift_id,_o,'store_credit_refund',round(_amount,4),_operation_id,'صرف رصيد عميل نقداً',upper(COALESCE(_currency,'USD')),round(COALESCE(_currency_amount,_amount),4),_rate);
  INSERT INTO public.customer_credit_ledger(user_id,customer_id,entry_type,amount,shift_id,reason,operation_id,created_by)
  VALUES (_o,_customer_id,'payout',-round(_amount,4),_shift_id,'صرف رصيد نقداً',_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END $function$;
GRANT EXECUTE ON FUNCTION public.payout_store_credit_atomic(uuid, numeric, uuid, text, text, numeric, numeric) TO authenticated;
