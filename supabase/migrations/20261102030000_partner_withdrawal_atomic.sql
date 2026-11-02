-- ============================================================================
-- FlowPOS Pro: Atomic Partner Withdrawal with Cash Ledger Entry
-- ============================================================================

CREATE OR REPLACE FUNCTION public.partner_withdrawal_atomic(
  _partner_id uuid,
  _amount numeric,
  _withdrawal_type text, -- 'profit' OR 'capital'
  _notes text DEFAULT '',
  _shift_id uuid DEFAULT NULL
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
  v_withdrawal_record jsonb;
  v_capital_record jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF v_amt <= 0 THEN
    RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر';
  END IF;

  -- قفل سجل الشريك
  SELECT * INTO v_partner FROM public.partners WHERE id = _partner_id FOR UPDATE;
  IF NOT FOUND OR v_partner.user_id <> v_owner THEN
    RAISE EXCEPTION 'الشريك غير موجود أو غير تابع للمتجر';
  END IF;

  v_withdrawal_record := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'amount', v_amt,
    'type', _withdrawal_type,
    'date', now()::text,
    'notes', coalesce(_notes, '')
  );

  IF _withdrawal_type = 'profit' THEN
    IF v_amt > coalesce(v_partner.current_balance, 0) THEN
      RAISE EXCEPTION 'رصيد أرباح الشريك لا يكفي (المتاح: %)', v_partner.current_balance;
    END IF;

    UPDATE public.partners
       SET current_balance = current_balance - v_amt,
           total_withdrawn = coalesce(total_withdrawn, 0) + v_amt,
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
      'type', 'withdrawal',
      'date', now()::text,
      'notes', coalesce(_notes, '')
    );

    UPDATE public.partners
       SET current_capital = current_capital - v_amt,
           total_withdrawn = coalesce(total_withdrawn, 0) + v_amt,
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
      shift_id, user_id, type, amount, notes, reference_id
    ) VALUES (
      _shift_id, v_owner, 'withdrawal', v_amt,
      'سحب ' || CASE WHEN _withdrawal_type = 'capital' THEN 'رأس مال' ELSE 'أرباح' END || ' للشريك ' || v_partner.name || CASE WHEN _notes IS NOT NULL AND _notes <> '' THEN ' - ' || _notes ELSE '' END,
      _partner_id::text
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'partner_id', _partner_id,
    'amount', v_amt,
    'withdrawal_type', _withdrawal_type,
    'new_balance', CASE WHEN _withdrawal_type = 'profit' THEN v_partner.current_balance - v_amt ELSE v_partner.current_balance END,
    'new_capital', CASE WHEN _withdrawal_type = 'capital' THEN v_partner.current_capital - v_amt ELSE v_partner.current_capital END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.partner_withdrawal_atomic(uuid, numeric, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_withdrawal_atomic(uuid, numeric, text, text, uuid) TO authenticated;
