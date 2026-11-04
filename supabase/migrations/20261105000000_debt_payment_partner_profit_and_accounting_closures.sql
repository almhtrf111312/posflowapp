-- =========================================================================
-- Migration: 20261105000000_debt_payment_partner_profit_and_accounting_closures.sql
-- Description:
-- 1) Plan 7: Atomic debt payment (record_debt_payment_atomic) with active shift
--    linking, expected balance update, and immediate proportional partner profit
--    release from pending_profit to confirmed_profit and current_balance.
-- 2) Plan 8: Smart financial reporting & audit closure:
--    - Table: accounting_period_closures with RLS store isolation
--    - Function: close_accounting_period_atomic to compute and record tamper-proof period closures.
-- =========================================================================

-- ========================================================
-- 1) دالة تسديد الدين الذرية مع الربط بالوردية وتحرير أرباح الشركاء فورياً
-- ========================================================
DROP FUNCTION IF EXISTS public.record_debt_payment_atomic(uuid, numeric, text);
DROP FUNCTION IF EXISTS public.record_debt_payment_atomic(uuid, numeric, text, uuid);

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
  v_amount numeric := round(coalesce(_amount, 0)::numeric, 2);
  v_payment_ratio numeric;
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
  
  IF v_amount > round(v_debt.remaining_debt::numeric, 2) THEN
    RAISE EXCEPTION 'المبلغ المدخل (%) أكبر من المتبقي (%)', v_amount, round(v_debt.remaining_debt::numeric, 2);
  END IF;

  -- 3) تحديث سجل الدين
  UPDATE public.debts 
     SET total_paid = coalesce(total_paid, 0) + v_amount, 
         updated_at = now()
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
       SET expected_balance = expected_balance + v_amount,
           updated_at = now()
     WHERE id = _shift_id AND closed_at IS NULL;
  END IF;

  -- 6) تحديث الفاتورة المرتبطة
  IF v_debt.invoice_id IS NOT NULL AND NOT coalesce(v_debt.is_cash_debt, false) THEN
    UPDATE public.invoices i
       SET debt_paid = v_debt.total_paid,
           debt_remaining = v_debt.remaining_debt,
           status = CASE 
             WHEN i.status IN ('refunded', 'cancelled') THEN i.status
             WHEN v_debt.remaining_debt <= 0 THEN 'paid' 
             ELSE 'pending' 
           END,
           updated_at = now()
     WHERE i.user_id = v_owner
       AND (i.invoice_number = v_debt.invoice_id OR i.id::text = v_debt.invoice_id);

    -- 7) تحرير أرباح الشركاء بنسبة الدفعة المسددة فوراً
    IF COALESCE(v_debt.total_debt, 0) > 0 THEN
      v_payment_ratio := LEAST(1.0, round(v_amount / v_debt.total_debt, 6));

      FOR p IN 
        SELECT * FROM public.partners 
         WHERE user_id = v_owner AND pending_profit > 0 
         FOR UPDATE 
      LOOP
        _updated_details := '[]'::jsonb;
        _total_confirmed := 0;

        FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.pending_profit_details, '[]'::jsonb))
        LOOP
          IF (_item->>'invoiceId') = v_debt.invoice_id THEN
            _item_amt := (_item->>'amount')::numeric;
            _confirm_amt := round(_item_amt * v_payment_ratio, 2);
            _total_confirmed := _total_confirmed + _confirm_amt;

            -- الاحتفاظ بباقي الربح المعلق إن لم يُسدد الدين كاملاً
            IF (_item_amt - _confirm_amt) > 0.01 THEN
              _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_item_amt - _confirm_amt, 2)));
            END IF;
          ELSE
            _updated_details := _updated_details || _item;
          END IF;
        END LOOP;

        IF _total_confirmed > 0 THEN
          _updated_history := '[]'::jsonb;
          FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb))
          LOOP
            IF (_item->>'invoiceId') = v_debt.invoice_id AND (_item->>'isDebt')::boolean = true THEN
              _updated_history := _updated_history || jsonb_set(_item, '{isDebt}', 'false'::jsonb);
            ELSE
              _updated_history := _updated_history || _item;
            END IF;
          END LOOP;

          -- نقل المبلغ المحرر من المعلق إلى المؤكد والرصيد الجاهز للسحب
          UPDATE public.partners
             SET pending_profit = GREATEST(0, round(COALESCE(pending_profit, 0) - _total_confirmed, 2)),
                 confirmed_profit = round(COALESCE(confirmed_profit, 0) + _total_confirmed, 2),
                 current_balance = round(COALESCE(current_balance, 0) + _total_confirmed, 2),
                 total_profit_earned = round(COALESCE(total_profit_earned, 0) + _total_confirmed, 2),
                 pending_profit_details = _updated_details,
                 profit_history = _updated_history,
                 updated_at = now()
           WHERE id = p.id;
        END IF;
      END LOOP;
    END IF;
  END IF;

  -- 8) تحديث رصيد العميل الإجمالي
  IF v_debt.customer_name IS NOT NULL THEN
    UPDATE public.customers
       SET total_debt = GREATEST(COALESCE(total_debt, 0) - v_amount, 0),
           updated_at = now()
     WHERE user_id = v_owner
       AND (name = v_debt.customer_name OR (v_debt.customer_phone IS NOT NULL AND phone = v_debt.customer_phone));
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
$function$;

