-- FINANCE LAW F-17 / F-18 — KD-06: post a cash-sale drawer movement on the SERVER, idempotently, and keep
-- cash_shifts.expected_balance in step. Additive: a NEW function; process_pos_sale_atomic is not touched and the
-- current client path (direct shift_transactions insert) keeps working until the app is switched to this RPC.
--
--   _operation_id  = the sale's operation id (same value as invoices.operation_id) -> shift_transactions.reference_id
--   _amount_usd    = cash that entered the drawer, in USD
--   replay with the same (shift, operation id) is a no-op and returns already_processed = true
--   a replay whose amount differs is rejected (never silently ignored)
-- Apply manually after owner approval (AGENTS.md database rule).

CREATE OR REPLACE FUNCTION public.post_shift_sale_atomic(
  _shift_id uuid,
  _operation_id text,
  _amount_usd numeric,
  _currency text DEFAULT 'USD',
  _currency_amount numeric DEFAULT NULL,
  _exchange_rate numeric DEFAULT 1,
  _notes text DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_amount numeric := round(COALESCE(_amount_usd, 0), 4);
  v_ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  v_rate numeric;
  v_orig numeric;
  v_existing public.shift_transactions%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'المستخدم غير مسجل الدخول'; END IF;
  v_owner := public.get_owner_id(v_uid);
  IF v_owner IS NULL THEN RAISE EXCEPTION 'لم يتم العثور على حساب المالك'; END IF;
  IF _operation_id IS NULL OR length(_operation_id) < 8 THEN RAISE EXCEPTION 'رقم العملية غير صالح'; END IF;
  IF v_amount <= 0 OR v_amount::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'مبلغ البيع النقدي يجب أن يكون أكبر من الصفر';
  END IF;
  IF v_ccy = 'USD' THEN
    v_rate := 1; v_orig := round(v_amount, 2);
  ELSE
    v_rate := COALESCE(_exchange_rate, 0);
    IF v_rate <= 0 OR v_rate::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'سعر الصرف غير صالح'; END IF;
    v_orig := round(COALESCE(_currency_amount, v_amount * v_rate), 2);
  END IF;

  -- Same lock order as the other drawer RPCs: shift row first.
  PERFORM 1 FROM public.cash_shifts WHERE id = _shift_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الوردية غير موجودة أو لا تتبع لهذا المتجر'; END IF;

  SELECT * INTO v_existing FROM public.shift_transactions
   WHERE shift_id = _shift_id AND type = 'sale' AND reference_id = _operation_id;
  IF FOUND THEN
    IF abs(v_existing.amount - round(v_amount, 2)) > 0.01 THEN
      RAISE EXCEPTION 'تعارض في معرّف العملية (%): مبلغ مختلف عن الحركة المسجلة', _operation_id USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'amount', v_existing.amount);
  END IF;

  -- A sale can only be posted into an OPEN shift (a closed shift is immutable, F-20).
  PERFORM 1 FROM public.cash_shifts WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'الوردية مغلقة: لا يمكن ترحيل بيع نقدي إليها'; END IF;

  INSERT INTO public.shift_transactions (shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, notes, reference_id)
  VALUES (_shift_id, v_owner, 'sale', round(v_amount, 2), v_ccy, v_orig, v_rate, COALESCE(_notes, 'مبيعات نقدية'), _operation_id);

  UPDATE public.cash_shifts
     SET expected_balance = round(COALESCE(expected_balance, 0) + round(v_amount, 2), 2)
   WHERE id = _shift_id;

  RETURN jsonb_build_object('success', true, 'already_processed', false, 'amount', round(v_amount, 2));
END;
$function$;

REVOKE ALL ON FUNCTION public.post_shift_sale_atomic(uuid, text, numeric, text, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_shift_sale_atomic(uuid, text, numeric, text, numeric, numeric, text) TO authenticated;
