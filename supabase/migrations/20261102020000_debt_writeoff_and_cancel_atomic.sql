-- ============================================================================
-- FlowPOS Pro: Atomic Debt Write-off & Atomic Debt Deletion RPCs
-- ============================================================================

-- Ensure notes column exists on debt_writeoffs
ALTER TABLE IF EXISTS public.debt_writeoffs
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- 1) دالة شطب الدين الذرية (Write-off)
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
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  -- الحماية من التكرار عبر operation_id
  IF _operation_id IS NOT NULL AND length(_operation_id) >= 8 THEN
    SELECT id INTO v_existing_id FROM public.debt_writeoffs 
     WHERE user_id = v_owner AND notes = _operation_id LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'already_processed', true);
    END IF;
  END IF;

  -- جلب وقفل سجل الدين
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
    user_id, expense_type, amount, description, notes, date, created_by
  ) VALUES (
    v_owner, 'debt_writeoff', v_writeoff_amt, 'إتلاف دين - ' || coalesce(v_debt.customer_name, 'عميل'), _reason, CURRENT_DATE, auth.uid()
  );

  -- 3. تحديث سجل الدين ليصبح مسوّى كلياً
  UPDATE public.debts
     SET status = 'fully_paid',
         total_paid = v_debt.total_debt,
         remaining_debt = 0,
         notes = concat_ws(E'\n', notes, '[إتلاف دين] ' || _reason),
         updated_at = now()
   WHERE id = _debt_id;

  -- 4. خفض مديونية العميل في جدول العملاء إن وُجد
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


-- 2) دالة إلغاء/حذف الدين الذرية (Compensating Debt Reversal)
CREATE OR REPLACE FUNCTION public.cancel_debt_atomic(
  _debt_id uuid,
  _reason text DEFAULT 'إلغاء الدين'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_owner_id(auth.uid());
  v_debt public.debts%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  SELECT * INTO v_debt FROM public.debts WHERE id = _debt_id FOR UPDATE;
  IF NOT FOUND OR v_debt.user_id <> v_owner THEN
    RAISE EXCEPTION 'الدين غير موجود';
  END IF;

  -- تحديث الفاتورة المرتبطة إن وجدت
  IF v_debt.invoice_id IS NOT NULL THEN
    UPDATE public.invoices
       SET status = 'paid',
           payment_type = 'cash',
           debt_paid = 0,
           debt_remaining = 0,
           updated_at = now()
     WHERE user_id = v_owner 
       AND (id::text = v_debt.invoice_id OR invoice_number = v_debt.invoice_id);
  END IF;

  -- خفض رصيد العميل
  IF v_debt.customer_id IS NOT NULL THEN
    UPDATE public.customers
       SET total_debt = GREATEST(0, coalesce(total_debt, 0) - coalesce(v_debt.remaining_debt, 0)),
           updated_at = now()
     WHERE id = v_debt.customer_id AND user_id = v_owner;
  END IF;

  -- حذف الدين (أو تعليمه كملغي)
  DELETE FROM public.debts WHERE id = _debt_id;

  RETURN jsonb_build_object('success', true, 'debt_id', _debt_id);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_debt_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_debt_atomic(uuid, text) TO authenticated;

-- Alias delete_debt_atomic to cancel_debt_atomic
CREATE OR REPLACE FUNCTION public.delete_debt_atomic(
  _debt_id uuid,
  _reason text DEFAULT 'إلغاء الدين'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.cancel_debt_atomic(_debt_id, _reason);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_debt_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_debt_atomic(uuid, text) TO authenticated;
