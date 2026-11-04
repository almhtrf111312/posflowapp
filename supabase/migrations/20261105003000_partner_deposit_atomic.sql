-- ============================================================================
-- Migration: 20261105003000_partner_deposit_atomic.sql
-- Description: دالة ذرية لمعالجة إيداع رأس مال أو رصيد للشريك وربطه بالصندوق والعملات المتعددة
-- وتحديث دالة السحب لدعم العملات المتعددة والتسجيل المباشر في الوردية
-- ============================================================================

-- 1) دالة إيداع رأس المال أو الرصيد الذرية للشريك
CREATE OR REPLACE FUNCTION public.partner_deposit_atomic(
  _partner_id uuid,
  _amount_usd numeric,
  _deposit_target text DEFAULT 'capital', -- 'capital' (رأس مال) أو 'balance' (رصيد أرباح/تسوية)
  _notes text DEFAULT NULL,
  _shift_id uuid DEFAULT NULL,
  _currency text DEFAULT 'USD',
  _original_amount numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _owner uuid;
  _partner record;
  _tx_id text := gen_random_uuid()::text;
  _orig_amt numeric := COALESCE(_original_amount, _amount_usd);
  _cap_record jsonb;
  _tx_note text;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير مسجل الدخول';
  END IF;

  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'لم يتم العثور على حساب المالك';
  END IF;

  IF _amount_usd IS NULL OR _amount_usd <= 0 THEN
    RAISE EXCEPTION 'مبلغ الإيداع يجب أن يكون أكبر من الصفر';
  END IF;

  -- قفل سجل الشريك للحماية من تضارب المعاملات (Lost Updates)
  SELECT * INTO _partner
  FROM public.partners
  WHERE id = _partner_id AND user_id = _owner
  FOR UPDATE;

  IF _partner IS NULL THEN
    RAISE EXCEPTION 'الشريك غير موجود أو غير تابع لهذا المتجر';
  END IF;

  _tx_note := COALESCE(_notes, CASE WHEN _deposit_target = 'balance' THEN 'إيداع رصيد للشريك' ELSE 'إيداع رأس مال' END);
  IF _currency <> 'USD' AND _orig_amt IS NOT NULL THEN
    _tx_note := _tx_note || ' (' || _orig_amt::text || ' ' || _currency || ')';
  END IF;

  _cap_record := jsonb_build_object(
    'id', _tx_id,
    'amount', round(_amount_usd, 2),
    'type', 'deposit',
    'target', _deposit_target,
    'currency', _currency,
    'originalAmount', round(_orig_amt, 2),
    'date', now()::text,
    'notes', _tx_note
  );

  -- 1) تحديث سجل الشريك بحسب وجهة الإيداع
  IF _deposit_target = 'balance' THEN
    UPDATE public.partners SET
      current_balance = round(COALESCE(current_balance, 0) + _amount_usd, 2),
      capital_history = COALESCE(capital_history, '[]'::jsonb) || _cap_record,
      updated_at = now()
    WHERE id = _partner_id;
  ELSE
    UPDATE public.partners SET
      initial_capital = round(COALESCE(initial_capital, 0) + _amount_usd, 2),
      current_capital = round(COALESCE(current_capital, 0) + _amount_usd, 2),
      capital_history = COALESCE(capital_history, '[]'::jsonb) || _cap_record,
      updated_at = now()
    WHERE id = _partner_id;
  END IF;

  -- 2) تسجيل الحركة في وردية الصندوق المفتوحة إن وجدت
  IF _shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions (
      shift_id,
      user_id,
      type,
      amount,
      amount_usd,
      currency,
      currency_amount,
      notes,
      reference_id,
      created_by
    ) VALUES (
      _shift_id,
      _owner,
      'deposit',
      round(_orig_amt, 2),
      round(_amount_usd, 2),
      _currency,
      round(_orig_amt, 2),
      _tx_note || ' - الشريك: ' || _partner.name,
      _partner_id::text,
      _uid
    );

    -- تحديث رصيد الصندوق بالعملة المناسبة
    IF _currency = 'USD' THEN
      UPDATE public.cash_shifts SET
        expected_cash = round(COALESCE(expected_cash, 0) + _amount_usd, 2),
        updated_at = now()
      WHERE id = _shift_id;
    ELSIF _currency = 'TRY' THEN
      UPDATE public.cash_shifts SET
        expected_try = round(COALESCE(expected_try, 0) + _orig_amt, 2),
        updated_at = now()
      WHERE id = _shift_id;
    ELSIF _currency = 'SYP' THEN
      UPDATE public.cash_shifts SET
        expected_syp = round(COALESCE(expected_syp, 0) + _orig_amt, 2),
        updated_at = now()
      WHERE id = _shift_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'partner_id', _partner_id,
    'amount_usd', round(_amount_usd, 2),
    'deposit_target', _deposit_target,
    'new_balance', CASE WHEN _deposit_target = 'balance' THEN round(COALESCE(_partner.current_balance, 0) + _amount_usd, 2) ELSE _partner.current_balance END,
    'new_capital', CASE WHEN _deposit_target = 'capital' THEN round(COALESCE(_partner.current_capital, 0) + _amount_usd, 2) ELSE _partner.current_capital END
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.partner_deposit_atomic(uuid, numeric, text, text, uuid, text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_deposit_atomic(uuid, numeric, text, text, uuid, text, numeric) TO service_role;


-- 2) ترقية دالة سحب رصيد أو رأس مال الشريك لدعم العملات المتعددة والصندوق الذري
CREATE OR REPLACE FUNCTION public.partner_withdrawal_atomic(
  _partner_id uuid,
  _amount numeric,
  _withdrawal_type text, -- 'profit' OR 'capital'
  _notes text DEFAULT '',
  _shift_id uuid DEFAULT NULL,
  _currency text DEFAULT 'USD',
  _original_amount numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_owner_id(auth.uid());
  v_partner public.partners%ROWTYPE;
  v_amt numeric := round(coalesce(_amount, 0)::numeric, 2);
  v_orig_amt numeric := round(coalesce(_original_amount, _amount)::numeric, 2);
  v_withdrawal_record jsonb;
  v_capital_record jsonb;
  v_tx_note text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF v_amt <= 0 THEN
    RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر';
  END IF;

  -- قفل سجل الشريك للحماية من تضارب المعاملات
  SELECT * INTO v_partner FROM public.partners WHERE id = _partner_id FOR UPDATE;
  IF NOT FOUND OR v_partner.user_id <> v_owner THEN
    RAISE EXCEPTION 'الشريك غير موجود أو غير تابع للمتجر';
  END IF;

  v_tx_note := coalesce(_notes, '');
  IF _currency <> 'USD' AND v_orig_amt IS NOT NULL THEN
    IF v_tx_note <> '' THEN
      v_tx_note := v_tx_note || ' (' || v_orig_amt::text || ' ' || _currency || ')';
    ELSE
      v_tx_note := v_orig_amt::text || ' ' || _currency;
    END IF;
  END IF;

  v_withdrawal_record := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'amount', v_amt,
    'currency', _currency,
    'originalAmount', v_orig_amt,
    'type', _withdrawal_type,
    'date', now()::text,
    'notes', v_tx_note
  );

  IF _withdrawal_type = 'profit' THEN
    IF v_amt > coalesce(v_partner.current_balance, 0) THEN
      RAISE EXCEPTION 'رصيد أرباح الشريك لا يكفي (المتاح: %)', v_partner.current_balance;
    END IF;

    UPDATE public.partners
       SET current_balance = round(current_balance - v_amt, 2),
           total_withdrawn = round(coalesce(total_withdrawn, 0) + v_amt, 2),
           withdrawal_history = coalesce(withdrawal_history, '[]'::jsonb) || v_withdrawal_record,
           updated_at = now()
     WHERE id = _partner_id;

  ELSIF _withdrawal_type = 'capital' THEN
    IF v_amt > coalesce(v_partner.current_capital, 0) THEN
      RAISE EXCEPTION 'رأس مال الشريك لا يكفي (المتاح: %)', v_partner.current_capital;
    END IF;

    v_capital_record := jsonb_build_object(
      'id', gen_random_uuid()::text || '_cap',
      'amount', v_amt,
      'currency', _currency,
      'originalAmount', v_orig_amt,
      'type', 'withdrawal',
      'date', now()::text,
      'notes', v_tx_note
    );

    UPDATE public.partners
       SET current_capital = round(current_capital - v_amt, 2),
           total_withdrawn = round(coalesce(total_withdrawn, 0) + v_amt, 2),
           withdrawal_history = coalesce(withdrawal_history, '[]'::jsonb) || v_withdrawal_record,
           capital_history = coalesce(capital_history, '[]'::jsonb) || v_capital_record,
           updated_at = now()
     WHERE id = _partner_id;
  ELSE
    RAISE EXCEPTION 'نوع السحب غير صالح: %', _withdrawal_type;
  END IF;

  -- تسجيل حركة السحب في الوردية النقدية إذا توفر shift_id
  IF _shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions (
      shift_id,
      user_id,
      type,
      amount,
      amount_usd,
      currency,
      currency_amount,
      notes,
      reference_id,
      created_by
    ) VALUES (
      _shift_id,
      v_owner,
      'withdrawal',
      v_orig_amt,
      v_amt,
      _currency,
      v_orig_amt,
      'سحب ' || CASE WHEN _withdrawal_type = 'capital' THEN 'رأس مال' ELSE 'أرباح' END || ' للشريك ' || v_partner.name || CASE WHEN v_tx_note <> '' THEN ' - ' || v_tx_note ELSE '' END,
      _partner_id::text,
      auth.uid()
    );

    -- خصم المبلغ من رصيد الصندوق المتوقع بالعملة المناسبة
    IF _currency = 'USD' THEN
      UPDATE public.cash_shifts SET
        expected_cash = round(COALESCE(expected_cash, 0) - v_amt, 2),
        updated_at = now()
      WHERE id = _shift_id;
    ELSIF _currency = 'TRY' THEN
      UPDATE public.cash_shifts SET
        expected_try = round(COALESCE(expected_try, 0) - v_orig_amt, 2),
        updated_at = now()
      WHERE id = _shift_id;
    ELSIF _currency = 'SYP' THEN
      UPDATE public.cash_shifts SET
        expected_syp = round(COALESCE(expected_syp, 0) - v_orig_amt, 2),
        updated_at = now()
      WHERE id = _shift_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'partner_id', _partner_id,
    'amount', v_amt,
    'original_amount', v_orig_amt,
    'currency', _currency,
    'withdrawal_type', _withdrawal_type,
    'new_balance', CASE WHEN _withdrawal_type = 'profit' THEN round(v_partner.current_balance - v_amt, 2) ELSE v_partner.current_balance END,
    'new_capital', CASE WHEN _withdrawal_type = 'capital' THEN round(v_partner.current_capital - v_amt, 2) ELSE v_partner.current_capital END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.partner_withdrawal_atomic(uuid, numeric, text, text, uuid, text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_withdrawal_atomic(uuid, numeric, text, text, uuid, text, numeric) TO service_role;
