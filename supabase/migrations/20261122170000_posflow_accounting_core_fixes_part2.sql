-- =============================================================================
-- Migration: 20261122170000_posflow_accounting_core_fixes_part2.sql
-- Scope: Partners, Cash Shifts, Expenses, Period Closures, Integrity Core,
--        Supplier Linking & Stock Damage Hardening
-- =============================================================================

CREATE OR REPLACE FUNCTION public.partner_deposit_atomic(_partner_id uuid, _amount_usd numeric, _deposit_target text DEFAULT 'capital'::text, _notes text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT 'USD'::text, _original_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT 1.0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _owner uuid;
  _partner record;
  _tx_id text := gen_random_uuid()::text;
  _amt_usd numeric := round(COALESCE(_amount_usd, 0), 2);
  _ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  _orig_amt numeric;
  _rate numeric;
  _cap_record jsonb;
  _tx_note text;
BEGIN
  PERFORM set_config('app.partner_source', 'partner_deposit_atomic', true);
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير مسجل الدخول';
  END IF;

  IF NOT public.is_store_owner(_uid) THEN
    RAISE EXCEPTION 'هذه العملية مخصصة لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'لم يتم العثور على حساب المالك';
  END IF;

  IF _deposit_target NOT IN ('capital', 'balance') THEN
    RAISE EXCEPTION 'وجهة الإيداع غير صالحة: %', COALESCE(_deposit_target, 'NULL');
  END IF;

  IF _amt_usd <= 0 THEN
    RAISE EXCEPTION 'مبلغ الإيداع يجب أن يكون أكبر من الصفر';
  END IF;

  IF _ccy = 'USD' THEN
    _rate := 1.0;
    _orig_amt := _amt_usd;
  ELSE
    _rate := COALESCE(_exchange_rate, 0);
    IF _rate <= 0 THEN
      RAISE EXCEPTION 'سعر الصرف غير صالح';
    END IF;
    _orig_amt := round(COALESCE(_original_amount, _amt_usd * _rate), 2);
    IF _orig_amt <= 0 THEN
      RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
    END IF;
  END IF;

  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'إيداع شريك');

  SELECT * INTO _partner
  FROM public.partners
  WHERE id = _partner_id AND user_id = _owner
  FOR UPDATE;

  IF _partner IS NULL THEN
    RAISE EXCEPTION 'الشريك غير موجود أو غير تابع لهذا المتجر';
  END IF;

  IF _shift_id IS NOT NULL THEN
    PERFORM 1 FROM public.cash_shifts
    WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
    END IF;
  END IF;

  _tx_note := COALESCE(_notes, CASE WHEN _deposit_target = 'balance' THEN 'إيداع رصيد للشريك' ELSE 'إيداع رأس مال' END);
  IF _ccy <> 'USD' AND _orig_amt IS NOT NULL THEN
    _tx_note := _tx_note || ' (' || _orig_amt::text || ' ' || _ccy || ')';
  END IF;

  _cap_record := jsonb_build_object(
    'id', _tx_id,
    'amount', _amt_usd,
    'type', 'deposit',
    'target', _deposit_target,
    'currency', _ccy,
    'originalAmount', _orig_amt,
    'exchangeRate', _rate,
    'date', now(),
    'notes', _tx_note
  );

  IF _deposit_target = 'balance' THEN
    UPDATE public.partners SET
      current_balance = round(COALESCE(current_balance, 0) + _amt_usd, 2),
      capital_history = COALESCE(capital_history, '[]'::jsonb) || _cap_record,
      updated_at = now()
    WHERE id = _partner_id;
  ELSE
    UPDATE public.partners SET
      initial_capital = round(COALESCE(initial_capital, 0) + _amt_usd, 2),
      current_capital = round(COALESCE(current_capital, 0) + _amt_usd, 2),
      capital_history = COALESCE(capital_history, '[]'::jsonb) || _cap_record,
      updated_at = now()
    WHERE id = _partner_id;
  END IF;

  IF _shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions (
      shift_id, user_id, type, amount, currency_amount, currency, exchange_rate, notes, reference_id
    ) VALUES (
      _shift_id, _owner, 'deposit_capital', _amt_usd, _orig_amt, _ccy, _rate,
      _tx_note || ' - الشريك: ' || _partner.name,
      _partner_id::text || ':' || gen_random_uuid()::text
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'partner_id', _partner_id,
    'amount_usd', _amt_usd,
    'currency', _ccy,
    'original_amount', _orig_amt,
    'deposit_target', _deposit_target,
    'new_balance', CASE WHEN _deposit_target = 'balance' THEN round(COALESCE(_partner.current_balance, 0) + _amt_usd, 2) ELSE _partner.current_balance END,
    'new_capital', CASE WHEN _deposit_target = 'capital' THEN round(COALESCE(_partner.current_capital, 0) + _amt_usd, 2) ELSE _partner.current_capital END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_withdrawal_atomic(_partner_id uuid, _amount numeric, _withdrawal_type text, _notes text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT 'USD'::text, _original_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT 1.0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_owner uuid := public.get_owner_id(v_caller);
  v_partner public.partners%ROWTYPE;
  v_amt numeric := round(COALESCE(_amount, 0)::numeric, 2);
  v_ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  v_orig_amt numeric;
  v_rate numeric;
  v_withdrawal_record jsonb;
  v_capital_record jsonb;
  v_note_text text;
BEGIN
  PERFORM set_config('app.partner_source', 'partner_withdrawal_atomic', true);
  IF v_caller IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(v_caller) THEN
    RAISE EXCEPTION 'هذه العملية مخصصة لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  IF v_amt <= 0 THEN
    RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر';
  END IF;

  IF v_ccy = 'USD' THEN
    v_rate := 1.0;
    v_orig_amt := v_amt;
  ELSE
    v_rate := COALESCE(_exchange_rate, 0);
    IF v_rate <= 0 THEN
      RAISE EXCEPTION 'سعر الصرف غير صالح';
    END IF;
    v_orig_amt := round(COALESCE(_original_amount, v_amt * v_rate), 2);
    IF v_orig_amt <= 0 THEN
      RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
    END IF;
  END IF;

  PERFORM public.assert_period_open(v_owner, CURRENT_DATE, 'سحب شريك');

  SELECT * INTO v_partner FROM public.partners WHERE id = _partner_id FOR UPDATE;
  IF NOT FOUND OR v_partner.user_id <> v_owner THEN
    RAISE EXCEPTION 'الشريك غير موجود أو غير تابع للمتجر';
  END IF;

  IF _shift_id IS NOT NULL THEN
    PERFORM 1 FROM public.cash_shifts
    WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
    END IF;
  END IF;

  v_note_text := COALESCE(_notes, '');
  IF v_ccy <> 'USD' AND v_orig_amt IS NOT NULL THEN
    v_note_text := v_note_text || ' (' || v_orig_amt::text || ' ' || v_ccy || ')';
  END IF;

  v_withdrawal_record := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'amount', v_amt,
    'currency', v_ccy,
    'originalAmount', v_orig_amt,
    'exchangeRate', v_rate,
    'type', _withdrawal_type,
    'date', now()::text,
    'notes', v_note_text
  );

  IF _withdrawal_type = 'profit' THEN
    IF v_amt > COALESCE(v_partner.current_balance, 0) THEN
      RAISE EXCEPTION 'رصيد أرباح الشريك لا يكفي (المتاح: %)', v_partner.current_balance;
    END IF;

    UPDATE public.partners
       SET current_balance = round(current_balance - v_amt, 2),
           total_withdrawn = round(COALESCE(total_withdrawn, 0) + v_amt, 2),
           withdrawal_history = COALESCE(withdrawal_history, '[]'::jsonb) || v_withdrawal_record,
           updated_at = now()
     WHERE id = _partner_id;

  ELSIF _withdrawal_type = 'capital' THEN
    IF v_amt > COALESCE(v_partner.current_capital, 0) THEN
      RAISE EXCEPTION 'رأس مال الشريك لا يكفي (المتاح: %)', v_partner.current_capital;
    END IF;

    v_capital_record := jsonb_build_object(
      'id', gen_random_uuid()::text || '_cap',
      'amount', v_amt,
      'currency', v_ccy,
      'originalAmount', v_orig_amt,
      'exchangeRate', v_rate,
      'type', 'withdrawal',
      'date', now()::text,
      'notes', v_note_text
    );

    UPDATE public.partners
       SET current_capital = round(current_capital - v_amt, 2),
           total_withdrawn = round(COALESCE(total_withdrawn, 0) + v_amt, 2),
           withdrawal_history = COALESCE(withdrawal_history, '[]'::jsonb) || v_withdrawal_record,
           capital_history = COALESCE(capital_history, '[]'::jsonb) || v_capital_record,
           updated_at = now()
     WHERE id = _partner_id;
  ELSE
    RAISE EXCEPTION 'نوع السحب غير صالح: %', _withdrawal_type;
  END IF;

  IF _shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions (
      shift_id, user_id, type, amount, currency_amount, currency, exchange_rate, notes, reference_id
    ) VALUES (
      _shift_id, v_owner, 'withdrawal', v_amt, v_orig_amt, v_ccy, v_rate,
      'سحب ' || CASE WHEN _withdrawal_type = 'capital' THEN 'رأس مال' ELSE 'أرباح' END || ' للشريك: ' || v_partner.name || CASE WHEN v_note_text <> '' THEN ' - ' || v_note_text ELSE '' END,
      _partner_id::text || ':' || gen_random_uuid()::text
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'partner_id', _partner_id,
    'amount', v_amt,
    'currency', v_ccy,
    'original_amount', v_orig_amt,
    'withdrawal_type', _withdrawal_type,
    'new_balance', CASE WHEN _withdrawal_type = 'profit' THEN round(v_partner.current_balance - v_amt, 2) ELSE v_partner.current_balance END,
    'new_capital', CASE WHEN _withdrawal_type = 'capital' THEN round(v_partner.current_capital - v_amt, 2) ELSE v_partner.current_capital END
  );
END;
$function$;

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
      SELECT NULLIF((ss.exchange_rates->>_c)::numeric, 0) INTO _stored_rate FROM public.store_settings ss WHERE ss.user_id = (SELECT cs.user_id FROM public.cash_shifts cs WHERE cs.id = _shift_id) LIMIT 1;
      IF _stored_rate IS NOT NULL AND _stored_rate > 0 THEN _rate := _stored_rate; END IF;
      IF _c = 'USD' THEN _rate := 1; END IF;
      IF _rate IS NULL THEN
        SELECT exchange_rate INTO _rate FROM public.shift_transactions WHERE shift_id=_shift_id AND upper(COALESCE(currency,'USD'))=_c AND exchange_rate > 0 ORDER BY created_at DESC LIMIT 1;
      END IF;
      IF _rate IS NULL OR _rate <= 0 THEN RAISE EXCEPTION 'سعر صرف العملة % غير متوفر', _c; END IF;
      _exp := COALESCE((_open->>_c)::numeric, 0) + COALESCE((
        SELECT SUM(CASE
            WHEN type IN ('sale','deposit','deposit_capital','deposit_revenue','deposit_purchase_cover','debt_payment','surplus','expense_refund','supplier_refund','fx_in','transfer_in') THEN COALESCE(currency_amount, amount)
            WHEN type IN ('expense','refund','withdrawal','supplier_payment','store_credit_refund','shortage','fx_out','transfer_out') THEN -COALESCE(currency_amount, amount)
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
    SELECT COALESCE(SUM(amount),0) INTO _inflow FROM public.shift_transactions WHERE shift_id=_shift_id AND type IN ('sale','deposit','deposit_capital','deposit_revenue','deposit_purchase_cover','debt_payment','surplus','expense_refund','supplier_refund','fx_in','transfer_in');
    SELECT COALESCE(SUM(amount),0) INTO _outflow FROM public.shift_transactions WHERE shift_id=_shift_id AND type IN ('expense','refund','withdrawal','supplier_payment','store_credit_refund','shortage','fx_out','transfer_out');
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

CREATE OR REPLACE FUNCTION public.distribute_invoice_partner_profits_atomic(_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE;
  _owner uuid;
  _is_debt boolean;
  _cat_profit record;
  _remaining_profit numeric;
  _partner record;
  _partner_share numeric;
  _cat_share jsonb;
  _pct numeric;
  _profit_record jsonb;
  _pending_detail jsonb;
  _total_distributed numeric := 0;
  _distributions jsonb := '[]'::jsonb;
BEGIN
  PERFORM set_config('app.partner_source', 'distribute_invoice_partner_profits_atomic', true);
  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  _owner := _inv.user_id;

  IF auth.uid() IS NOT NULL AND public.get_owner_id(auth.uid()) IS DISTINCT FROM _owner THEN
    RAISE EXCEPTION 'غير مصرح' USING ERRCODE = '42501';
  END IF;
  _is_debt := (_inv.payment_type = 'debt' AND COALESCE(_inv.debt_remaining, 0) > 0);

  IF EXISTS (
    SELECT 1 FROM public.partners p,
    jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb)) ph
    WHERE p.user_id = _owner AND ph->>'invoiceId' = _inv.invoice_number
  ) THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'invoice_number', _inv.invoice_number);
  END IF;

  IF COALESCE(_inv.created_at, now()) < now() - interval '1 hour' THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'invoice_number', _inv.invoice_number, 'skipped', 'stale_invoice');
  END IF;

  FOR _cat_profit IN
    SELECT
      COALESCE(NULLIF(trim(p.category), ''), 'عام') AS category_name,
      round(SUM(COALESCE(ii.profit, 0)), 8) AS total_category_profit
    FROM public.invoice_items ii
    LEFT JOIN public.products p ON p.id = ii.product_id AND p.user_id = _owner
    WHERE ii.invoice_id = _invoice_id
    GROUP BY COALESCE(NULLIF(trim(p.category), ''), 'عام')
    HAVING SUM(COALESCE(ii.profit, 0)) <> 0
  LOOP
    _remaining_profit := _cat_profit.total_category_profit;

    FOR _partner IN
      SELECT * FROM public.partners
      WHERE user_id = _owner
        AND COALESCE(access_all, false) = false
        AND category_shares IS NOT NULL
      FOR UPDATE
    LOOP
      SELECT cs INTO _cat_share
      FROM jsonb_array_elements(_partner.category_shares) cs
      WHERE (cs->>'enabled')::boolean = true
        AND cs->>'categoryName' = _cat_profit.category_name
      LIMIT 1;

      IF _cat_share IS NOT NULL AND COALESCE((_cat_share->>'percentage')::numeric, 0) > 0 THEN
        _pct := (_cat_share->>'percentage')::numeric;
        _partner_share := round((_cat_profit.total_category_profit * _pct / 100.0), 4);

        IF _partner_share <> 0 THEN
          _remaining_profit := _remaining_profit - _partner_share;
          _total_distributed := _total_distributed + _partner_share;

          _profit_record := jsonb_build_object(
            'id', extract(epoch from now())::text || _partner.id::text || _cat_profit.category_name,
            'invoiceId', _inv.invoice_number,
            'amount', _partner_share,
            'category', _cat_profit.category_name,
            'isDebt', _is_debt,
            'createdAt', now()
          );

          IF _is_debt THEN
            _pending_detail := jsonb_build_object(
              'invoiceId', _inv.invoice_number,
              'amount', _partner_share,
              'customerName', COALESCE(_inv.customer_name, 'عميل بيع مؤجل'),
              'createdAt', now()
            );

            UPDATE public.partners SET
              pending_profit = round(COALESCE(pending_profit, 0) + _partner_share, 4),
              pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || _pending_detail,
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          ELSE
            UPDATE public.partners SET
              confirmed_profit = round(COALESCE(confirmed_profit, 0) + _partner_share, 4),
              current_balance = round(COALESCE(current_balance, 0) + _partner_share, 4),
              total_profit_earned = round(COALESCE(total_profit_earned, 0) + _partner_share, 4),
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          END IF;

          _distributions := _distributions || jsonb_build_object(
            'partnerId', _partner.id,
            'partnerName', _partner.name,
            'amount', _partner_share,
            'category', _cat_profit.category_name
          );
        END IF;
      END IF;
    END LOOP;

    IF (_cat_profit.total_category_profit > 0 AND _remaining_profit > 0)
       OR (_cat_profit.total_category_profit < 0 AND _remaining_profit < 0) THEN
      FOR _partner IN
        SELECT * FROM public.partners
        WHERE user_id = _owner
          AND COALESCE(access_all, false) = true
          AND COALESCE(share_percentage, 0) > 0
        FOR UPDATE
      LOOP
        _partner_share := round((_remaining_profit * _partner.share_percentage / 100.0), 4);

        IF _partner_share <> 0 THEN
          _total_distributed := _total_distributed + _partner_share;

          _profit_record := jsonb_build_object(
            'id', extract(epoch from now())::text || _partner.id::text || _cat_profit.category_name,
            'invoiceId', _inv.invoice_number,
            'amount', _partner_share,
            'category', _cat_profit.category_name,
            'isDebt', _is_debt,
            'createdAt', now()
          );

          IF _is_debt THEN
            _pending_detail := jsonb_build_object(
              'invoiceId', _inv.invoice_number,
              'amount', _partner_share,
              'customerName', COALESCE(_inv.customer_name, 'عميل بيع مؤجل'),
              'createdAt', now()
            );

            UPDATE public.partners SET
              pending_profit = round(COALESCE(pending_profit, 0) + _partner_share, 4),
              pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || _pending_detail,
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          ELSE
            UPDATE public.partners SET
              confirmed_profit = round(COALESCE(confirmed_profit, 0) + _partner_share, 4),
              current_balance = round(COALESCE(current_balance, 0) + _partner_share, 4),
              total_profit_earned = round(COALESCE(total_profit_earned, 0) + _partner_share, 4),
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          END IF;

          _distributions := _distributions || jsonb_build_object(
            'partnerId', _partner.id,
            'partnerName', _partner.name,
            'amount', _partner_share,
            'category', _cat_profit.category_name
          );
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', _invoice_id,
    'total_distributed', _total_distributed,
    'distributions', _distributions
  );
