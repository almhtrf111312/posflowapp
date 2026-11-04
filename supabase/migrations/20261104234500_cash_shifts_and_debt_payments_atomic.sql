-- =============================================================================
-- Task 3: Cash Shifts, Debt Payments, Shift Transactions & Proportional Profit
-- =============================================================================

-- 1. إضافة عمود shift_id لجدول دفعات الديون لربط كل تسديد بوردية الصندوق
ALTER TABLE IF EXISTS public.debt_payments 
  ADD COLUMN IF NOT EXISTS shift_id uuid;

-- 2. فهرس فريد لمنع تكرار حركات الوردية المتزامنة
CREATE UNIQUE INDEX IF NOT EXISTS shift_tx_ref_uniq
  ON public.shift_transactions(shift_id, type, reference_id);

-- 3. تنظيف التوقيع القديم لدالة تسجيل دفعة الدين
DROP FUNCTION IF EXISTS public.record_debt_payment_atomic(uuid, numeric, text);
DROP FUNCTION IF EXISTS public.record_debt_payment_atomic(uuid, numeric, text, uuid);

-- 4. إعادة بناء دالة تسجيل دفعة الدين الذرية المترابطة مع الوردية وأرباح الشركاء
CREATE OR REPLACE FUNCTION public.record_debt_payment_atomic(
  _debt_id uuid, 
  _amount numeric, 
  _operation_id text,
  _shift_id uuid DEFAULT NULL
)
RETURNS jsonb 
LANGUAGE plpgsql 
SECURITY DEFINER 
SET search_path = public 
AS $$
DECLARE
  v_owner uuid := public.get_owner_id(auth.uid());
  v_debt public.debts%ROWTYPE;
  v_amount numeric := round(coalesce(_amount, 0)::numeric, 2);
  v_payment_ratio numeric;
  v_inv_number text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN 
    RAISE EXCEPTION 'غير مصرح'; 
  END IF;

  IF _operation_id IS NULL OR length(trim(_operation_id)) < 8 THEN 
    RAISE EXCEPTION 'رقم العملية غير صالح'; 
  END IF;

  SELECT * INTO v_debt FROM public.debts WHERE id = _debt_id FOR UPDATE;
  IF NOT FOUND OR v_debt.user_id <> v_owner THEN 
    RAISE EXCEPTION 'الدين غير موجود أو غير تابع للمتجر'; 
  END IF;

  -- فحص التكرار (Idempotency)
  IF EXISTS (SELECT 1 FROM public.debt_payments WHERE user_id = v_owner AND operation_id = trim(_operation_id)) THEN
    RETURN jsonb_build_object(
      'success', true, 
      'already_processed', true,
      'total_debt', v_debt.total_debt, 
      'total_paid', v_debt.total_paid,
      'remaining_debt', v_debt.remaining_debt, 
      'status', v_debt.status, 
      'amount', 0
    );
  END IF;

  IF v_amount <= 0 THEN 
    RAISE EXCEPTION 'أدخل مبلغًا صحيحًا أكبر من الصفر'; 
  END IF;

  IF v_amount > round(v_debt.remaining_debt::numeric, 2) THEN
    RAISE EXCEPTION 'المبلغ (%) أكبر من المتبقي (%)', v_amount, round(v_debt.remaining_debt::numeric, 2);
  END IF;

  -- احتساب نسبة السداد من إجمالي الدين لتحرير الأرباح بنسبة وتناسب
  IF coalesce(v_debt.total_debt, 0) > 0 THEN
    v_payment_ratio := LEAST(round(v_amount / v_debt.total_debt, 6), 1.0);
  ELSE
    v_payment_ratio := 1.0;
  END IF;

  -- تحديث سجل الدين (total_paid و remaining_debt)
  UPDATE public.debts 
  SET total_paid = round(coalesce(total_paid, 0) + v_amount, 2), 
      updated_at = now()
  WHERE id = _debt_id 
  RETURNING * INTO v_debt;

  -- إدراج دفعة الدين مع ربطها بالوردية
  INSERT INTO public.debt_payments(user_id, debt_id, operation_id, amount, paid_by, shift_id)
  VALUES (v_owner, _debt_id, trim(_operation_id), v_amount, auth.uid(), _shift_id);

  -- تسجيل الحركة في الوردية وتحديث الرصيد المتوقع للصندوق
  IF _shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions(shift_id, user_id, type, amount, reference_id, notes)
    VALUES (_shift_id, v_owner, 'debt_payment', v_amount, trim(_operation_id), 'تسديد دين: ' || coalesce(v_debt.customer_name, 'عميل'))
    ON CONFLICT (shift_id, type, reference_id) DO NOTHING;

    UPDATE public.cash_shifts 
    SET expected_balance = round(coalesce(expected_balance, 0) + v_amount, 2),
        updated_at = now()
    WHERE id = _shift_id AND closed_at IS NULL;
  END IF;

  -- تأكيد أرباح الشركاء المعلقة بنسبة وتناسب عند كل دفعة مسددة
  v_inv_number := v_debt.invoice_id;
  IF v_inv_number IS NOT NULL AND v_inv_number <> '' AND v_payment_ratio > 0 THEN
    PERFORM public.confirm_partner_debt_profit_atomic(v_inv_number, v_payment_ratio);
  END IF;

  RETURN jsonb_build_object(
    'success', true, 
    'already_processed', false,
    'total_debt', v_debt.total_debt, 
    'total_paid', v_debt.total_paid,
    'remaining_debt', v_debt.remaining_debt, 
    'status', v_debt.status, 
    'amount', v_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_debt_payment_atomic(uuid, numeric, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_debt_payment_atomic(uuid, numeric, text, uuid) TO authenticated;

-- 5. تحديث دالة شطب الدين الذرية لتصفير الأرباح المعلقة للشركاء
CREATE OR REPLACE FUNCTION public.writeoff_debt_atomic(
  _debt_id uuid,
  _reason text,
  _operation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_owner_id(auth.uid());
  v_debt public.debts%ROWTYPE;
  v_writeoff_amt numeric;
  v_existing_id uuid;
  p record;
  _updated_details jsonb;
  _pending_removed numeric;
  _item jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  -- فحص التكرار (Idempotency)
  IF _operation_id IS NOT NULL AND length(_operation_id) >= 8 THEN
    SELECT id INTO v_existing_id FROM public.debt_writeoffs 
     WHERE user_id = v_owner AND notes = _operation_id LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'already_processed', true);
    END IF;
  END IF;

  -- قفل سجل الدين
  SELECT * INTO v_debt FROM public.debts WHERE id = _debt_id FOR UPDATE;
  IF NOT FOUND OR v_debt.user_id <> v_owner THEN
    RAISE EXCEPTION 'الدين غير موجود أو غير تابع للمتجر';
  END IF;

  v_writeoff_amt := round(coalesce(v_debt.remaining_debt, 0)::numeric, 2);
  IF v_writeoff_amt <= 0 THEN
    RETURN jsonb_build_object('success', true, 'already_settled', true);
  END IF;

  -- 1. تسجيل إتلاف الدين
  INSERT INTO public.debt_writeoffs (
    user_id, debt_id, customer_name, amount, reason, capital_impact, written_off_by, notes
  ) VALUES (
    v_owner, _debt_id, v_debt.customer_name, v_writeoff_amt, _reason, v_writeoff_amt, auth.uid(), coalesce(_operation_id, '')
  );

  -- 2. تسجيل مصروف إتلاف الدين
  INSERT INTO public.expenses (
    user_id, expense_type, amount, description, notes, date, cashier_id
  ) VALUES (
    v_owner, 'debt_writeoff', v_writeoff_amt, 'إتلاف دين - ' || coalesce(v_debt.customer_name, 'عميل'), _reason, CURRENT_DATE, auth.uid()
  );

  -- 3. تحديث سجل الدين ليصبح مشطوباً كلياً
  UPDATE public.debts
     SET status = 'fully_paid',
          total_paid = v_debt.total_debt,
          remaining_debt = 0,
          notes = concat_ws(E'\n', notes, '[إتلاف دين] ' || _reason),
          updated_at = now()
   WHERE id = _debt_id;

  -- 4. تصفير الربح المعلق للشركاء المرتبط بهذه الفاتورة
  IF v_debt.invoice_id IS NOT NULL AND v_debt.invoice_id <> '' THEN
    FOR p IN 
      SELECT * FROM public.partners 
      WHERE user_id = v_owner AND pending_profit > 0 
      FOR UPDATE 
    LOOP
      _updated_details := '[]'::jsonb;
      _pending_removed := 0;

      FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.pending_profit_details, '[]'::jsonb))
      LOOP
        IF (_item->>'invoiceId') = v_debt.invoice_id THEN
          _pending_removed := _pending_removed + COALESCE((_item->>'amount')::numeric, 0);
        ELSE
          _updated_details := _updated_details || _item;
        END IF;
      END LOOP;

      IF _pending_removed > 0 THEN
        UPDATE public.partners
        SET
          pending_profit = GREATEST(0, round(COALESCE(pending_profit, 0) - _pending_removed, 2)),
          pending_profit_details = _updated_details,
          updated_at = now()
        WHERE id = p.id;
      END IF;
    END LOOP;
  END IF;

  -- 5. خفض مديونية العميل في جدول العملاء إن وُجد
  IF v_debt.customer_id IS NOT NULL THEN
    UPDATE public.customers
       SET total_debt = GREATEST(0, coalesce(total_debt, 0) - v_writeoff_amt),
           updated_at = now()
     WHERE id = v_debt.customer_id AND user_id = v_owner;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'writeoff_amount', v_writeoff_amt,
    'customer_name', v_debt.customer_name
  );
END;
$$;

REVOKE ALL ON FUNCTION public.writeoff_debt_atomic(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.writeoff_debt_atomic(uuid, text, text) TO authenticated;
