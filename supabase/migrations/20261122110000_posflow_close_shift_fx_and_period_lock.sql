-- =============================================================================
-- Migration: 20261122110000_posflow_close_shift_fx_and_period_lock.sql
-- Already applied to the live project as posflow_close_shift_fx_and_period_lock.
-- Verified in a rolled-back transaction: opening 100, sale 50, fx_in 20, fx_out 5,
-- counted 165 -> expected 165, variance 0 (before this fix the simplified path gave 150).
--
-- Changes to close_cash_shift_atomic:
--   1) Simplified (no per-currency counts) path now includes fx_in in inflows and
--      fx_out in outflows. The per-currency path already had them.
--   2) Writing variance entries (surplus/shortage) calls assert_period_open, so a
--      shift cannot post adjustments into a closed accounting period.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.close_cash_shift_atomic(_shift_id uuid, _actual_balance numeric, _variance_reason text DEFAULT NULL::text, _decision text DEFAULT 'accept'::text, _counts jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _shift record;
  _tol numeric := 1;
  _open jsonb;
  _codes text[];
  _c text; _stored_rate numeric; _rate numeric; _exp numeric; _cnt numeric; _var numeric; _var_usd numeric;
  _details jsonb := '[]'::jsonb;
  _tot_exp_usd numeric := 0; _tot_cnt_usd numeric := 0; _tot_var_usd numeric := 0;
  _beyond boolean := false;
  _inflow numeric := 0; _outflow numeric := 0; _calc_expected numeric := 0; _variance numeric := 0;
  _status text := 'matched'; _dec text := 'none'; _has_counts boolean := (_counts IS NOT NULL AND jsonb_typeof(_counts)='array' AND jsonb_array_length(_counts) > 0);
  _d jsonb;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  SELECT * INTO _shift FROM public.cash_shifts WHERE id = _shift_id AND user_id = _owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الوردية غير موجودة أو لا تتبع للمتجر'; END IF;
  IF _shift.closed_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'already_closed', true, 'shift_id', _shift_id);
  END IF;
  SELECT COALESCE(shift_variance_tolerance_usd, 1) INTO _tol FROM public.store_settings WHERE user_id = _owner LIMIT 1;
  _tol := COALESCE(_tol, 1);
  _open := COALESCE(_shift.opening_by_currency, jsonb_build_object('USD', COALESCE(_shift.opening_balance,0)));

  IF _has_counts THEN
    _codes := ARRAY(SELECT DISTINCT c FROM (
        SELECT jsonb_object_keys(_open) AS c
        UNION SELECT upper(COALESCE(currency,'USD')) FROM public.shift_transactions WHERE shift_id = _shift_id
        UNION SELECT upper(e->>'code') FROM jsonb_array_elements(_counts) e) s WHERE c IS NOT NULL);
    FOREACH _c IN ARRAY _codes LOOP
      _rate := NULLIF((SELECT (e->>'rate')::numeric FROM jsonb_array_elements(_counts) e WHERE upper(e->>'code') = _c LIMIT 1), 0);
      -- السعر المحفوظ في إعدادات المتجر (Supabase) له الأولوية على سعر العميل
      SELECT NULLIF((ss.exchange_rates->>_c)::numeric, 0) INTO _stored_rate FROM public.store_settings ss WHERE ss.user_id = (SELECT cs.user_id FROM public.cash_shifts cs WHERE cs.id = _shift_id) LIMIT 1;
      IF _stored_rate IS NOT NULL AND _stored_rate > 0 THEN _rate := _stored_rate; END IF;
      IF _c = 'USD' THEN _rate := 1; END IF;
      IF _rate IS NULL THEN
        SELECT exchange_rate INTO _rate FROM public.shift_transactions WHERE shift_id=_shift_id AND upper(COALESCE(currency,'USD'))=_c AND exchange_rate > 0 ORDER BY created_at DESC LIMIT 1;
      END IF;
      IF _rate IS NULL OR _rate <= 0 THEN RAISE EXCEPTION 'سعر صرف العملة % غير متوفر', _c; END IF;
      _exp := COALESCE((_open->>_c)::numeric, 0) + COALESCE((
        SELECT SUM(CASE
            WHEN type IN ('sale','deposit_capital','deposit_revenue','deposit_purchase_cover','debt_payment','surplus','expense_refund','supplier_refund','fx_in') THEN COALESCE(currency_amount, amount)
            WHEN type IN ('expense','refund','withdrawal','supplier_payment','store_credit_refund','shortage','fx_out') THEN -COALESCE(currency_amount, amount)
            ELSE 0 END)
        FROM public.shift_transactions WHERE shift_id = _shift_id AND upper(COALESCE(currency,'USD')) = _c), 0);
      _cnt := COALESCE((SELECT (e->>'counted')::numeric FROM jsonb_array_elements(_counts) e WHERE upper(e->>'code') = _c LIMIT 1), 0);
      _var := round(_cnt - _exp, 4);
      _var_usd := round(_var / _rate, 4);
      _tot_exp_usd := _tot_exp_usd + _exp / _rate; _tot_cnt_usd := _tot_cnt_usd + _cnt / _rate; _tot_var_usd := _tot_var_usd + _var_usd;
      IF abs(_var_usd) > _tol THEN _beyond := true; END IF;
      _details := _details || jsonb_build_object('code', _c, 'rate', _rate, 'expected', round(_exp,4), 'counted', round(_cnt,4), 'variance', _var, 'variance_usd', _var_usd);
    END LOOP;
    IF abs(_tot_var_usd) > _tol THEN _beyond := true; END IF;
    _calc_expected := round(_tot_exp_usd, 2);
    _variance := round(_tot_var_usd, 2);
  ELSE
    -- الحركات بالدولار في الوضع المبسط: تشمل تحويلات العملات (fx_in / fx_out) أيضاً
    SELECT COALESCE(SUM(amount),0) INTO _inflow FROM public.shift_transactions WHERE shift_id=_shift_id AND type IN ('sale','deposit_capital','deposit_revenue','deposit_purchase_cover','debt_payment','surplus','expense_refund','supplier_refund','fx_in');
    SELECT COALESCE(SUM(amount),0) INTO _outflow FROM public.shift_transactions WHERE shift_id=_shift_id AND type IN ('expense','refund','withdrawal','supplier_payment','store_credit_refund','shortage','fx_out');
    _calc_expected := round(COALESCE(_shift.opening_balance,0) + _inflow - _outflow, 2);
    _variance := round(COALESCE(_actual_balance,0) - _calc_expected, 2);
    _beyond := abs(_variance) > _tol;
    _details := jsonb_build_array(jsonb_build_object('code','USD','rate',1,'expected',_calc_expected,'counted',round(COALESCE(_actual_balance,0),2),'variance',_variance,'variance_usd',_variance));
  END IF;

  IF NOT _beyond THEN
    _dec := CASE WHEN abs(_variance) >= 0.01 OR _has_counts AND _tot_var_usd <> 0 THEN 'within_tolerance' ELSE 'none' END;
    _status := 'matched';
  ELSIF _decision = 'defer' THEN
    _dec := 'deferred'; _status := 'pending';
  ELSE
    _dec := 'accepted';
    _status := CASE WHEN _variance_reason IS NOT NULL AND length(trim(_variance_reason)) > 0 THEN 'matched' ELSE 'unmatched' END;
    -- لا تُكتب قيود فروق في فترة محاسبية مغلقة
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(_details) d WHERE (d->>'variance')::numeric <> 0) THEN
      PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'إقفال الوردية');
    END IF;
    FOR _d IN SELECT * FROM jsonb_array_elements(_details) LOOP
      IF (_d->>'variance')::numeric <> 0 THEN
        INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,currency,currency_amount,exchange_rate,notes,created_at)
        VALUES (_shift_id,_owner, CASE WHEN (_d->>'variance')::numeric > 0 THEN 'surplus' ELSE 'shortage' END,
                abs((_d->>'variance_usd')::numeric), _d->>'code', abs((_d->>'variance')::numeric), (_d->>'rate')::numeric,
                CASE WHEN (_d->>'variance')::numeric > 0 THEN 'فائض صندوق عند الإقفال: ' ELSE 'عجز صندوق عند الإقفال: ' END || COALESCE(_variance_reason,''), now());
      END IF;
    END LOOP;
  END IF;

  UPDATE public.cash_shifts SET closed_at = now(), expected_balance = _calc_expected,
         actual_balance = CASE WHEN _has_counts THEN round(_tot_cnt_usd,2) ELSE round(COALESCE(_actual_balance,0),2) END,
         variance = _variance, variance_reason = _variance_reason, reconciliation_status = _status,
         currency_counts = _details, variance_decision = _dec, updated_at = now()
   WHERE id = _shift_id;

  RETURN jsonb_build_object('success', true, 'shift_id', _shift_id, 'expected_balance', _calc_expected,
    'variance', _variance, 'status', _status, 'decision', _dec, 'tolerance_usd', _tol, 'currencies', _details);
END $function$;

NOTIFY pgrst, 'reload schema';
