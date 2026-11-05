-- =============================================================================
-- UNIT 3: تصحيح دالة سداد الديون الذرية — معادلة الأقساط الرياضية السليمة
-- record_debt_payment_atomic
-- =============================================================================

CREATE OR REPLACE FUNCTION public.record_debt_payment_atomic(
  _debt_id uuid,
  _amount numeric,
  _operation_id text,
  _shift_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid := public.get_owner_id(auth.uid());
  v_debt public.debts%ROWTYPE;
  v_amount numeric := round(COALESCE(_amount, 0)::numeric, 2);
  v_prev_remaining numeric;
  v_new_remaining numeric;
  v_installment_ratio numeric := 1.0;
  p record;
  _updated_details jsonb;
  _updated_history jsonb;
  _total_confirmed numeric := 0;
  _item jsonb;
  _item_amt numeric;
  _confirm_amt numeric;
BEGIN
  -- 1) التحقق الأمني والصلاحيات
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF _operation_id IS NULL OR length(_operation_id) < 8 THEN
    RAISE EXCEPTION 'رقم العملية غير صالح';
  END IF;

  -- 2) قفل سجل الدين لمنع السباق والتعديل المتزامن
  SELECT * INTO v_debt FROM public.debts WHERE id = _debt_id FOR UPDATE;
  IF NOT FOUND OR v_debt.user_id <> v_owner THEN
    RAISE EXCEPTION 'الدين غير موجود أو لا يتبع للمتجر';
  END IF;

  -- الحماية من التكرار (Idempotency)
  IF EXISTS (SELECT 1 FROM public.debt_payments WHERE user_id = v_owner AND operation_id = _operation_id) THEN
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

  -- حفظ المتبقي قبل هذه الدفعة (المقام الصحيح لمعادلة القسط)
  v_prev_remaining := round(COALESCE(v_debt.remaining_debt, v_debt.total_debt - COALESCE(v_debt.total_paid, 0))::numeric, 2);

  IF v_amount > v_prev_remaining THEN
    RAISE EXCEPTION 'المبلغ المدخل (%) أكبر من المتبقي (%)', v_amount, v_prev_remaining;
  END IF;

  v_new_remaining := GREATEST(round(v_prev_remaining - v_amount, 2), 0);

  -- 3) تحديث سجل الدين صراحة (total_paid + remaining_debt + status في أمر واحد)
  UPDATE public.debts
     SET total_paid      = round(COALESCE(total_paid, 0) + v_amount, 2),
         remaining_debt  = v_new_remaining,
         status          = CASE WHEN v_new_remaining <= 0 THEN 'fully_paid' ELSE 'partially_paid' END,
         updated_at      = now()
   WHERE id = _debt_id
  RETURNING * INTO v_debt;

  -- 4) تسجيل حركة الدفعة وتوثيق الوردية
  INSERT INTO public.debt_payments(user_id, debt_id, operation_id, amount, paid_by, shift_id)
  VALUES (v_owner, _debt_id, _operation_id, v_amount, auth.uid(), _shift_id);

  -- 5) قيد الحركة في حركات الوردية وتحديث الرصيد المتوقع للصندوق
  IF _shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions(shift_id, user_id, type, amount, reference_id, notes)
    VALUES (_shift_id, v_owner, 'debt_payment', v_amount, _operation_id, 'تسديد دين للعميل: ' || COALESCE(v_debt.customer_name, ''))
    ON CONFLICT (shift_id, type, reference_id) DO NOTHING;

    UPDATE public.cash_shifts
       SET expected_balance = round(expected_balance + v_amount, 2),
           updated_at = now()
     WHERE id = _shift_id AND closed_at IS NULL;
  END IF;

  -- 6) تحديث الفاتورة المرتبطة
  IF v_debt.invoice_id IS NOT NULL AND NOT COALESCE(v_debt.is_cash_debt, false) THEN
    UPDATE public.invoices i
       SET debt_paid      = v_debt.total_paid,
           debt_remaining = v_debt.remaining_debt,
           status         = CASE
             WHEN i.status IN ('refunded', 'cancelled') THEN i.status
             WHEN v_debt.remaining_debt <= 0 THEN 'paid'
             ELSE 'pending'
           END,
           updated_at = now()
     WHERE i.user_id = v_owner
       AND (i.invoice_number = v_debt.invoice_id OR i.id::text = v_debt.invoice_id);

    -- 7) تحرير أرباح الشركاء بالمعادلة الرياضية الصحيحة
    --    النسبة = الدفعة / المتبقي قبلها  (وليس / إجمالي الدين)
    --    عند إغلاق الدين نهائياً → تحرير 100% بما تبقى
    IF v_prev_remaining > 0 THEN
      IF v_new_remaining <= 0 THEN
        v_installment_ratio := 1.0; -- إبراء الذمة كاملاً 100%
      ELSE
        v_installment_ratio := LEAST(1.0, round(v_amount / v_prev_remaining, 6));
      END IF;

      FOR p IN
        SELECT * FROM public.partners
         WHERE user_id = v_owner AND pending_profit > 0
         FOR UPDATE
      LOOP
        _updated_details := '[]'::jsonb;
        _updated_history := '[]'::jsonb;
        _total_confirmed := 0;

        FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.pending_profit_details, '[]'::jsonb))
        LOOP
          IF (_item->>'invoiceId') = v_debt.invoice_id THEN
            _item_amt := COALESCE((_item->>'amount')::numeric, 0);

            IF v_new_remaining <= 0 THEN
              -- إغلاق تام: تحرير كل ما تبقى معلقاً لهذه الفاتورة
              _confirm_amt := _item_amt;
            ELSE
              _confirm_amt := round(_item_amt * v_installment_ratio, 2);
              -- الاحتفاظ بالباقي المعلق
              IF (_item_amt - _confirm_amt) > 0.001 THEN
                _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_item_amt - _confirm_amt, 2)));
              END IF;
            END IF;

            _total_confirmed := _total_confirmed + _confirm_amt;
          ELSE
            _updated_details := _updated_details || _item;
          END IF;
        END LOOP;

        IF _total_confirmed > 0 THEN
          -- تعديل isDebt في سجل الربح من true → false
          FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb))
          LOOP
            IF (_item->>'invoiceId') = v_debt.invoice_id AND COALESCE((_item->>'isDebt')::boolean, false) = true THEN
              _updated_history := _updated_history || jsonb_set(_item, '{isDebt}', 'false'::jsonb);
            ELSE
              _updated_history := _updated_history || _item;
            END IF;
          END LOOP;

          UPDATE public.partners
             SET pending_profit        = GREATEST(0, round(COALESCE(pending_profit, 0) - _total_confirmed, 2)),
                 confirmed_profit      = round(COALESCE(confirmed_profit, 0) + _total_confirmed, 2),
                 current_balance       = round(COALESCE(current_balance, 0) + _total_confirmed, 2),
                 total_profit_earned   = round(COALESCE(total_profit_earned, 0) + _total_confirmed, 2),
                 pending_profit_details = _updated_details,
                 profit_history        = _updated_history,
                 updated_at            = now()
           WHERE id = p.id;
        END IF;
      END LOOP;
    END IF;
  END IF;

  -- 8) تحديث إجمالي ديون العميل
  IF v_debt.customer_name IS NOT NULL THEN
    UPDATE public.customers
       SET total_debt = GREATEST(round(COALESCE(total_debt, 0) - v_amount, 2), 0),
           updated_at = now()
     WHERE user_id = v_owner
       AND (name = v_debt.customer_name
         OR (v_debt.customer_phone IS NOT NULL AND phone = v_debt.customer_phone));
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'total_debt', v_debt.total_debt,
    'total_paid', v_debt.total_paid,
    'remaining_debt', v_debt.remaining_debt,
    'status', v_debt.status,
    'amount', v_amount,
    'confirmed_profit', _total_confirmed
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_debt_payment_atomic(uuid, numeric, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_debt_payment_atomic(uuid, numeric, text, uuid) TO authenticated;