END;
$function$;

REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.partner_ledger_entries FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.delete_expense_atomic(_expense_id uuid, _reason text DEFAULT 'إلغاء مصروف'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _exp public.expenses%ROWTYPE;
  _item jsonb;
  _partner_id uuid;
  _part_amount numeric;
  _active_shift_id uuid;
  _orig_tx record;
BEGIN
  PERFORM set_config('app.partner_source', 'delete_expense_atomic', true);
  IF _caller IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  SELECT * INTO _exp FROM public.expenses WHERE id = _expense_id AND user_id = _owner FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'المصروف غير موجود');
  END IF;

  IF COALESCE(_exp.is_reversed, false) = true THEN
    RETURN jsonb_build_object('success', true, 'already_reversed', true);
  END IF;

  PERFORM public.assert_period_open(_owner, _exp.date, 'حذف المصروف');

  IF _exp.distributions IS NOT NULL AND jsonb_array_length(_exp.distributions) > 0 THEN
    FOR _item IN SELECT * FROM jsonb_array_elements(_exp.distributions) LOOP
      _partner_id := (_item->>'partnerId')::uuid;
      _part_amount := COALESCE((_item->>'amount')::numeric, 0);

      IF _partner_id IS NOT NULL AND _part_amount > 0 THEN
        UPDATE public.partners SET
          current_balance = round(COALESCE(current_balance, 0) + _part_amount, 2),
          expense_history = (
            SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
            FROM jsonb_array_elements(COALESCE(expense_history, '[]'::jsonb)) elem
            WHERE elem->>'expenseId' <> _expense_id::text
          ),
          updated_at = now()
        WHERE id = _partner_id AND user_id = _owner;
      END IF;
    END LOOP;
  END IF;

  SELECT st.amount, st.currency, st.currency_amount, st.exchange_rate
    INTO _orig_tx
    FROM public.shift_transactions st
   WHERE st.user_id = _owner
     AND st.type = 'expense'
     AND st.reference_id = _expense_id::text
   ORDER BY st.created_at DESC
   LIMIT 1;

  IF FOUND THEN
    SELECT id INTO _active_shift_id
    FROM public.cash_shifts
    WHERE user_id = _owner
      AND closed_at IS NULL
    ORDER BY opened_at DESC
    LIMIT 1
    FOR UPDATE;

    IF _active_shift_id IS NOT NULL THEN
      INSERT INTO public.shift_transactions(
        shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes
      ) VALUES (
        _active_shift_id, _owner, 'expense_refund',
        COALESCE(_orig_tx.amount, _exp.amount),
        COALESCE(_orig_tx.currency, 'USD'),
        COALESCE(_orig_tx.currency_amount, _orig_tx.amount, _exp.amount),
        COALESCE(_orig_tx.exchange_rate, 1),
        _expense_id::text,
        'إلغاء واسترجاع مصروف: ' || COALESCE(_reason, '')
      )
      ON CONFLICT (shift_id, type, reference_id) DO NOTHING;
    END IF;
  END IF;

  UPDATE public.expenses SET
    is_reversed = true,
    reversed_at = now(),
    reversed_by = _caller,
    reversed_reason = _reason
  WHERE id = _expense_id;

  RETURN jsonb_build_object('success', true, 'expense_id', _expense_id, 'amount', _exp.amount, 'expense_type', _exp.expense_type);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_expense_atomic(p_expense_id uuid, p_reason text DEFAULT 'تراجع بواسطة المستخدم'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_res jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'يجب تسجيل الدخول أولاً');
  END IF;

  v_res := public.delete_expense_atomic(p_expense_id, p_reason);

  IF COALESCE((v_res->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object('success', false, 'message', COALESCE(v_res->>'error', 'تعذر التراجع عن المصروف'));
  END IF;

  IF COALESCE((v_res->>'already_reversed')::boolean, false) = true THEN
    RETURN jsonb_build_object('success', false, 'message', 'تم التراجع عن هذا المصروف مسبقاً');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'amount', (v_res->>'amount')::numeric,
    'expense_type', v_res->>'expense_type',
    'message', 'تم التراجع عن المصروف بنجاح'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.add_expense_atomic(_operation_id text, _expense_type text, _amount numeric, _description text DEFAULT NULL::text, _date date DEFAULT CURRENT_DATE, _notes text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _owner uuid;
  _op_uuid uuid;
  _amt numeric := round(coalesce(_amount, 0), 2);
  _dist jsonb := '[]'::jsonb;
  p record;
  _pct numeric;
  _part numeric;
BEGIN
  PERFORM set_config('app.partner_source', 'add_expense_atomic', true);
  IF _uid IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF _amt <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;

  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN RAISE EXCEPTION 'لم يتم العثور على حساب المالك'; END IF;

  PERFORM public.assert_period_open(_owner, COALESCE(_date, CURRENT_DATE), 'تسجيل مصروف');

  IF NULLIF(trim(COALESCE(_operation_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'معرّف العملية مطلوب';
  END IF;

  BEGIN
    _op_uuid := trim(_operation_id)::uuid;
  EXCEPTION WHEN OTHERS THEN
    _op_uuid := md5(_owner::text || ':expense:' || trim(_operation_id))::uuid;
  END;

  IF EXISTS (SELECT 1 FROM public.expenses WHERE id = _op_uuid) THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'id', _op_uuid);
  END IF;

  FOR p IN
    SELECT * FROM public.partners
    WHERE user_id = _owner
    FOR UPDATE
  LOOP
    _pct := coalesce(p.expense_share_percentage, p.share_percentage, 0);

    IF _pct > 0 THEN
      _part := round(_amt * (_pct / 100.0), 2);

      IF _part > 0 THEN
        _dist := _dist || jsonb_build_object(
          'partnerId', p.id,
          'partnerName', p.name,
          'amount', _part,
          'percentage', _pct
        );

        UPDATE public.partners SET
          current_balance = round(coalesce(current_balance, 0) - _part, 2),
          expense_history = coalesce(expense_history, '[]'::jsonb) || jsonb_build_object(
            'expenseId', _op_uuid::text,
            'type', _expense_type,
            'amount', _part,
            'date', coalesce(_date, CURRENT_DATE),
            'notes', coalesce(_notes, _description, ''),
            'createdAt', now()
          ),
          updated_at = now()
        WHERE id = p.id;
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.expenses(
    id, user_id, expense_type, amount, description, date, notes, distributions, cashier_id
  ) VALUES (
    _op_uuid, _owner, _expense_type, _amt, _description, coalesce(_date, CURRENT_DATE), _notes, _dist, _uid
  );

  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'id', _op_uuid,
    'distributions', _dist
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.close_accounting_period_atomic(_period_start date, _period_end date, _timezone text DEFAULT 'UTC'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _tz text := COALESCE(NULLIF(trim(_timezone), ''), 'UTC');
  _rev numeric := 0;
  _cogs numeric := 0;
  _exp numeric := 0;
  _gross numeric := 0;
  _realized numeric := 0;
  _pending numeric := 0;
  _bad_debt numeric := 0;
  _net numeric := 0;
  _partner_summary jsonb := '[]'::jsonb;
  _closure_id uuid;
  p record;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'إقفال الفترة مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  BEGIN
    PERFORM now() AT TIME ZONE _tz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'المنطقة الزمنية غير صحيحة: %', _tz;
  END;

  IF _period_start IS NULL OR _period_end IS NULL OR _period_start > _period_end THEN
    RAISE EXCEPTION 'تواريخ الفترة غير صحيحة';
  END IF;
  IF _period_end >= (now() AT TIME ZONE _tz)::date THEN
    RAISE EXCEPTION 'لا يمكن إقفال فترة لم تنتهِ بعد';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('close_accounting_period:' || _owner::text));

  IF EXISTS (
    SELECT 1 FROM public.accounting_period_closures c
    WHERE c.user_id = _owner
      AND c.period_start <= _period_end
      AND c.period_end >= _period_start
  ) THEN
    RAISE EXCEPTION 'هذه الفترة تتداخل مع فترة مقفلة سابقاً';
  END IF;

  WITH inv AS (
    SELECT i.id, i.invoice_number,
           (i.created_at AT TIME ZONE _tz)::date AS sale_day,
           COALESCE(i.total, 0) AS total,
           COALESCE(i.tax_amount, 0) AS tax,
           COALESCE(i.profit, 0) AS profit,
           i.payment_type, i.status,
           CASE WHEN i.status = 'paid' THEN COALESCE(i.total, 0)
                ELSE LEAST(GREATEST(COALESCE(i.debt_paid, 0), 0), COALESCE(i.total, 0)) END AS paid_by_invoice
      FROM public.invoices i
     WHERE i.user_id = _owner
       AND i.status NOT IN ('refunded', 'cancelled')
       AND COALESCE(i.invoice_type, 'sale') IN ('sale', 'maintenance')
  ),
  credit AS (
    SELECT * FROM inv WHERE payment_type = 'debt' AND total > 0
  ),
  pay AS (
    SELECT c.id AS invoice_id,
           dp.amount,
           (dp.created_at AT TIME ZONE _tz)::date AS pay_day,
           SUM(dp.amount) OVER (PARTITION BY c.id ORDER BY dp.created_at, dp.id) - dp.amount AS paid_before
      FROM credit c
      JOIN public.debts d
        ON d.user_id = _owner
       AND NOT COALESCE(d.is_cash_debt, false)
       AND (d.invoice_id = c.invoice_number OR d.invoice_id = c.id::text)
      JOIN public.debt_payments dp ON dp.debt_id = d.id
     WHERE COALESCE(dp.amount, 0) > 0
  ),
  credit_paid AS (
    SELECT c.*,
           GREATEST(c.paid_by_invoice, LEAST(c.total, COALESCE(ds.dated_sum, 0))) AS paid_total,
           COALESCE(ds.dated_sum, 0) AS dated_sum,
           (c.status = 'written_off' OR EXISTS (
              SELECT 1 FROM public.debt_writeoffs w
               LEFT JOIN public.debts wd ON wd.id = w.debt_id
              WHERE w.user_id = _owner
                AND COALESCE(wd.invoice_id, w.notes) IN (c.invoice_number, c.id::text)
                AND NOT COALESCE(wd.is_cash_debt, false)
           )) AS is_written_off
      FROM credit c
      LEFT JOIN (SELECT invoice_id, SUM(amount) AS dated_sum FROM pay GROUP BY invoice_id) ds
        ON ds.invoice_id = c.id
  ),
  alloc AS (
    SELECT pm.pay_day,
           GREATEST(0, LEAST(pm.amount, cp.paid_total - pm.paid_before)) AS amount,
           cp.profit, cp.total
      FROM pay pm
      JOIN credit_paid cp ON cp.id = pm.invoice_id
  )
  SELECT
    COALESCE((SELECT SUM(total - tax) FROM inv
               WHERE sale_day BETWEEN _period_start AND _period_end), 0),
    COALESCE((SELECT SUM(profit) FROM inv
               WHERE NOT (payment_type IS NOT DISTINCT FROM 'debt' AND total > 0)
                 AND sale_day BETWEEN _period_start AND _period_end), 0)
    + COALESCE((SELECT SUM(profit * (paid_total - LEAST(dated_sum, paid_total)) / total) FROM credit_paid
                 WHERE sale_day BETWEEN _period_start AND _period_end), 0)
    + COALESCE((SELECT SUM(profit * amount / total) FROM alloc
                 WHERE pay_day BETWEEN _period_start AND _period_end), 0),
    COALESCE((SELECT SUM(profit * (total - paid_total) / total) FROM credit_paid
               WHERE NOT is_written_off AND sale_day <= _period_end), 0)
    INTO _rev, _realized, _pending;

  SELECT
    COALESCE(SUM(COALESCE(ii.cost_price, 0) * COALESCE(ii.quantity, 0)), 0)
    INTO _cogs
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE i.user_id = _owner
     AND i.status NOT IN ('refunded', 'cancelled')
     AND COALESCE(i.invoice_type, 'sale') IN ('sale', 'maintenance')
     AND (i.created_at AT TIME ZONE _tz)::date BETWEEN _period_start AND _period_end;

  SELECT COALESCE(SUM(amount), 0) INTO _exp
    FROM public.expenses
   WHERE user_id = _owner
     AND COALESCE(is_reversed, false) = false
     AND date BETWEEN _period_start AND _period_end;

  SELECT COALESCE(SUM(
           COALESCE(
             w.loss_amount,
             CASE WHEN x.total > 0
                  THEN COALESCE(w.amount, 0) - x.profit * LEAST(COALESCE(w.amount, 0), x.total) / x.total
                  ELSE COALESCE(w.amount, 0) END
           )), 0)
    INTO _bad_debt
    FROM public.debt_writeoffs w
    LEFT JOIN public.debts d ON d.id = w.debt_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(i.total, 0) AS total, COALESCE(i.profit, 0) AS profit, i.status
        FROM public.invoices i
       WHERE i.user_id = _owner
         AND NOT COALESCE(d.is_cash_debt, false)
         AND COALESCE(d.invoice_id, w.notes) IS NOT NULL
         AND (i.invoice_number = COALESCE(d.invoice_id, w.notes) OR i.id::text = COALESCE(d.invoice_id, w.notes))
       ORDER BY i.created_at
       LIMIT 1
    ) x ON true
   WHERE w.user_id = _owner
     AND (w.written_off_at AT TIME ZONE _tz)::date BETWEEN _period_start AND _period_end
     AND COALESCE(x.status, '') NOT IN ('refunded', 'cancelled');

  _rev := round(_rev, 8);
  _cogs := round(_cogs, 8);
  _exp := round(_exp, 8);
  _gross := round(_rev - _cogs, 8);
  _realized := round(_realized, 8);
  _pending := round(_pending, 8);
  _bad_debt := round(_bad_debt, 8);
  _net := round(_realized - _exp - _bad_debt, 8);

  FOR p IN
    SELECT id, name, confirmed_profit, current_balance, total_profit_earned
      FROM public.partners
     WHERE user_id = _owner
  LOOP
    _partner_summary := _partner_summary || jsonb_build_object(
      'partner_id', p.id,
      'partner_name', p.name,
      'current_balance', p.current_balance,
      'confirmed_profit', p.confirmed_profit,
      'total_earned', p.total_profit_earned
    );
  END LOOP;

  INSERT INTO public.accounting_period_closures (
    user_id, period_start, period_end, total_revenue, total_cogs,
    gross_profit, total_expenses, net_profit, partner_distributions, closed_by,
    realized_profit, pending_profit, bad_debt_loss, closing_timezone
  ) VALUES (
    _owner, _period_start, _period_end, _rev, _cogs,
    _gross, _exp, _net, _partner_summary, _caller,
    _realized, _pending, _bad_debt, _tz
  ) RETURNING id INTO _closure_id;

  RETURN jsonb_build_object(
    'success', true,
    'closure_id', _closure_id,
    'period_start', _period_start,
    'period_end', _period_end,
    'timezone', _tz,
    'revenue', _rev,
    'cogs', _cogs,
    'gross_profit', _gross,
    'realized_profit', _realized,
    'pending_profit', _pending,
    'expenses', _exp,
    'bad_debt_loss', _bad_debt,
    'net_profit', _net,
    'partners', _partner_summary
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public._posflow_integrity_core(_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _res jsonb := '[]'::jsonb; _cnt int; _sample jsonb;
BEGIN
  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (SELECT p.id, row_number() over() rn FROM products p WHERE p.user_id=_owner AND p.quantity<0) x;
  _res := _res || jsonb_build_object('check','negative_stock','severity','high','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT c.id, row_number() over() rn FROM customers c
     WHERE c.user_id=_owner AND abs(COALESCE(c.total_debt,0) - COALESCE((SELECT SUM(d.remaining_debt) FROM debts d WHERE d.user_id=_owner AND COALESCE(d.status,'') NOT IN ('fully_paid','written_off','cancelled') AND (d.customer_id=c.id OR (d.customer_id IS NULL AND d.customer_name=c.name))),0)) > 0.01) x;
  _res := _res || jsonb_build_object('check','customer_debt_mismatch','severity','high','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT d.id, row_number() over() rn FROM debts d JOIN invoices i ON i.user_id=d.user_id AND (d.invoice_id=i.invoice_number OR d.invoice_id=i.id::text)
     WHERE d.user_id=_owner AND COALESCE(d.status,'') NOT IN ('fully_paid','written_off','cancelled') AND d.remaining_debt>0 AND i.status IN ('refunded','cancelled')) x;
  _res := _res || jsonb_build_object('check','open_debt_on_refunded_invoice','severity','high','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT i.id, row_number() over() rn FROM invoices i
     WHERE i.user_id=_owner AND i.payment_type='debt' AND i.status NOT IN ('refunded','cancelled')
       AND abs(COALESCE(i.debt_remaining,0) - COALESCE((SELECT SUM(d.remaining_debt) FROM debts d WHERE d.user_id=_owner AND COALESCE(d.status,'') NOT IN ('cancelled') AND (d.invoice_id=i.invoice_number OR d.invoice_id=i.id::text)),0)) > 0.01) x;
  _res := _res || jsonb_build_object('check','invoice_debt_vs_debts','severity','high','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT d.id, row_number() over() rn FROM debts d
     WHERE d.user_id=_owner AND COALESCE(d.status,'') NOT IN ('cancelled','written_off')
       AND abs(COALESCE(d.total_debt,0)-COALESCE(d.total_paid,0)-COALESCE(d.remaining_debt,0)) > 0.01) x;
  _res := _res || jsonb_build_object('check','debt_math','severity','medium','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT i.id, row_number() over() rn FROM invoices i
     WHERE i.user_id=_owner AND i.status NOT IN ('refunded','cancelled')
       AND EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=i.id)
       AND abs(COALESCE(i.profit,0) - (SELECT COALESCE(SUM(ii.profit),0) FROM invoice_items ii WHERE ii.invoice_id=i.id)) > 0.05) x;
  _res := _res || jsonb_build_object('check','invoice_profit_vs_items','severity','medium','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT p.id, row_number() over() rn FROM partners p
     WHERE p.user_id=_owner AND abs(COALESCE(p.pending_profit,0) - COALESCE((SELECT SUM((e->>'amount')::numeric) FROM jsonb_array_elements(COALESCE(p.pending_profit_details,'[]'::jsonb)) e),0)) > 0.01) x;
  _res := _res || jsonb_build_object('check','partner_pending_vs_details','severity','medium','count',_cnt,'sample',_sample);

  RETURN jsonb_build_object('checked_at', now(), 'issues_total', (SELECT COALESCE(SUM((e->>'count')::int),0) FROM jsonb_array_elements(_res) e), 'checks', _res);
END $function$;

CREATE OR REPLACE FUNCTION public.link_purchase_to_supplier_atomic(_invoice_id uuid, _supplier_id uuid, _paid_amount numeric DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _o uuid := public._supplier_owner(); _inv record; _total numeric; _paid numeric := GREATEST(COALESCE(_paid_amount,0),0);
BEGIN
  SELECT * INTO _inv FROM public.purchase_invoices WHERE id=_invoice_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'فاتورة الشراء غير موجودة'; END IF;
  PERFORM 1 FROM public.suppliers WHERE id=_supplier_id AND user_id=_o AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'المورد غير موجود أو غير فعّال'; END IF;
  IF _inv.supplier_id IS NOT NULL THEN RETURN jsonb_build_object('success',true,'already_linked',true); END IF;
  IF COALESCE(_inv.payment_status,'') = 'cancelled' OR COALESCE(_inv.status,'') = 'cancelled' THEN RAISE EXCEPTION 'الفاتورة ملغاة'; END IF;
  IF COALESCE(_inv.status, 'draft') NOT IN ('finalized', 'completed') THEN
    RAISE EXCEPTION 'يجب اعتماد فاتورة الشراء قبل ربطها بمورد';
  END IF;
  PERFORM public.assert_period_open(_o, _inv.invoice_date::date, 'ربط فاتورة شراء بمورد');
  _total := COALESCE(_inv.actual_grand_total, _inv.expected_grand_total, 0);
  IF _total <= 0 THEN RAISE EXCEPTION 'إجمالي الفاتورة صفر'; END IF;
  IF _paid > _total THEN RAISE EXCEPTION 'المدفوع أكبر من إجمالي الفاتورة'; END IF;
  INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,reference_id,note,created_by)
  VALUES (_o,_supplier_id,'purchase',round(_total,4),'purchase_invoice',_invoice_id::text,'فاتورة شراء '||_inv.invoice_number,auth.uid());
  IF _paid > 0 THEN
    INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,reference_id,payment_method,note,created_by)
    VALUES (_o,_supplier_id,'payment',-round(_paid,4),'purchase_invoice',_invoice_id::text,_inv.payment_method,'دفعة عند الشراء '||_inv.invoice_number,auth.uid());
  END IF;
  UPDATE public.purchase_invoices SET supplier_id=_supplier_id, amount_paid=_paid, updated_at=now() WHERE id=_invoice_id;
  RETURN jsonb_build_object('success',true,'total',_total,'paid',_paid,'due',_total-_paid);
END $function$;

CREATE OR REPLACE FUNCTION public.record_stock_damage_atomic(_product_id uuid, _warehouse_id uuid, _quantity numeric, _unit_cost numeric DEFAULT NULL::numeric, _reason text DEFAULT NULL::text, _notes text DEFAULT NULL::text, _apply_to_stock boolean DEFAULT true, _source text DEFAULT 'manual'::text, _source_ref text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _p record;
  _ws_qty numeric;
  _cost numeric;
  _id uuid;
  _name text;
  _ref_uuid uuid;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'owner not found';
  END IF;
  IF COALESCE(_quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'الكمية يجب أن تكون أكبر من الصفر';
  END IF;

  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'تسجيل تالف');

  IF _warehouse_id IS NOT NULL THEN
    PERFORM 1 FROM public.warehouses WHERE id = _warehouse_id AND user_id = _owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'المستودع غير موجود أو لا يتبع لهذا المتجر';
    END IF;
  END IF;

  SELECT id, name, quantity, cost_price
    INTO _p
    FROM public.products
   WHERE id = _product_id AND user_id = _owner
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'المنتج غير موجود';
  END IF;

  _cost := COALESCE(_unit_cost, _p.cost_price, 0);
  IF _cost < 0 THEN
    RAISE EXCEPTION 'التكلفة غير صالحة';
  END IF;

  IF COALESCE(_apply_to_stock, true) THEN
    PERFORM set_config('app.stock_movement_type', 'damage', true);
    PERFORM set_config('app.stock_actor_id', _caller::text, true);
    PERFORM set_config('app.stock_source', 'record_stock_damage_atomic', true);

    IF _warehouse_id IS NOT NULL THEN
      SELECT quantity
        INTO _ws_qty
        FROM public.warehouse_stock
       WHERE warehouse_id = _warehouse_id AND product_id = _product_id
         FOR UPDATE;

      IF NOT FOUND OR COALESCE(_ws_qty, 0) < _quantity THEN
        RAISE EXCEPTION 'الكمية التالفة (%) أكبر من المخزون المتاح في المستودع (%)', _quantity, COALESCE(_ws_qty, 0);
      END IF;

      UPDATE public.warehouse_stock
         SET quantity = round(_ws_qty - _quantity, 3),
             last_updated = now()
       WHERE warehouse_id = _warehouse_id AND product_id = _product_id;
    ELSE
      IF COALESCE(_p.quantity, 0) < _quantity THEN
        RAISE EXCEPTION 'الكمية التالفة (%) أكبر من المخزون المتاح (%)', _quantity, COALESCE(_p.quantity, 0);
      END IF;

      UPDATE public.products
         SET quantity = round(quantity - _quantity, 3),
             updated_at = now()
       WHERE id = _product_id;
    END IF;
  END IF;

  SELECT COALESCE(full_name, 'مستخدم') INTO _name FROM public.profiles WHERE user_id = _caller;

  _ref_uuid := CASE
    WHEN _source_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN _source_ref::uuid
    ELSE NULL
  END;

  INSERT INTO public.stock_damages(
    user_id, product_id, product_name, warehouse_id, quantity, unit_cost, cost_value,
    reason, notes, damaged_at, recorded_by, recorded_by_name, source, source_ref
  ) VALUES (
    _owner, _product_id, _p.name, _warehouse_id, _quantity, _cost, round(_quantity * _cost, 8),
    _reason, _notes, now(), _caller, COALESCE(_name, 'مستخدم'), COALESCE(_source, 'manual'), _ref_uuid
  ) RETURNING id INTO _id;

  RETURN _id;
END $function$;

NOTIFY pgrst, 'reload schema';
