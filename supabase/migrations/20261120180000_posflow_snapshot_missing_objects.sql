-- Idempotent snapshot of live-DB objects that were applied via MCP but missing from earlier migration files.
CREATE TABLE IF NOT EXISTS public.partner_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, partner_id uuid NOT NULL, entry_type text,
  d_current_balance numeric DEFAULT 0, d_pending_profit numeric DEFAULT 0, d_confirmed_profit numeric DEFAULT 0,
  d_total_profit_earned numeric DEFAULT 0, d_total_withdrawn numeric DEFAULT 0, d_current_capital numeric DEFAULT 0,
  source text, reference text, actor uuid, txid bigint DEFAULT txid_current(), created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_partner_ledger_partner ON public.partner_ledger_entries (partner_id, created_at);
ALTER TABLE public.partner_ledger_entries ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='partner_ledger_entries' AND policyname='partner_ledger_select') THEN
    CREATE POLICY partner_ledger_select ON public.partner_ledger_entries FOR SELECT USING (user_id = get_owner_id(auth.uid()) AND is_store_owner(auth.uid()));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public._partner_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN RAISE EXCEPTION 'سجل الشركاء غير قابل للتعديل أو الحذف'; END $f$;
DROP TRIGGER IF EXISTS trg_partner_ledger_immutable ON public.partner_ledger_entries;
CREATE TRIGGER trg_partner_ledger_immutable BEFORE DELETE OR UPDATE ON public.partner_ledger_entries FOR EACH ROW EXECUTE FUNCTION public._partner_ledger_immutable();

CREATE OR REPLACE FUNCTION public._partner_ledger_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE _src text := COALESCE(NULLIF(current_setting('app.partner_source', true),''), NULLIF(current_setting('app.stock_source', true),''), TG_OP);
        _ref text := NULLIF(current_setting('app.partner_ref', true),'');
        _type text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.partner_ledger_entries(user_id,partner_id,entry_type,d_current_balance,d_pending_profit,d_confirmed_profit,d_total_profit_earned,d_total_withdrawn,d_current_capital,source,reference,actor)
    VALUES (NEW.user_id,NEW.id,'opening',COALESCE(NEW.current_balance,0),COALESCE(NEW.pending_profit,0),COALESCE(NEW.confirmed_profit,0),COALESCE(NEW.total_profit_earned,0),COALESCE(NEW.total_withdrawn,0),COALESCE(NEW.current_capital,0),_src,_ref,auth.uid());
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.current_balance,0)=COALESCE(OLD.current_balance,0) AND COALESCE(NEW.pending_profit,0)=COALESCE(OLD.pending_profit,0)
     AND COALESCE(NEW.confirmed_profit,0)=COALESCE(OLD.confirmed_profit,0) AND COALESCE(NEW.total_profit_earned,0)=COALESCE(OLD.total_profit_earned,0)
     AND COALESCE(NEW.total_withdrawn,0)=COALESCE(OLD.total_withdrawn,0) AND COALESCE(NEW.current_capital,0)=COALESCE(OLD.current_capital,0) THEN
    RETURN NEW;
  END IF;
  _type := CASE
    WHEN COALESCE(NEW.total_withdrawn,0) > COALESCE(OLD.total_withdrawn,0) THEN 'withdrawal'
    WHEN COALESCE(NEW.current_capital,0) <> COALESCE(OLD.current_capital,0) THEN 'capital'
    WHEN COALESCE(NEW.pending_profit,0) <> COALESCE(OLD.pending_profit,0) AND COALESCE(NEW.confirmed_profit,0) = COALESCE(OLD.confirmed_profit,0) THEN 'pending_profit'
    WHEN COALESCE(NEW.confirmed_profit,0) > COALESCE(OLD.confirmed_profit,0) THEN 'profit'
    WHEN COALESCE(NEW.confirmed_profit,0) < COALESCE(OLD.confirmed_profit,0) OR COALESCE(NEW.total_profit_earned,0) < COALESCE(OLD.total_profit_earned,0) THEN 'reversal'
    ELSE 'adjustment' END;
  INSERT INTO public.partner_ledger_entries(user_id,partner_id,entry_type,d_current_balance,d_pending_profit,d_confirmed_profit,d_total_profit_earned,d_total_withdrawn,d_current_capital,source,reference,actor)
  VALUES (NEW.user_id,NEW.id,_type,
    COALESCE(NEW.current_balance,0)-COALESCE(OLD.current_balance,0), COALESCE(NEW.pending_profit,0)-COALESCE(OLD.pending_profit,0),
    COALESCE(NEW.confirmed_profit,0)-COALESCE(OLD.confirmed_profit,0), COALESCE(NEW.total_profit_earned,0)-COALESCE(OLD.total_profit_earned,0),
    COALESCE(NEW.total_withdrawn,0)-COALESCE(OLD.total_withdrawn,0), COALESCE(NEW.current_capital,0)-COALESCE(OLD.current_capital,0),
    _src,_ref,auth.uid());
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_partner_ledger_capture ON public.partners;
CREATE TRIGGER trg_partner_ledger_capture AFTER INSERT OR UPDATE ON public.partners FOR EACH ROW EXECUTE FUNCTION public._partner_ledger_capture();

