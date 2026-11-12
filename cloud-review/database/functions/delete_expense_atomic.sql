-- delete_expense_atomic(_expense_id uuid, _reason text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

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
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  SELECT * INTO _exp FROM public.expenses WHERE id = _expense_id AND user_id = _owner FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'المصروف غير موجود');
  END IF;

  IF COALESCE(_exp.is_reversed, false) = true THEN
    RETURN jsonb_build_object('success', true, 'already_reversed', true);
  END IF;

  -- لا يُحذف مصروف بتاريخ يقع داخل فترة محاسبية مغلقة
  PERFORM public.assert_period_open(_owner, _exp.date, 'حذف المصروف');

  -- 1) إعادة المبالغ المستقطعة إلى أرصدة الشركاء
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

  -- 2) توثيق حركة تسوية في الوردية النشطة لإرجاع المبلغ للصندوق
  SELECT id INTO _active_shift_id
  FROM public.cash_shifts
  WHERE user_id = _owner 
    AND closed_at IS NULL
  ORDER BY opened_at DESC
  LIMIT 1;

  IF _active_shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions(
      shift_id, user_id, type, amount, reference_id, notes
    ) VALUES (
      _active_shift_id, _owner, 'expense_refund', _exp.amount, _expense_id::text, 
      'إلغاء واسترجاع مصروف: ' || COALESCE(_reason, '')
    );
  END IF;

  -- 3) وسم المصروف كمعكوس
  UPDATE public.expenses SET
    is_reversed = true,
    reversed_at = now(),
    reversed_reason = _reason
  WHERE id = _expense_id;

  RETURN jsonb_build_object('success', true, 'expense_id', _expense_id);
END;
$function$
;
