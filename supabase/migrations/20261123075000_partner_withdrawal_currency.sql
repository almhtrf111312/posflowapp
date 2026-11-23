-- FINANCE LAW D-10 — partner withdrawals in any currency (owner decision, 2026-11-23). Same signature as before.
--   * capital is held in USD at the deposit: a capital withdrawal in a foreign currency is valued at the ORIGINAL
--     deposit rate (weighted over the partner's capital deposits); the server computes the USD amount;
--   * profit is held in USD: a profit withdrawal in a foreign currency is valued at the rate the client sends
--     (today's rate for that currency);
--   * automatic split stays for USD only; a foreign-currency withdrawal is two rows (profit, capital).
-- Apply manually after owner approval (AGENTS.md database rule). Generated from the live definition (md5 verified).

CREATE OR REPLACE FUNCTION public.partner_withdrawal_atomic(_partner_id uuid, _amount numeric, _withdrawal_type text, _notes text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT 'USD'::text, _original_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT 1.0, _operation_id text DEFAULT NULL::text)
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
  v_op_id text := NULLIF(trim(COALESCE(_operation_id, '')), '');
  v_orig_amt numeric;
  v_rate numeric;
  v_avail_profit numeric := 0;
  v_avail_capital numeric := 0;
  v_profit_part numeric := 0;
  v_capital_part numeric := 0;
  v_new_balance numeric;
  v_new_capital numeric;
  v_withdrawals jsonb := '[]'::jsonb;
  v_capital_entries jsonb := '[]'::jsonb;
  v_note_text text;
  v_shift_label text;
  v_request jsonb;
  v_recorded_request jsonb;
  v_result jsonb;
  v_profit_original numeric;
  v_capital_original numeric;
  v_cap_rate numeric;
BEGIN
  PERFORM set_config('app.partner_source', 'partner_withdrawal_atomic', true);
  IF v_op_id IS NOT NULL THEN
    PERFORM set_config('app.partner_ref', v_op_id, true);
  END IF;

  IF v_caller IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(v_caller) THEN
    RAISE EXCEPTION 'هذه العملية مخصصة لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  IF _withdrawal_type IS NULL OR _withdrawal_type NOT IN ('profit', 'capital', 'auto') THEN
    RAISE EXCEPTION 'نوع السحب غير صالح: %', COALESCE(_withdrawal_type, 'NULL');
  END IF;

  IF v_amt <= 0 OR v_amt::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر';
  END IF;

  IF v_op_id IS NOT NULL AND length(v_op_id) > 128 THEN
    RAISE EXCEPTION 'معرّف العملية غير صالح';
  END IF;

  IF _original_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR _exchange_rate::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'المبلغ أو سعر الصرف غير صالح';
  END IF;

  -- KD-08 / D-10: a capital withdrawal in a foreign currency is valued at the ORIGINAL deposit rate
  -- (weighted over the partner's capital deposits). The server computes the USD amount itself.
  IF _withdrawal_type = 'capital' AND v_ccy <> 'USD' THEN
    IF _original_amount IS NULL OR _original_amount <= 0 THEN
      RAISE EXCEPTION 'المبلغ الأصلي مطلوب لسحب رأس المال بعملة أجنبية';
    END IF;
    SELECT * INTO v_partner FROM public.partners WHERE id = _partner_id AND user_id = v_owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الشريك غير موجود أو غير تابع للمتجر';
    END IF;
    SELECT COALESCE(SUM((h->>'originalAmount')::numeric) / NULLIF(SUM((h->>'amount')::numeric), 0), 0)
      INTO v_cap_rate
      FROM jsonb_array_elements(COALESCE(v_partner.capital_history, '[]'::jsonb)) h
     WHERE h->>'type' = 'deposit'
       AND COALESCE((h->>'amount')::numeric, 0) > 0
       AND COALESCE((h->>'originalAmount')::numeric, 0) > 0;
    IF COALESCE(v_cap_rate, 0) <= 0 THEN
      RAISE EXCEPTION 'لا يمكن حساب سعر الإيداع الأصلي لرأس مال الشريك';
    END IF;
    v_amt := round(_original_amount / v_cap_rate, 4);
  END IF;

  -- Strict FX validation
  IF v_ccy = 'USD' THEN
    IF _exchange_rate IS NOT NULL AND abs(_exchange_rate - 1.0) > 0.0001 THEN
      RAISE EXCEPTION 'سعر الصرف لعملة USD يجب أن يساوي 1 (المستلم: %)', _exchange_rate;
    END IF;
    v_rate := 1.0;
    IF _original_amount IS NOT NULL THEN
      IF _original_amount <= 0 THEN
        RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
      END IF;
      v_orig_amt := round(_original_amount, 2);
      IF abs(v_orig_amt - round(v_amt, 2)) > 0.005 THEN
        RAISE EXCEPTION 'تعارض في المبلغ بالدولار: المبلغ الأصلي (%) لا يطابق المبلغ (%)',
          v_orig_amt, round(v_amt, 2);
      END IF;
    ELSE
      v_orig_amt := round(v_amt, 2);
    END IF;
  ELSE
    IF _withdrawal_type = 'capital' THEN
      v_rate := v_cap_rate;
    ELSE
      v_rate := COALESCE(_exchange_rate, 0);
    END IF;
    IF v_rate <= 0 THEN
      RAISE EXCEPTION 'سعر الصرف غير صالح لعملة %', v_ccy;
    END IF;
    IF _original_amount IS NOT NULL AND _original_amount <= 0 THEN
      RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
    END IF;
    v_orig_amt := round(COALESCE(_original_amount, v_amt * v_rate), 2);
    IF v_orig_amt <= 0 THEN
      RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
    END IF;
    IF _original_amount IS NOT NULL THEN
      IF abs(v_orig_amt - round(v_amt * v_rate, 2)) > (0.005 + 0.005 * v_rate) THEN
        RAISE EXCEPTION 'تعارض في تحويل العملة: المبلغ الأصلي (%) لا يطابق المبلغ بالدولار (%) × سعر الصرف (%)',
          v_orig_amt, v_amt, v_rate;
      END IF;
    END IF;
  END IF;

  -- KD-08 / D-10: automatic split (profit first, then capital) is for USD only. A foreign-currency withdrawal
  -- is sent as two separate rows (profit row, capital row), each valued at its own rate.
  IF _withdrawal_type = 'auto' AND v_ccy <> 'USD' THEN
    RAISE EXCEPTION 'السحب التلقائي بعملة أجنبية غير مدعوم: اسحب الربح ورأس المال في سطرين منفصلين';
  END IF;

  IF v_op_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('partner_withdraw_op:' || v_owner::text || ':' || v_op_id));
    v_request := jsonb_build_object(
      'partner_id', _partner_id, 'amount', v_amt, 'withdrawal_type', _withdrawal_type,
      'currency', v_ccy, 'original_amount', v_orig_amt, 'exchange_rate', v_rate,
      'shift_id', _shift_id, 'notes', NULLIF(trim(_notes), '')
    );
    SELECT request, result INTO v_recorded_request, v_result
      FROM public.accounting_rpc_receipts
     WHERE user_id = v_owner AND kind = 'partner_withdrawal' AND operation_id = v_op_id;
    IF FOUND THEN
      IF v_recorded_request IS DISTINCT FROM v_request THEN
        RAISE EXCEPTION 'معرّف السحب مرتبط بطلب مختلف';
      END IF;
      RETURN v_result || jsonb_build_object('already_processed', true);
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.partner_ledger_entries ple
       WHERE ple.user_id = v_owner AND ple.source = 'partner_withdrawal_atomic' AND ple.reference = v_op_id
    ) OR EXISTS (
      SELECT 1 FROM public.partners p
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.withdrawal_history, '[]'::jsonb)) h
       WHERE p.user_id = v_owner AND h->>'operationId' = v_op_id
    ) THEN
      RAISE EXCEPTION 'تم ترحيل معرّف السحب سابقاً دون إيصال كامل. راجع دفتر الشريك قبل إعادة المحاولة';
    END IF;
  END IF;

  PERFORM public.assert_period_open(v_owner, CURRENT_DATE, 'سحب شريك');

  IF _shift_id IS NOT NULL THEN
    PERFORM 1 FROM public.cash_shifts
    WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
    END IF;
  END IF;

  SELECT * INTO v_partner FROM public.partners WHERE id = _partner_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'الشريك غير موجود أو غير تابع للمتجر';
  END IF;

  v_note_text := COALESCE(_notes, '');
  IF v_ccy <> 'USD' AND v_orig_amt IS NOT NULL THEN
    v_note_text := v_note_text || ' (' || v_orig_amt::text || ' ' || v_ccy || ')';
  END IF;

  IF _withdrawal_type = 'profit' THEN
    IF v_amt > COALESCE(v_partner.current_balance, 0) THEN
      RAISE EXCEPTION 'رصيد أرباح الشريك لا يكفي (المتاح: %)', v_partner.current_balance;
    END IF;
    v_profit_part := v_amt;
    v_capital_part := 0;

    v_withdrawals := jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'id', gen_random_uuid()::text,
        'operationId', v_op_id,
        'amount', v_profit_part,
        'currency', v_ccy,
        'originalAmount', v_orig_amt,
        'exchangeRate', v_rate,
        'type', 'profit',
        'date', now()::text,
        'notes', v_note_text
      ))
    );

  ELSIF _withdrawal_type = 'capital' THEN
    IF v_amt > COALESCE(v_partner.current_capital, 0) THEN
      RAISE EXCEPTION 'رأس مال الشريك لا يكفي (المتاح: %)', v_partner.current_capital;
    END IF;
    v_profit_part := 0;
    v_capital_part := v_amt;

    v_withdrawals := jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'id', gen_random_uuid()::text,
        'operationId', v_op_id,
        'amount', v_capital_part,
        'currency', v_ccy,
        'originalAmount', v_orig_amt,
        'exchangeRate', v_rate,
        'type', 'capital',
        'date', now()::text,
        'notes', v_note_text
      ))
    );

    v_capital_entries := jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'id', gen_random_uuid()::text || '_cap',
        'operationId', v_op_id,
        'amount', v_capital_part,
        'currency', v_ccy,
        'originalAmount', v_orig_amt,
        'exchangeRate', v_rate,
        'type', 'withdrawal',
        'date', now()::text,
        'notes', v_note_text
      ))
    );

  ELSE
    -- _withdrawal_type = 'auto': deduct available profit first, remainder from capital
    v_avail_profit := GREATEST(COALESCE(v_partner.current_balance, 0), 0);
    v_avail_capital := GREATEST(COALESCE(v_partner.current_capital, 0), 0);

    IF v_amt > round(v_avail_profit + v_avail_capital, 4) THEN
      RAISE EXCEPTION 'الرصيد الإجمالي للشريك لا يكفي (أرباح متاحة: %، رأس مال متاح: %)',
        v_avail_profit, v_avail_capital;
    END IF;

    v_profit_part := round(LEAST(v_amt, v_avail_profit), 4);
    v_capital_part := round(v_amt - v_profit_part, 4);
    v_profit_original := round(v_orig_amt * v_profit_part / v_amt, 2);
    v_capital_original := v_orig_amt - v_profit_original;

    IF v_profit_part > 0 THEN
      v_withdrawals := v_withdrawals || jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'id', gen_random_uuid()::text,
          'operationId', v_op_id,
          'amount', v_profit_part,
          'currency', v_ccy,
          'originalAmount', v_profit_original,
          'exchangeRate', v_rate,
          'type', 'profit',
          'autoSplit', (v_capital_part > 0),
          'date', now()::text,
          'notes', v_note_text
        ))
      );
    END IF;

    IF v_capital_part > 0 THEN
      v_withdrawals := v_withdrawals || jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'id', gen_random_uuid()::text,
          'operationId', v_op_id,
          'amount', v_capital_part,
          'currency', v_ccy,
          'originalAmount', v_capital_original,
          'exchangeRate', v_rate,
          'type', 'capital',
          'autoSplit', (v_profit_part > 0),
          'date', now()::text,
          'notes', v_note_text
        ))
      );

      v_capital_entries := jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'id', gen_random_uuid()::text || '_cap',
          'operationId', v_op_id,
          'amount', v_capital_part,
          'currency', v_ccy,
          'originalAmount', v_capital_original,
          'exchangeRate', v_rate,
          'type', 'withdrawal',
          'autoSplit', (v_profit_part > 0),
          'date', now()::text,
          'notes', v_note_text
        ))
      );
    END IF;
  END IF;

  v_new_balance := round(COALESCE(v_partner.current_balance, 0) - v_profit_part, 4);
  v_new_capital := round(COALESCE(v_partner.current_capital, 0) - v_capital_part, 4);

  UPDATE public.partners
     SET current_balance = v_new_balance,
         current_capital = v_new_capital,
         total_withdrawn = round(COALESCE(total_withdrawn, 0) + v_amt, 4),
         withdrawal_history = COALESCE(withdrawal_history, '[]'::jsonb) || v_withdrawals,
         capital_history = CASE
           WHEN jsonb_array_length(v_capital_entries) > 0
           THEN COALESCE(capital_history, '[]'::jsonb) || v_capital_entries
           ELSE capital_history
         END,
         updated_at = now()
   WHERE id = _partner_id;

  IF _shift_id IS NOT NULL THEN
    v_shift_label := CASE
      WHEN _withdrawal_type = 'capital' THEN 'رأس مال'
      WHEN _withdrawal_type = 'auto' THEN
        CASE
          WHEN v_profit_part > 0 AND v_capital_part > 0 THEN 'أرباح ورأس مال (تلقائي)'
          WHEN v_capital_part > 0 THEN 'رأس مال (تلقائي)'
          ELSE 'أرباح (تلقائي)'
        END
      ELSE 'أرباح'
    END;

    INSERT INTO public.shift_transactions (
      shift_id, user_id, type, amount, currency_amount, currency, exchange_rate, notes, reference_id
    ) VALUES (
      _shift_id, v_owner, 'withdrawal', v_amt, v_orig_amt, v_ccy, v_rate,
      'سحب ' || v_shift_label || ' للشريك: ' || v_partner.name || CASE WHEN v_note_text <> '' THEN ' - ' || v_note_text ELSE '' END,
      COALESCE(v_op_id, _partner_id::text || ':' || gen_random_uuid()::text)
    );

    UPDATE public.cash_shifts
       SET expected_balance = round(COALESCE(expected_balance, 0) - v_amt, 2),
           updated_at = now()
     WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL;
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'already_processed', false,
    'partner_id', _partner_id,
    'operation_id', v_op_id,
    'amount', v_amt,
    'currency', v_ccy,
    'original_amount', v_orig_amt,
    'exchange_rate', v_rate,
    'withdrawal_type', _withdrawal_type,
    'profit_deducted', v_profit_part,
    'capital_deducted', v_capital_part,
    'new_balance', v_new_balance,
    'new_capital', v_new_capital
  );
  IF v_op_id IS NOT NULL THEN
    INSERT INTO public.accounting_rpc_receipts(user_id, kind, operation_id, request, result)
    VALUES (v_owner, 'partner_withdrawal', v_op_id, v_request, v_result);
  END IF;
  RETURN v_result;
END;
$function$;