CREATE OR REPLACE VIEW public.partner_ledger_reconciliation AS
 SELECT p.id AS partner_id, p.user_id, p.name, p.current_balance, COALESCE(sum(l.d_current_balance),0::numeric) AS ledger_balance,
    p.pending_profit, COALESCE(sum(l.d_pending_profit),0::numeric) AS ledger_pending,
    p.confirmed_profit, COALESCE(sum(l.d_confirmed_profit),0::numeric) AS ledger_confirmed,
    p.total_withdrawn, COALESCE(sum(l.d_total_withdrawn),0::numeric) AS ledger_withdrawn,
    (abs(COALESCE(p.current_balance,0::numeric)-COALESCE(sum(l.d_current_balance),0::numeric))>0.01 OR abs(COALESCE(p.pending_profit,0::numeric)-COALESCE(sum(l.d_pending_profit),0::numeric))>0.01
     OR abs(COALESCE(p.confirmed_profit,0::numeric)-COALESCE(sum(l.d_confirmed_profit),0::numeric))>0.01 OR abs(COALESCE(p.total_withdrawn,0::numeric)-COALESCE(sum(l.d_total_withdrawn),0::numeric))>0.01) AS mismatch
   FROM public.partners p LEFT JOIN public.partner_ledger_entries l ON l.partner_id = p.id GROUP BY p.id;

