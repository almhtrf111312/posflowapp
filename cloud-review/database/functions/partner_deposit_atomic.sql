-- partner_deposit_atomic(_partner_id uuid, _amount_usd numeric, _deposit_target text, _notes text, _shift_id uuid, _currency text, _original_amount numeric)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.partner_deposit_atomic(_partner_id uuid, _amount_usd numeric, _deposit_target text DEFAULT 'capital'::text, _notes text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT 'USD'::text, _original_amount numeric DEFAULT NULL::numeric)
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

  -- قفل سجل الشريك للحماية من تضارب المعاملات
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
    'originalAmount', _orig_amt,
    'date', now(),
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
      type,
      amount,
      amount_usd,
      currency,
      notes,
      reference_id,
      created_by
    ) VALUES (
      _shift_id,
      'deposit',
      round(_orig_amt, 2),
      round(_amount_usd, 2),
      _currency,
      _tx_note || ' - الشريك: ' || _partner.name,
      _partner_id::text,
      _uid
    );

    -- تحديث رصيد الصندوق بالعملة المناسبة
    -- الرصيد المتوقع للوردية يُحسب عند الإقفال من حركات الوردية (أعمدة expected_cash/try/syp غير موجودة)
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
$function$
;
