-- Repo sync only: public._credit_actor(boolean), issue_store_credit_atomic, apply_store_credit_to_debt_atomic and set_customer_credit_limit_atomic already exist on the live database (md5 of the _credit_actor body b8bcbe0e509c22caf441908812c56363)
-- but supabase/migrations/20261120080000 only mentions them in a comment, so a database rebuilt from the repo failed every store-credit operation
-- ("function public._credit_actor(boolean) does not exist"). This file is an exact copy of the live definition; applying it live changes nothing.
CREATE OR REPLACE FUNCTION public._credit_actor(_need_refund boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _c uuid := auth.uid(); _o uuid;
BEGIN
  IF _c IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _o := public.get_owner_id(_c);
  IF _o IS NULL THEN RAISE EXCEPTION 'Owner context is required'; END IF;
  IF _need_refund AND NOT (public.is_store_owner(_c) OR public.can_refund_invoices(_c)) THEN
    RAISE EXCEPTION 'ليس لديك صلاحية التعامل مع رصيد العملاء' USING ERRCODE='42501';
  END IF;
  RETURN _o;
END $function$;

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
  VALUES (_o,_customer_id,'issue',round(_amount,4),_invoice_number,_reason,_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END $function$;

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
  _res := public.record_debt_payment_atomic(_debt_id, _amount, 'credit:'||_operation_id, NULL);
  INSERT INTO public.customer_credit_ledger(user_id,customer_id,entry_type,amount,debt_id,reason,operation_id,created_by)
  VALUES (_o,_d.customer_id,'spend',-round(_amount,4),_debt_id,'تسديد دين من رصيد العميل',_operation_id,auth.uid());
  PERFORM public.recalc_customer_open_debt(_o,_d.customer_id);
  RETURN _res;
END $function$;

CREATE OR REPLACE FUNCTION public.set_customer_credit_limit_atomic(_customer_id uuid, _limit numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _o uuid := public._credit_actor(false);
BEGIN
  IF NOT public.is_store_owner(auth.uid()) THEN RAISE EXCEPTION 'تحديد حد الائتمان لمالك المتجر ومديره فقط' USING ERRCODE='42501'; END IF;
  IF _limit IS NOT NULL AND _limit < 0 THEN RAISE EXCEPTION 'حد الائتمان لا يمكن أن يكون سالباً'; END IF;
  UPDATE public.customers SET credit_limit = _limit, updated_at = now() WHERE id=_customer_id AND user_id=_o;
  IF NOT FOUND THEN RAISE EXCEPTION 'العميل غير موجود'; END IF;
END $function$;