GRANT EXECUTE ON FUNCTION public.record_debt_payment_atomic(uuid, numeric, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_debt_payment_atomic(uuid, numeric, text, uuid) TO service_role;

-- ========================================================
-- 2) جدول إقفال الفترات المحاسبية (Accounting Periods)
-- ========================================================
CREATE TABLE IF NOT EXISTS public.accounting_period_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  total_revenue numeric NOT NULL DEFAULT 0,
  total_cogs numeric NOT NULL DEFAULT 0,
  gross_profit numeric NOT NULL DEFAULT 0,
  total_expenses numeric NOT NULL DEFAULT 0,
  net_profit numeric NOT NULL DEFAULT 0,
  partner_distributions jsonb NOT NULL DEFAULT '[]'::jsonb,
  closed_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.accounting_period_closures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Store isolation closures" ON public.accounting_period_closures;
CREATE POLICY "Store isolation closures" ON public.accounting_period_closures
  FOR ALL TO authenticated
  USING (user_id = public.get_owner_id(auth.uid()))
  WITH CHECK (user_id = public.get_owner_id(auth.uid()));

-- ========================================================
-- 3) دالة توليد ملخص الفترة وإقفالها وتوثيق حصص الشركاء
-- ========================================================
CREATE OR REPLACE FUNCTION public.close_accounting_period_atomic(
  _period_start date,
  _period_end date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _rev numeric := 0;
  _cogs numeric := 0;
  _exp numeric := 0;
  _gross numeric := 0;
  _net numeric := 0;
  _partner_summary jsonb := '[]'::jsonb;
  _closure_id uuid;
  p record;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN 
    RAISE EXCEPTION 'غير مصرح'; 
  END IF;

  -- 1) حساب إجمالي الإيرادات وتكلفة البضاعة المباعة للفترة (باستثناء المرتجع والملغى)
  SELECT 
    COALESCE(SUM(subtotal - COALESCE(discount, 0)), 0),
    COALESCE(SUM(total_cost), 0)
    INTO _rev, _cogs
    FROM public.invoices
   WHERE user_id = _owner
     AND status NOT IN ('refunded', 'cancelled', 'written_off')
     AND created_at::date BETWEEN _period_start AND _period_end;

  -- 2) حساب المصاريف لنفس الفترة
  SELECT COALESCE(SUM(amount), 0) INTO _exp
    FROM public.expenses
   WHERE user_id = _owner
     AND created_at::date BETWEEN _period_start AND _period_end;

  _gross := round(_rev - _cogs, 2);
  _net := round(_gross - _exp, 2);

  -- 3) تجميع توزيعات الشركاء للفترة
  FOR p IN 
    SELECT id, name, confirmed_profit, current_balance, total_profit_earned 
      FROM public.partners 
     WHERE user_id = _owner 
  LOOP
    _partner_summary := _partner_summary || jsonb_build_object(
      'partner_id', p.id,
      'partner_name', p.name,
      'current_balance', p.current_balance,
      'confirmed_profit', p.confirmed_profit,
      'total_earned', p.total_profit_earned
    );
  END LOOP;

  -- 4) تسجيل قيد الإقفال في السجل التاريخي المحمي
  INSERT INTO public.accounting_period_closures (
    user_id, period_start, period_end, total_revenue, total_cogs,
    gross_profit, total_expenses, net_profit, partner_distributions, closed_by
  ) VALUES (
    _owner, _period_start, _period_end, _rev, _cogs,
    _gross, _exp, _net, _partner_summary, _caller
  ) RETURNING id INTO _closure_id;

  RETURN jsonb_build_object(
    'success', true,
    'closure_id', _closure_id,
    'period_start', _period_start,
    'period_end', _period_end,
    'revenue', _rev,
    'cogs', _cogs,
    'gross_profit', _gross,
    'expenses', _exp,
    'net_profit', _net,
    'partners', _partner_summary
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.close_accounting_period_atomic(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_accounting_period_atomic(date, date) TO service_role;