CREATE OR REPLACE FUNCTION public._split_reversal_by_category(_rec jsonb, _history jsonb, _invoice_number text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public' AS $f$
DECLARE _tot numeric := 0; _out jsonb := '[]'::jsonb; _x record; _w numeric; _n int := 0; _cnt int;
BEGIN
  SELECT COALESCE(SUM(ABS(COALESCE((x->>'amount')::numeric,0))),0), COUNT(DISTINCT COALESCE(NULLIF(x->>'category',''),'-')) INTO _tot, _cnt
    FROM jsonb_array_elements(COALESCE(_history,'[]'::jsonb)) x
   WHERE x->>'invoiceId' = _invoice_number AND COALESCE((x->>'isReversal')::boolean,false)=false AND COALESCE((x->>'isRelease')::boolean,false)=false
     AND COALESCE(x->>'id','') NOT LIKE '%-rel' AND COALESCE(x->>'category','') <> 'تحرير دفعة دين';
  IF _tot = 0 THEN RETURN jsonb_build_array(_rec); END IF;
  FOR _x IN
    SELECT COALESCE(NULLIF(x->>'category',''),'مرتجع فاتورة') cat, SUM(ABS(COALESCE((x->>'amount')::numeric,0))) amt
      FROM jsonb_array_elements(COALESCE(_history,'[]'::jsonb)) x
     WHERE x->>'invoiceId' = _invoice_number AND COALESCE((x->>'isReversal')::boolean,false)=false AND COALESCE((x->>'isRelease')::boolean,false)=false
       AND COALESCE(x->>'id','') NOT LIKE '%-rel' AND COALESCE(x->>'category','') <> 'تحرير دفعة دين' GROUP BY 1
  LOOP
    _w := _x.amt / _tot; _n := _n + 1;
    _out := _out || jsonb_build_array(_rec || jsonb_build_object('id', (_rec->>'id')||'-'||_n::text, 'category', _x.cat,
           'amount', round((_rec->>'amount')::numeric * _w, 8),
           'pendingReverted', round(COALESCE((_rec->>'pendingReverted')::numeric,0) * _w, 8),
           'confirmedReverted', round(COALESCE((_rec->>'confirmedReverted')::numeric,0) * _w, 8)));
  END LOOP;
  RETURN _out;
END $f$;

CREATE OR REPLACE FUNCTION public.record_shift_fx_atomic(_shift_id uuid, _from_ccy text, _from_amount numeric, _from_usd numeric, _to_ccy text, _to_amount numeric, _to_usd numeric, _operation_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE _c uuid := auth.uid(); _o uuid;
BEGIN
  IF _c IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _o := public.get_owner_id(_c);
  IF _o IS NULL THEN RAISE EXCEPTION 'Owner context is required'; END IF;
  IF COALESCE(length(_operation_id),0) < 8 THEN RAISE EXCEPTION 'معرّف العملية غير صالح'; END IF;
  IF COALESCE(_from_ccy,'') = '' OR COALESCE(_to_ccy,'') = '' OR upper(_from_ccy) = upper(_to_ccy) THEN RAISE EXCEPTION 'اختر عملتين مختلفتين'; END IF;
  IF COALESCE(_from_amount,0) <= 0 OR COALESCE(_to_amount,0) <= 0 OR COALESCE(_from_usd,0) <= 0 OR COALESCE(_to_usd,0) <= 0 THEN RAISE EXCEPTION 'المبالغ يجب أن تكون أكبر من الصفر'; END IF;
  PERFORM 1 FROM public.cash_shifts WHERE id=_shift_id AND user_id=_o AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'لا توجد وردية مفتوحة'; END IF;
  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'تحويل عملة في الوردية');
  INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,reference_id,notes,currency,currency_amount,exchange_rate)
  VALUES (_shift_id,_o,'fx_out',round(_from_usd,4),_operation_id,'تحويل عملة (خارج)',upper(_from_ccy),round(_from_amount,4),round(_from_amount/_from_usd,8))
  ON CONFLICT (shift_id,type,reference_id) DO NOTHING;
  INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,reference_id,notes,currency,currency_amount,exchange_rate)
  VALUES (_shift_id,_o,'fx_in',round(_to_usd,4),_operation_id,'تحويل عملة (داخل)',upper(_to_ccy),round(_to_amount,4),round(_to_amount/_to_usd,8))
  ON CONFLICT (shift_id,type,reference_id) DO NOTHING;
END $f$;

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS payment_method text DEFAULT 'cash';
CREATE OR REPLACE FUNCTION public.mark_invoice_digital(_invoice_number text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE _n int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  UPDATE public.invoices SET payment_method = 'digital' WHERE invoice_number = _invoice_number AND user_id = auth.uid() AND payment_method <> 'digital';
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n > 0;
END $f$;

CREATE OR REPLACE FUNCTION public.close_cash_shift_atomic(_shift_id uuid, _actual_balance numeric, _variance_reason text DEFAULT NULL::text, _decision text DEFAULT 'accept'::text, _counts jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _shift record; _tol numeric := 1; _open jsonb; _codes text[];
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
    SELECT COALESCE(SUM(amount),0) INTO _inflow FROM public.shift_transactions WHERE shift_id=_shift_id AND type IN ('sale','deposit_capital','deposit_revenue','deposit_purchase_cover','debt_payment','surplus','expense_refund','supplier_refund');
    SELECT COALESCE(SUM(amount),0) INTO _outflow FROM public.shift_transactions WHERE shift_id=_shift_id AND type IN ('expense','refund','withdrawal','supplier_payment','store_credit_refund','shortage');
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
