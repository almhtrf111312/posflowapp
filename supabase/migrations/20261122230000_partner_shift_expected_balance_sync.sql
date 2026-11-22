-- Migration: 20261122230000_partner_shift_expected_balance_sync
-- Keeps cash_shifts.expected_balance in sync with shift_transactions for
-- partner_deposit_atomic, partner_withdrawal_atomic, and _supplier_drawer_tx.

CREATE OR REPLACE FUNCTION public.partner_deposit_atomic(
  _partner_id uuid,
  _amount_usd numeric,
  _deposit_target text DEFAULT 'capital'::text,
  _notes text DEFAULT NULL::text,
  _shift_id uuid DEFAULT NULL::uuid,
  _currency text DEFAULT 'USD'::text,
  _original_amount numeric DEFAULT NULL::numeric,
  _exchange_rate numeric DEFAULT 1.0
)
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
  _amt_usd numeric := round(COALESCE(_amount_usd, 0), 4);
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
    _orig_amt := round(_amt_usd, 2);
  ELSE
    _rate := COALESCE(_exchange_rate, 0);
    IF _rate <= 0 THEN
      RAISE EXCEPTION 'سعر الصرف غير صالح';
    END IF;
    _orig_amt := round(COALESCE(_original_amount, _amt_usd * _rate), 2);
    IF _orig_amt <= 0 THEN
      RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
    END IF;
    IF _original_amount IS NOT NULL AND _original_amount > 0 THEN
      IF abs(_orig_amt - round(_amt_usd * _rate, 2)) > GREATEST(0.05, _orig_amt * 0.01) THEN
        RAISE EXCEPTION 'تعارض في تحويل العملة: المبلغ الأصلي (%) لا يطابق المبلغ بالدولار (%) × سعر الصرف (%)',
          _orig_amt, _amt_usd, _rate;
      END IF;
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
      current_balance = round(COALESCE(current_balance, 0) + _amt_usd, 4),
      capital_history = COALESCE(capital_history, '[]'::jsonb) || _cap_record,
      updated_at = now()
    WHERE id = _partner_id;
  ELSE
    UPDATE public.partners SET
      initial_capital = round(COALESCE(initial_capital, 0) + _amt_usd, 4),
      current_capital = round(COALESCE(current_capital, 0) + _amt_usd, 4),
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

    UPDATE public.cash_shifts
       SET expected_balance = round(COALESCE(expected_balance, 0) + _amt_usd, 2),
           updated_at = now()
     WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'partner_id', _partner_id,
    'amount_usd', _amt_usd,
    'currency', _ccy,
    'original_amount', _orig_amt,
    'deposit_target', _deposit_target,
    'new_balance', CASE WHEN _deposit_target = 'balance' THEN round(COALESCE(_partner.current_balance, 0) + _amt_usd, 4) ELSE _partner.current_balance END,
    'new_capital', CASE WHEN _deposit_target = 'capital' THEN round(COALESCE(_partner.current_capital, 0) + _amt_usd, 4) ELSE _partner.current_capital END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_withdrawal_atomic(
  _partner_id uuid,
  _amount numeric,
  _withdrawal_type text,
  _notes text DEFAULT NULL::text,
  _shift_id uuid DEFAULT NULL::uuid,
  _currency text DEFAULT 'USD'::text,
  _original_amount numeric DEFAULT NULL::numeric,
  _exchange_rate numeric DEFAULT 1.0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_owner uuid := public.get_owner_id(v_caller);
  v_partner public.partners%ROWTYPE;
  v_amt numeric := round(COALESCE(_amount, 0)::numeric, 4);
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
    v_orig_amt := round(v_amt, 2);
  ELSE
    v_rate := COALESCE(_exchange_rate, 0);
    IF v_rate <= 0 THEN
      RAISE EXCEPTION 'سعر الصرف غير صالح';
    END IF;
    v_orig_amt := round(COALESCE(_original_amount, v_amt * v_rate), 2);
    IF v_orig_amt <= 0 THEN
      RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
    END IF;
    IF _original_amount IS NOT NULL AND _original_amount > 0 THEN
      IF abs(v_orig_amt - round(v_amt * v_rate, 2)) > GREATEST(0.05, v_orig_amt * 0.01) THEN
        RAISE EXCEPTION 'تعارض في تحويل العملة: المبلغ الأصلي (%) لا يطابق المبلغ بالدولار (%) × سعر الصرف (%)',
          v_orig_amt, v_amt, v_rate;
      END IF;
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
       SET current_balance = round(current_balance - v_amt, 4),
           total_withdrawn = round(COALESCE(total_withdrawn, 0) + v_amt, 4),
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
       SET current_capital = round(current_capital - v_amt, 4),
           total_withdrawn = round(COALESCE(total_withdrawn, 0) + v_amt, 4),
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

    UPDATE public.cash_shifts
       SET expected_balance = round(COALESCE(expected_balance, 0) - v_amt, 2),
           updated_at = now()
     WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'partner_id', _partner_id,
    'amount', v_amt,
    'currency', v_ccy,
    'original_amount', v_orig_amt,
    'withdrawal_type', _withdrawal_type,
    'new_balance', CASE WHEN _withdrawal_type = 'profit' THEN round(v_partner.current_balance - v_amt, 4) ELSE v_partner.current_balance END,
    'new_capital', CASE WHEN _withdrawal_type = 'capital' THEN round(v_partner.current_capital - v_amt, 4) ELSE v_partner.current_capital END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public._supplier_drawer_tx(
  _owner uuid,
  _shift uuid,
  _type text,
  _amount numeric,
  _ccy text,
  _ccy_amount numeric,
  _rate numeric,
  _ref text,
  _note text
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _s uuid := _shift;
  _inserted int := 0;
  _delta numeric := 0;
BEGIN
  IF _s IS NOT NULL THEN
    PERFORM 1
      FROM public.cash_shifts
     WHERE id = _s
       AND user_id = _owner
       AND closed_at IS NULL
       FOR UPDATE;
  END IF;

  IF _s IS NULL OR NOT FOUND THEN
    SELECT id INTO _s
      FROM public.cash_shifts
     WHERE user_id = _owner
       AND closed_at IS NULL
     ORDER BY opened_at DESC
     LIMIT 1
       FOR UPDATE;

    IF _s IS NULL THEN
      RAISE EXCEPTION 'لا توجد وردية مفتوحة لتسجيل حركة صندوق المورد';
    END IF;
  END IF;

  INSERT INTO public.shift_transactions(
    shift_id, user_id, type, amount, reference_id, notes, currency, currency_amount, exchange_rate
  )
  VALUES (
    _s, _owner, _type, round(_amount, 4), _ref, _note,
    COALESCE(_ccy, 'USD'), COALESCE(_ccy_amount, _amount), _rate
  )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS _inserted = ROW_COUNT;
  IF _inserted > 0 THEN
    _delta := CASE WHEN _type = 'supplier_refund' THEN round(_amount, 4) ELSE -round(_amount, 4) END;
    UPDATE public.cash_shifts
       SET expected_balance = round(COALESCE(expected_balance, 0) + _delta, 2),
           updated_at = now()
     WHERE id = _s AND user_id = _owner AND closed_at IS NULL;
  END IF;

  IF _s IS DISTINCT FROM _shift AND _ref IS NOT NULL THEN
    UPDATE public.supplier_ledger_entries
       SET shift_id = _s
     WHERE user_id = _owner
       AND payment_source = 'drawer'
       AND shift_id IS DISTINCT FROM _s
       AND (
         operation_id = _ref
         OR (reference_type = 'purchase_invoice' AND 'purchase:' || reference_id = _ref)
       );
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.partner_deposit_atomic(uuid, numeric, text, text, uuid, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_deposit_atomic(uuid, numeric, text, text, uuid, text, numeric, numeric) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.partner_withdrawal_atomic(uuid, numeric, text, text, uuid, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_withdrawal_atomic(uuid, numeric, text, text, uuid, text, numeric, numeric) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public._supplier_drawer_tx(uuid, uuid, text, numeric, text, numeric, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._supplier_drawer_tx(uuid, uuid, text, numeric, text, numeric, numeric, text, text) TO service_role;
