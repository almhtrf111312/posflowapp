-- add_expense_atomic(_operation_id text, _expense_type text, _amount numeric, _description text, _date date, _notes text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

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
  _active_shift_id uuid;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF _amt <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;

  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN RAISE EXCEPTION 'لم يتم العثور على حساب المالك'; END IF;

  -- تحويل المعرف إلى UUID بأمان
  BEGIN
    _op_uuid := _operation_id::uuid;
  EXCEPTION WHEN OTHERS THEN
    _op_uuid := gen_random_uuid();
  END;

  -- منع التكرار (Idempotency)
  IF EXISTS (SELECT 1 FROM public.expenses WHERE id = _op_uuid) THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'id', _op_uuid);
  END IF;

  -- استقطاع حصص الشركاء المشاركين في المصاريف
  FOR p IN 
    SELECT * FROM public.partners 
    WHERE user_id = _owner 
    FOR UPDATE 
  LOOP
    -- استخدام نسبة المصاريف إن وُجدت، أو النسبة العامة
    _pct := coalesce(p.expense_share_percentage, p.share_percentage, 0);

    IF _pct > 0 THEN
      -- حساب حصة الشريك: القيمة * (النسبة / 100)
      _part := round(_amt * (_pct / 100.0), 2);

      IF _part > 0 THEN
        _dist := _dist || jsonb_build_object(
          'partnerId', p.id,
          'partnerName', p.name,
          'amount', _part,
          'percentage', _pct
        );

        -- خصم الحصة من رصيد الشريك وتسجيلها في مصفوفة تاريخ المصاريف
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

  -- إدراج سجل المصروف بتوزيعاته
  INSERT INTO public.expenses(
    id, user_id, expense_type, amount, description, date, notes, distributions, cashier_id
  ) VALUES (
    _op_uuid, _owner, _expense_type, _amt, _description, coalesce(_date, CURRENT_DATE), _notes, _dist, _uid
  );

  -- حركة الصندوق تسجلها الواجهة مرة واحدة بعملة المصروف الأصلية (منع الخصم المزدوج من الوردية)

  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'id', _op_uuid,
    'distributions', _dist
  );
END;
$function$
;
