-- =============================================================================
-- Task 2: Partners, Profit Allocation, Expense Sharing & Debt Profit Confirmation
-- =============================================================================

-- 1. تنظيف التواقيع القديمة لمنع خطأ function is not unique
DROP FUNCTION IF EXISTS public.add_expense_atomic(uuid, text, numeric, text, date, text);
DROP FUNCTION IF EXISTS public.add_expense_atomic(uuid, text, numeric, text, date, text, text);

-- 2. إنشاء الدالة الذرية المصححة محاسبياً
CREATE OR REPLACE FUNCTION public.add_expense_atomic(
  _operation_id uuid,
  _expense_type text,
  _amount numeric,
  _description text,
  _date date,
  _notes text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _owner uuid;
  _amt numeric := round(COALESCE(_amount, 0), 2);
  _dist jsonb := '[]'::jsonb;
  p record;
  _partner_pct numeric;
  _part numeric;
BEGIN
  IF _uid IS NULL THEN 
    RAISE EXCEPTION 'المستخدم غير مسجل الدخول'; 
  END IF;

  IF _amt <= 0 THEN 
    RAISE EXCEPTION 'قيمة المصروف غير صالحة'; 
  END IF;

  _owner := public.get_owner_id(_uid);

  -- التحقق من عدم تكرار العملية (Idempotency)
  IF EXISTS (SELECT 1 FROM public.expenses WHERE id = _operation_id) THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'id', _operation_id);
  END IF;

  -- استقطاع حصة كل شريك بناءً على نسبته الصريحة المحددة من المصروف الإجمالي
  FOR p IN 
    SELECT * FROM public.partners 
    WHERE user_id = _owner AND is_active IS NOT FALSE 
    FOR UPDATE 
  LOOP
    -- استخدام نسبة المصاريف المخصصة إن وجدت، أو نسبة الأرباح كبديل تلقائي
    _partner_pct := COALESCE(p.expense_share_percentage, p.share_percentage, 0);

    -- استقطاع النسبة المئوية المباشرة: (المبلغ * النسبة / 100)
    IF _partner_pct > 0 THEN
      _part := round((_amt * (_partner_pct / 100.0)), 2);
      
      IF _part > 0 THEN
        _dist := _dist || jsonb_build_object(
          'partnerId', p.id,
          'partnerName', p.name,
          'amount', _part,
          'percentage', _partner_pct
        );

        -- خصم الحصة من رصيد الشريك وتسجيلها في سجله التاريخي
        UPDATE public.partners 
        SET
          current_balance = round(COALESCE(current_balance, 0) - _part, 2),
          expense_history = COALESCE(expense_history, '[]'::jsonb) || jsonb_build_object(
            'expenseId', _operation_id::text,
            'type', _expense_type,
            'amount', _part,
            'date', COALESCE(_date, CURRENT_DATE),
            'notes', _notes,
            'createdAt', now()
          ),
          updated_at = now()
        WHERE id = p.id;
      END IF;
    END IF;
  END LOOP;

  -- إدراج المصروف مع التوزيعات الموثقة
  INSERT INTO public.expenses(
    id, user_id, expense_type, amount, description, 
    date, notes, distributions, cashier_id
  ) VALUES (
    _operation_id, _owner, _expense_type, _amt, _description, 
    COALESCE(_date, CURRENT_DATE), _notes, _dist, _uid
  );

  RETURN jsonb_build_object(
    'success', true, 
    'already_processed', false, 
    'id', _operation_id, 
    'distributions', _dist
  );
END;
$$;

REVOKE ALL ON FUNCTION public.add_expense_atomic(uuid, text, numeric, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_expense_atomic(uuid, text, numeric, text, date, text) TO authenticated;

-- 3. دالة ذرية لتأكيد أرباح الديون عند سداد العميل في الخادم
CREATE OR REPLACE FUNCTION public.confirm_partner_debt_profit_atomic(
  _invoice_id text,
  _payment_ratio numeric -- النسبة المسددة من 0.0 إلى 1.0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _owner uuid := public.get_owner_id(auth.uid());
  p record;
  _updated_details jsonb;
  _updated_history jsonb;
  _total_confirmed numeric := 0;
  _item jsonb;
  _item_amt numeric;
  _confirm_amt numeric;
BEGIN
  IF _owner IS NULL OR _payment_ratio <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_params');
  END IF;

  FOR p IN 
    SELECT * FROM public.partners 
    WHERE user_id = _owner 
      AND pending_profit > 0 
    FOR UPDATE 
  LOOP
    _updated_details := '[]'::jsonb;
    _total_confirmed := 0;

    -- مراجعة تفاصيل الأرباح المعلقة للفاتورة المسددة
    FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.pending_profit_details, '[]'::jsonb))
    LOOP
      IF (_item->>'invoiceId') = _invoice_id THEN
        _item_amt := (_item->>'amount')::numeric;
        _confirm_amt := round(_item_amt * LEAST(_payment_ratio, 1.0), 2);
        _total_confirmed := _total_confirmed + _confirm_amt;

        -- الاحتفاظ بالمتبقي إن وجد
        IF (_item_amt - _confirm_amt) > 0.01 THEN
          _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_item_amt - _confirm_amt, 2)));
        END IF;
      ELSE
        _updated_details := _updated_details || _item;
      END IF;
    END LOOP;

    -- إذا وجد ربح معلق لهذه الفاتورة، يُحرر فوراً إلى الرصيد المؤكد
    IF _total_confirmed > 0 THEN
      -- تحديث السجل التاريخي للأرباح
      _updated_history := '[]'::jsonb;
      FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb))
      LOOP
        IF (_item->>'invoiceId') = _invoice_id AND (_item->>'isDebt')::boolean = true THEN
          _updated_history := _updated_history || jsonb_set(_item, '{isDebt}', 'false'::jsonb);
        ELSE
          _updated_history := _updated_history || _item;
        END IF;
      END LOOP;

      UPDATE public.partners
      SET
        pending_profit = GREATEST(0, round(COALESCE(pending_profit, 0) - _total_confirmed, 2)),
        confirmed_profit = round(COALESCE(confirmed_profit, 0) + _total_confirmed, 2),
        current_balance = round(COALESCE(current_balance, 0) + _total_confirmed, 2),
        total_profit_earned = round(COALESCE(total_profit_earned, 0) + _total_confirmed, 2),
        pending_profit_details = _updated_details,
        profit_history = _updated_history,
        updated_at = now()
      WHERE id = p.id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'invoice_id', _invoice_id);
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_partner_debt_profit_atomic(text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_partner_debt_profit_atomic(text, numeric) TO authenticated;
