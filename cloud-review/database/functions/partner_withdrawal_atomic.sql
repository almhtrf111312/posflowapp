-- partner_withdrawal_atomic(_partner_id uuid, _amount numeric, _withdrawal_type text, _notes text, _shift_id uuid, _currency text, _original_amount numeric, _exchange_rate numeric)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

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
  v_orig_amt numeric := round(COALESCE(_original_amount, v_amt)::numeric, 2);
  v_rate numeric := COALESCE(_exchange_rate, 1.0);
  v_withdrawal_record jsonb;
  v_capital_record jsonb;
  v_note_text text;
BEGIN
  IF v_caller IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF v_amt <= 0 THEN
    RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر';
  END IF;

  SELECT * INTO v_partner FROM public.partners WHERE id = _partner_id FOR UPDATE;
  IF NOT FOUND OR v_partner.user_id <> v_owner THEN
    RAISE EXCEPTION 'الشريك غير موجود أو غير تابع للمتجر';
  END IF;

  v_note_text := COALESCE(_notes, '');
  IF _currency <> 'USD' AND v_orig_amt IS NOT NULL THEN
    v_note_text := v_note_text || ' (' || v_orig_amt::text || ' ' || _currency || ')';
  END IF;

  v_withdrawal_record := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'amount', v_amt,
    'currency', _currency,
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
      'currency', _currency,
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

  -- تسجيل حركة السحب في الوردية النقدية بالعملة المناسبة
  IF _shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions (
      shift_id,
      user_id,
      type,
      amount,
      currency_amount,
      currency,
      exchange_rate,
      notes,
      reference_id
    ) VALUES (
      _shift_id,
      v_owner,
      'withdrawal',
      v_amt,
      v_orig_amt,
      _currency,
      v_rate,
      'سحب ' || CASE WHEN _withdrawal_type = 'capital' THEN 'رأس مال' ELSE 'أرباح' END || ' للشريك: ' || v_partner.name || CASE WHEN v_note_text <> '' THEN ' - ' || v_note_text ELSE '' END,
      _partner_id::text
    );

    -- الرصيد المتوقع للوردية يُحسب عند الإقفال من حركات الوردية (أعمدة expected_cash/try/syp غير موجودة)
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'partner_id', _partner_id,
    'amount', v_amt,
    'currency', _currency,
    'original_amount', v_orig_amt,
    'withdrawal_type', _withdrawal_type,
    'new_balance', CASE WHEN _withdrawal_type = 'profit' THEN round(v_partner.current_balance - v_amt, 2) ELSE v_partner.current_balance END,
    'new_capital', CASE WHEN _withdrawal_type = 'capital' THEN round(v_partner.current_capital - v_amt, 2) ELSE v_partner.current_capital END
  );
END;
$function$
;
