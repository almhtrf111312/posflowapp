-- ============================================================================
-- PosFlow — Package 3: Debts, Expenses & Shift FX Lock
-- Surgical, Idempotent Migration
-- Target: public.debt_payments, public.expenses, public.cash_shifts,
--         public.stores, public.store_settings, and atomic RPCs
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Schema additions (Idempotent)
-- ----------------------------------------------------------------------------
ALTER TABLE public.debt_payments
  ADD COLUMN IF NOT EXISTS settled_amount numeric(18,4),
  ADD COLUMN IF NOT EXISTS rounding_adjustment numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS exchange_rate numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'cash';

UPDATE public.debt_payments
   SET settled_amount = amount
 WHERE settled_amount IS NULL;

ALTER TABLE public.cash_shifts
  ADD COLUMN IF NOT EXISTS opening_exchange_rates jsonb;

-- Backfill currently open shifts that do not yet have an FX snapshot
UPDATE public.cash_shifts cs
   SET opening_exchange_rates = COALESCE(
     (SELECT NULLIF(ss.exchange_rates, '{}'::jsonb)
        FROM public.store_settings ss
       WHERE ss.user_id = cs.user_id
       LIMIT 1),
     (SELECT NULLIF(s.exchange_rates, '{}'::jsonb)
        FROM public.stores s
       WHERE s.user_id = cs.user_id
       LIMIT 1),
     '{"USD": 1}'::jsonb
   )
 WHERE cs.closed_at IS NULL
   AND cs.opening_exchange_rates IS NULL;

-- ----------------------------------------------------------------------------
-- 2. record_debt_payment_atomic
--    - Adds optional _payment_method text DEFAULT 'cash'
--    - Populates settled_amount, rounding_adjustment, currency, exchange_rate, payment_method
--    - On existing operation_id for same store: verifies debt_id & amount match (else SQLSTATE 23505)
--    - Customer name fallback requires strict uniqueness (COUNT(*) = 1)
--    - Tightens FX tolerance from 2% to fixed absolute 0.05 USD
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.record_debt_payment_atomic(
  uuid, numeric, text, uuid, text, numeric, numeric
);

CREATE OR REPLACE FUNCTION public.record_debt_payment_atomic(
  _debt_id uuid,
  _amount numeric,
  _operation_id text,
  _shift_id uuid DEFAULT NULL::uuid,
  _currency text DEFAULT NULL::text,
  _currency_amount numeric DEFAULT NULL::numeric,
  _exchange_rate numeric DEFAULT NULL::numeric,
  _payment_method text DEFAULT 'cash'::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid := public.get_owner_id(auth.uid());
  v_debt public.debts%ROWTYPE;
  v_existing_payment record;
  v_amount numeric := round(COALESCE(_amount, 0)::numeric, 4);
  v_cash_amount numeric := round(COALESCE(_amount, 0)::numeric, 2);
  v_settlement numeric;
  v_rounding_adjustment numeric(18,4) := 0;
  v_prev_remaining numeric;
  v_new_remaining numeric;
  v_new_total_paid numeric;
  v_rounding_note text := '';
  v_payment_method text := COALESCE(NULLIF(lower(trim(_payment_method)), ''), 'cash');
  v_tx_currency text := 'USD';
  v_tx_currency_amount numeric := 0;
  v_tx_exchange_rate numeric := 1;
  v_resolved_customer_id uuid;
  v_installment_ratio numeric := 1.0;
  p record;
  _updated_details jsonb;
  _updated_history jsonb;
  _total_confirmed numeric := 0;
  _item jsonb;
  _item_amt numeric;
  _confirm_amt numeric;
BEGIN
  PERFORM set_config('app.partner_source', 'record_debt_payment_atomic', true);
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF _operation_id IS NULL OR length(_operation_id) < 8 THEN
    RAISE EXCEPTION 'رقم العملية غير صالح';
  END IF;

  SELECT * INTO v_debt FROM public.debts WHERE id = _debt_id FOR UPDATE;
  IF NOT FOUND OR v_debt.user_id <> v_owner THEN
    RAISE EXCEPTION 'الدين غير موجود أو لا يتبع للمتجر';
  END IF;

  -- Idempotency check with strict payload match (debt_id + amount)
  SELECT dp.debt_id, dp.amount
    INTO v_existing_payment
    FROM public.debt_payments dp
   WHERE dp.user_id = v_owner
     AND dp.operation_id = _operation_id
   LIMIT 1;

  IF FOUND THEN
    IF v_existing_payment.debt_id <> _debt_id
       OR round(COALESCE(v_existing_payment.amount, 0)::numeric, 2) <> v_cash_amount THEN
      RAISE EXCEPTION 'تعارض في معرّف العملية (%): مستخدم مسبقاً لدين أو مبلغ مختلف', _operation_id
        USING ERRCODE = '23505';
    END IF;

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

  PERFORM public.assert_period_open(v_owner, CURRENT_DATE, 'تسديد دين');

  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'أدخل مبلغًا صحيحًا أكبر من الصفر';
  END IF;

  v_prev_remaining := round(COALESCE(v_debt.remaining_debt, v_debt.total_debt - COALESCE(v_debt.total_paid, 0))::numeric, 4);

  IF v_amount > v_prev_remaining + 0.005 THEN
    RAISE EXCEPTION 'المبلغ المدخل (%) أكبر من المتبقي (%)', v_amount, v_prev_remaining;
  END IF;

  -- Separate cash tendered (2 decimals) from debt settlement (snapping within 0.005 USD)
  IF abs(v_prev_remaining - v_amount) <= 0.005 THEN
    v_settlement := v_prev_remaining;
    v_new_remaining := 0;
    v_new_total_paid := v_debt.total_debt;
    v_rounding_adjustment := round(v_settlement - v_cash_amount, 4);
    IF abs(v_rounding_adjustment) > 0 THEN
      v_rounding_note := ' (تعديل تقريب: ' || v_rounding_adjustment::text || ' USD)';
    END IF;
  ELSE
    v_settlement := v_amount;
    v_rounding_adjustment := round(v_settlement - v_cash_amount, 4);
    v_new_remaining := GREATEST(round(v_prev_remaining - v_amount, 4), 0);
    v_new_total_paid := round(COALESCE(v_debt.total_paid, 0) + v_amount, 4);
  END IF;

  -- Resolve & validate payment currency / FX with fixed 0.05 USD tolerance
  v_tx_currency := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  IF v_tx_currency <> 'USD' AND COALESCE(_currency_amount, 0) > 0 THEN
    IF COALESCE(_exchange_rate, 0) <= 0 THEN
      RAISE EXCEPTION 'سعر الصرف غير صالح للعملة %', v_tx_currency;
    END IF;
    IF abs((_currency_amount / _exchange_rate) - v_cash_amount) > 0.05 THEN
      RAISE EXCEPTION 'عدم تطابق مبلغ الدفعة بالعملة (%) مع سعر الصرف (%) والمبلغ بالدولار (%)', _currency_amount, _exchange_rate, v_cash_amount;
    END IF;
    v_tx_currency_amount := round(_currency_amount, 4);
    v_tx_exchange_rate := _exchange_rate;
  ELSIF v_tx_currency <> 'USD' AND COALESCE(_exchange_rate, 0) > 0 THEN
    v_tx_currency_amount := round(v_cash_amount * _exchange_rate, 4);
    v_tx_exchange_rate := _exchange_rate;
  ELSE
    v_tx_currency := 'USD';
    v_tx_currency_amount := v_cash_amount;
    v_tx_exchange_rate := 1;
  END IF;

  IF _shift_id IS NOT NULL THEN
    PERFORM 1 FROM public.cash_shifts
     WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL
       FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
    END IF;
  END IF;

  UPDATE public.debts
     SET total_paid = v_new_total_paid,
         remaining_debt = v_new_remaining,
         status = CASE WHEN v_new_remaining <= 0 THEN 'fully_paid' ELSE 'partially_paid' END,
         notes = CASE WHEN v_rounding_note <> '' THEN concat_ws(E'\n', NULLIF(notes, ''), 'تسديد دين' || v_rounding_note) ELSE notes END,
         updated_at = now()
   WHERE id = _debt_id
  RETURNING * INTO v_debt;

  INSERT INTO public.debt_payments(
    user_id, debt_id, operation_id, amount,
    settled_amount, rounding_adjustment,
    currency, exchange_rate, payment_method,
    paid_by, shift_id
  ) VALUES (
    v_owner, _debt_id, _operation_id, v_cash_amount,
    v_settlement, v_rounding_adjustment,
    v_tx_currency, v_tx_exchange_rate, v_payment_method,
    auth.uid(), _shift_id
  );

  IF _shift_id IS NOT NULL AND v_cash_amount > 0 THEN
    INSERT INTO public.shift_transactions(
      shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes
    ) VALUES (
      _shift_id, v_owner, 'debt_payment', v_cash_amount,
      v_tx_currency, v_tx_currency_amount, v_tx_exchange_rate,
      _operation_id,
      'تسديد دين للعميل: ' || COALESCE(v_debt.customer_name, '') || v_rounding_note
    )
    ON CONFLICT (shift_id, type, reference_id) DO NOTHING;

    IF FOUND THEN
      UPDATE public.cash_shifts
         SET expected_balance = round(COALESCE(expected_balance, 0) + v_cash_amount, 2),
             updated_at = now()
       WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL;
    END IF;
  END IF;

  IF v_debt.invoice_id IS NOT NULL AND NOT COALESCE(v_debt.is_cash_debt, false) THEN
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

    IF v_prev_remaining > 0 THEN
      IF v_new_remaining <= 0 THEN
        v_installment_ratio := 1.0;
      ELSE
        v_installment_ratio := LEAST(1.0, round(v_settlement / v_prev_remaining, 6));
      END IF;

      FOR p IN
        SELECT * FROM public.partners
         WHERE user_id = v_owner
           AND pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', v_debt.invoice_id))
         FOR UPDATE
      LOOP
        _updated_details := '[]'::jsonb;
        _total_confirmed := 0;

        FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.pending_profit_details, '[]'::jsonb))
        LOOP
          IF (_item->>'invoiceId') = v_debt.invoice_id THEN
            _item_amt := (_item->>'amount')::numeric;

            IF v_new_remaining <= 0 THEN
              _confirm_amt := _item_amt;
            ELSE
              _confirm_amt := round(_item_amt * v_installment_ratio, 4);
              IF abs(_item_amt - _confirm_amt) > 0.0001 THEN
                _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_item_amt - _confirm_amt, 4)));
              END IF;
            END IF;

            _total_confirmed := _total_confirmed + _confirm_amt;
          ELSE
            _updated_details := _updated_details || _item;
          END IF;
        END LOOP;

        IF _total_confirmed <> 0 THEN
          _updated_history := '[]'::jsonb;
          FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb))
          LOOP
            IF (_item->>'invoiceId') = v_debt.invoice_id AND (_item->>'isDebt')::boolean = true AND v_new_remaining <= 0 THEN
              _updated_history := _updated_history || jsonb_set(_item, '{isDebt}', 'false'::jsonb);
            ELSIF (_item->>'invoiceId') = v_debt.invoice_id AND v_new_remaining <= 0
                  AND (COALESCE((_item->>'isRelease')::boolean, false) OR COALESCE(_item->>'id', '') LIKE '%-rel')
                  AND NOT COALESCE((_item->>'superseded')::boolean, false) THEN
              _updated_history := _updated_history || jsonb_set(_item, '{superseded}', 'true'::jsonb);
            ELSE
              _updated_history := _updated_history || _item;
            END IF;
          END LOOP;

          IF v_new_remaining > 0 THEN
            _updated_history := _updated_history || jsonb_build_object(
              'id', extract(epoch from now())::text || p.id::text || '-rel',
              'invoiceId', v_debt.invoice_id,
              'amount', _total_confirmed,
              'category', 'تحرير دفعة دين',
              'isRelease', true,
              'isDebt', false,
              'createdAt', now()
            );
          END IF;

          UPDATE public.partners
             SET pending_profit = round((SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(_updated_details) x), 4),
                 confirmed_profit = round(COALESCE(confirmed_profit, 0) + _total_confirmed, 4),
                 current_balance = round(COALESCE(current_balance, 0) + _total_confirmed, 4),
                 total_profit_earned = round(COALESCE(total_profit_earned, 0) + _total_confirmed, 4),
                 pending_profit_details = _updated_details,
                 profit_history = _updated_history,
                 updated_at = now()
           WHERE id = p.id;
        END IF;
      END LOOP;
    END IF;
  END IF;

  -- Deterministic single-customer lookup (strict uniqueness for both phone and name)
  v_resolved_customer_id := v_debt.customer_id;
  IF v_resolved_customer_id IS NULL THEN
    IF NULLIF(trim(COALESCE(v_debt.customer_phone, '')), '') IS NOT NULL THEN
      SELECT CASE WHEN count(*) = 1 THEN (array_agg(id))[1] ELSE NULL END
        INTO v_resolved_customer_id
        FROM public.customers
       WHERE user_id = v_owner
         AND trim(COALESCE(phone, '')) = trim(v_debt.customer_phone);
    END IF;
    IF v_resolved_customer_id IS NULL AND NULLIF(trim(COALESCE(v_debt.customer_name, '')), '') IS NOT NULL THEN
      SELECT CASE WHEN count(*) = 1 THEN (array_agg(id))[1] ELSE NULL END
        INTO v_resolved_customer_id
        FROM public.customers
       WHERE user_id = v_owner
         AND trim(COALESCE(name, '')) = trim(v_debt.customer_name);
    END IF;
  END IF;

  IF v_resolved_customer_id IS NOT NULL THEN
    PERFORM public.recalc_customer_open_debt(v_owner, v_resolved_customer_id);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'total_debt', v_debt.total_debt,
    'total_paid', v_debt.total_paid,
    'remaining_debt', v_debt.remaining_debt,
    'status', v_debt.status,
    'amount', v_cash_amount,
    'settled_amount', v_settlement,
    'rounding_adjustment', v_rounding_adjustment,
    'confirmed_profit', _total_confirmed
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_debt_payment_atomic(
  uuid, numeric, text, uuid, text, numeric, numeric, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_debt_payment_atomic(
  uuid, numeric, text, uuid, text, numeric, numeric, text
) TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. add_expense_atomic
--    - Adds optional trailing params for 100% backwards compatibility:
--      _shift_id, _paid_from, _original_currency, _original_amount, _exchange_rate
--    - Persists original_currency, original_amount, exchange_rate on public.expenses
--    - When _shift_id is provided or _paid_from = 'drawer': locks open shift,
--      inserts 'expense' into shift_transactions (reference_id = _op_uuid::text),
--      and updates cash_shifts.expected_balance atomically
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.add_expense_atomic(
  text, text, numeric, text, date, text
);

CREATE OR REPLACE FUNCTION public.add_expense_atomic(
  _operation_id text,
  _expense_type text,
  _amount numeric,
  _description text DEFAULT NULL::text,
  _date date DEFAULT CURRENT_DATE,
  _notes text DEFAULT NULL::text,
  _shift_id uuid DEFAULT NULL::uuid,
  _paid_from text DEFAULT NULL::text,
  _original_currency text DEFAULT 'USD'::text,
  _original_amount numeric DEFAULT NULL::numeric,
  _exchange_rate numeric DEFAULT 1
)
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
  _orig_ccy text := upper(COALESCE(NULLIF(trim(_original_currency), ''), 'USD'));
  _orig_rate numeric;
  _orig_amt numeric;
  _target_shift_id uuid := NULL;
  _dist jsonb := '[]'::jsonb;
  p record;
  _pct numeric;
  _part numeric;
BEGIN
  PERFORM set_config('app.partner_source', 'add_expense_atomic', true);
  IF _uid IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF _amt <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;

  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN RAISE EXCEPTION 'لم يتم العثور على حساب المالك'; END IF;

  PERFORM public.assert_period_open(_owner, COALESCE(_date, CURRENT_DATE), 'تسجيل مصروف');

  IF NULLIF(trim(COALESCE(_operation_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'معرّف العملية مطلوب';
  END IF;

  BEGIN
    _op_uuid := trim(_operation_id)::uuid;
  EXCEPTION WHEN OTHERS THEN
    -- Deterministic UUID so retries with a non-UUID _operation_id remain idempotent
    _op_uuid := md5(_owner::text || ':expense:' || trim(_operation_id))::uuid;
  END;

  IF EXISTS (SELECT 1 FROM public.expenses WHERE id = _op_uuid) THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'id', _op_uuid);
  END IF;

  -- Resolve currency metadata
  IF _orig_ccy = 'USD' THEN
    _orig_rate := 1;
    _orig_amt := COALESCE(NULLIF(_original_amount, 0), _amt);
  ELSE
    _orig_rate := COALESCE(_exchange_rate, 0);
    IF _orig_rate <= 0 THEN
      RAISE EXCEPTION 'سعر الصرف غير صالح للعملة %', _orig_ccy;
    END IF;
    _orig_amt := COALESCE(NULLIF(_original_amount, 0), round(_amt * _orig_rate, 4));
  END IF;

  -- Lock open cash shift when paid from drawer or explicit _shift_id is supplied
  IF _shift_id IS NOT NULL THEN
    SELECT id INTO _target_shift_id
      FROM public.cash_shifts
     WHERE id = _shift_id
       AND user_id = _owner
       AND closed_at IS NULL
       FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
    END IF;
  ELSIF lower(COALESCE(trim(_paid_from), '')) = 'drawer' THEN
    SELECT id INTO _target_shift_id
      FROM public.cash_shifts
     WHERE user_id = _owner
       AND closed_at IS NULL
     ORDER BY opened_at DESC
     LIMIT 1
       FOR UPDATE;
    IF _target_shift_id IS NULL THEN
      RAISE EXCEPTION 'يجب فتح وردية نقدية مفتوحة لتسجيل مصروف من الصندوق';
    END IF;
  END IF;

  FOR p IN
    SELECT * FROM public.partners
    WHERE user_id = _owner
    FOR UPDATE
  LOOP
    _pct := coalesce(p.expense_share_percentage, p.share_percentage, 0);

    IF _pct > 0 THEN
      _part := round(_amt * (_pct / 100.0), 2);

      IF _part > 0 THEN
        _dist := _dist || jsonb_build_object(
          'partnerId', p.id,
          'partnerName', p.name,
          'amount', _part,
          'percentage', _pct
        );

        UPDATE public.partners SET
          current_balance = round(coalesce(current_balance, 0) - _part, 4),
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

  INSERT INTO public.expenses(
    id, user_id, expense_type, amount, description, date, notes, distributions, cashier_id,
    original_currency, original_amount, exchange_rate
  ) VALUES (
    _op_uuid, _owner, _expense_type, _amt, _description, coalesce(_date, CURRENT_DATE), _notes, _dist, _uid,
    _orig_ccy, _orig_amt, _orig_rate
  );

  IF _target_shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions(
      shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes
    ) VALUES (
      _target_shift_id, _owner, 'expense', _amt,
      _orig_ccy, _orig_amt, _orig_rate,
      _op_uuid::text,
      COALESCE(NULLIF(trim(_notes), ''), NULLIF(trim(_description), ''), _expense_type)
    )
    ON CONFLICT (shift_id, type, reference_id) DO NOTHING;

    IF FOUND THEN
      UPDATE public.cash_shifts
         SET expected_balance = round(COALESCE(expected_balance, 0) - _amt, 2),
             updated_at = now()
       WHERE id = _target_shift_id
         AND user_id = _owner
         AND closed_at IS NULL;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'id', _op_uuid,
    'distributions', _dist,
    'shift_id', _target_shift_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.add_expense_atomic(
  text, text, numeric, text, date, text, uuid, text, text, numeric, numeric
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_expense_atomic(
  text, text, numeric, text, date, text, uuid, text, text, numeric, numeric
) TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. delete_expense_atomic + reverse_expense_atomic + direct-reverse guard trigger
--    - Adds optional _shift_id uuid DEFAULT NULL
--    - Sets local GUC app.internal_expense_reverse = '1' before updating is_reversed
--    - Returns cash_refunded (boolean)
--    - BEFORE UPDATE trigger blocks direct client mutations to expenses.is_reversed
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.delete_expense_atomic(uuid, text);

CREATE OR REPLACE FUNCTION public.delete_expense_atomic(
  _expense_id uuid,
  _reason text DEFAULT 'إلغاء مصروف'::text,
  _shift_id uuid DEFAULT NULL::uuid
)
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
  _orig_tx record;
  _refund_amt numeric;
  _cash_refunded boolean := false;
BEGIN
  PERFORM set_config('app.partner_source', 'delete_expense_atomic', true);
  IF _caller IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  SELECT * INTO _exp FROM public.expenses WHERE id = _expense_id AND user_id = _owner FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'المصروف غير موجود', 'cash_refunded', false);
  END IF;

  IF COALESCE(_exp.is_reversed, false) = true THEN
    RETURN jsonb_build_object('success', true, 'already_reversed', true, 'cash_refunded', false);
  END IF;

  PERFORM public.assert_period_open(_owner, _exp.date, 'حذف المصروف');

  -- Look up original shift expense transaction to preserve original currency & require an open shift for drawer expenses
  SELECT st.amount, st.currency, st.currency_amount, st.exchange_rate
    INTO _orig_tx
    FROM public.shift_transactions st
   WHERE st.user_id = _owner
     AND st.type = 'expense'
     AND st.reference_id = _expense_id::text
   ORDER BY st.created_at DESC
   LIMIT 1;

  IF FOUND THEN
    IF _shift_id IS NOT NULL THEN
      SELECT id INTO _active_shift_id
        FROM public.cash_shifts
       WHERE id = _shift_id
         AND user_id = _owner
         AND closed_at IS NULL
         FOR UPDATE;
      IF _active_shift_id IS NULL THEN
        RAISE EXCEPTION 'الوردية المحددة غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
      END IF;
    ELSE
      SELECT id INTO _active_shift_id
        FROM public.cash_shifts
       WHERE user_id = _owner
         AND closed_at IS NULL
       ORDER BY opened_at DESC
       LIMIT 1
         FOR UPDATE;
      IF _active_shift_id IS NULL THEN
        RAISE EXCEPTION 'يجب فتح وردية مفتوحة لاسترجاع مصروف مدفوع من الصندوق';
      END IF;
    END IF;

    _refund_amt := COALESCE(_orig_tx.amount, _exp.amount);

    INSERT INTO public.shift_transactions(
      shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes
    ) VALUES (
      _active_shift_id, _owner, 'expense_refund',
      _refund_amt,
      COALESCE(_orig_tx.currency, 'USD'),
      COALESCE(_orig_tx.currency_amount, _orig_tx.amount, _exp.amount),
      COALESCE(_orig_tx.exchange_rate, 1),
      _expense_id::text,
      'إلغاء واسترجاع مصروف: ' || COALESCE(_reason, '')
    )
    ON CONFLICT (shift_id, type, reference_id) DO NOTHING;

    IF FOUND THEN
      UPDATE public.cash_shifts
         SET expected_balance = round(COALESCE(expected_balance, 0) + _refund_amt, 2),
             updated_at = now()
       WHERE id = _active_shift_id AND user_id = _owner AND closed_at IS NULL;
      _cash_refunded := true;
    END IF;
  END IF;

  IF _exp.distributions IS NOT NULL AND jsonb_array_length(_exp.distributions) > 0 THEN
    FOR _item IN SELECT * FROM jsonb_array_elements(_exp.distributions) LOOP
      _partner_id := (_item->>'partnerId')::uuid;
      _part_amount := COALESCE((_item->>'amount')::numeric, 0);

      IF _partner_id IS NOT NULL AND _part_amount > 0 THEN
        UPDATE public.partners SET
          current_balance = round(COALESCE(current_balance, 0) + _part_amount, 4),
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

  PERFORM set_config('app.internal_expense_reverse', '1', true);

  UPDATE public.expenses SET
    is_reversed = true,
    reversed_at = now(),
    reversed_by = _caller,
    reversed_reason = _reason
  WHERE id = _expense_id;

  RETURN jsonb_build_object(
    'success', true,
    'expense_id', _expense_id,
    'amount', _exp.amount,
    'expense_type', _exp.expense_type,
    'cash_refunded', _cash_refunded
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_expense_atomic(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_expense_atomic(uuid, text, uuid) TO authenticated;

DROP FUNCTION IF EXISTS public.reverse_expense_atomic(uuid, text);

CREATE OR REPLACE FUNCTION public.reverse_expense_atomic(
  p_expense_id uuid,
  p_reason text DEFAULT 'تراجع بواسطة المستخدم'::text,
  p_shift_id uuid DEFAULT NULL::uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_res jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'يجب تسجيل الدخول أولاً', 'cash_refunded', false);
  END IF;

  v_res := public.delete_expense_atomic(p_expense_id, p_reason, p_shift_id);

  IF COALESCE((v_res->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', COALESCE(v_res->>'error', 'تعذر التراجع عن المصروف'),
      'cash_refunded', false
    );
  END IF;

  IF COALESCE((v_res->>'already_reversed')::boolean, false) = true THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_reversed', true,
      'cash_refunded', false,
      'message', 'تم التراجع عن هذا المصروف مسبقاً'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'amount', (v_res->>'amount')::numeric,
    'expense_type', v_res->>'expense_type',
    'cash_refunded', COALESCE((v_res->>'cash_refunded')::boolean, false),
    'message', 'تم التراجع عن المصروف بنجاح'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reverse_expense_atomic(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_expense_atomic(uuid, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_expenses_direct_reverse()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.is_reversed IS DISTINCT FROM OLD.is_reversed THEN
    IF COALESCE(current_setting('app.internal_expense_reverse', true), '') <> '1' THEN
      RAISE EXCEPTION 'لا يمكن تعديل حالة عكس المصروف مباشرة؛ يجب استخدام delete_expense_atomic'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_expenses_direct_reverse ON public.expenses;
CREATE TRIGGER trg_guard_expenses_direct_reverse
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_expenses_direct_reverse();

REVOKE ALL ON FUNCTION public.guard_expenses_direct_reverse() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.guard_expenses_direct_reverse() TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. FX Lock Triggers (stores, store_settings) + Shift Opening FX Snapshot
--    + close_cash_shift_atomic preferring cash_shifts.opening_exchange_rates
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_fx_change_during_open_shift()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _owner uuid := COALESCE(NEW.user_id, OLD.user_id);
BEGIN
  IF (NEW.primary_currency IS DISTINCT FROM OLD.primary_currency)
     OR (NEW.exchange_rates IS DISTINCT FROM OLD.exchange_rates) THEN
    IF _owner IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtext('shift_fx:' || _owner::text));
      IF EXISTS (
        SELECT 1
          FROM public.cash_shifts
         WHERE user_id = _owner
           AND closed_at IS NULL
      ) THEN
        RAISE EXCEPTION 'لا يمكن تغيير العملة الأساسية أو أسعار الصرف ما دامت هناك وردية نقدية مفتوحة؛ يرجى إغلاق الوردية أولاً'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_stores_fx_during_open_shift ON public.stores;
CREATE TRIGGER trg_guard_stores_fx_during_open_shift
  BEFORE UPDATE ON public.stores
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_fx_change_during_open_shift();

DROP TRIGGER IF EXISTS trg_guard_store_settings_fx_during_open_shift ON public.store_settings;
CREATE TRIGGER trg_guard_store_settings_fx_during_open_shift
  BEFORE UPDATE ON public.store_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_fx_change_during_open_shift();

REVOKE ALL ON FUNCTION public.guard_fx_change_during_open_shift() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.guard_fx_change_during_open_shift() TO authenticated;

-- Snapshot opening_exchange_rates when a new cash shift is opened
CREATE OR REPLACE FUNCTION public.snapshot_shift_opening_exchange_rates()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _rates jsonb;
BEGIN
  IF NEW.user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('shift_fx:' || NEW.user_id::text));
    IF NEW.opening_exchange_rates IS NULL OR NEW.opening_exchange_rates = '{}'::jsonb THEN
      SELECT NULLIF(ss.exchange_rates, '{}'::jsonb)
        INTO _rates
        FROM public.store_settings ss
       WHERE ss.user_id = NEW.user_id
       LIMIT 1;

      IF _rates IS NULL THEN
        SELECT NULLIF(s.exchange_rates, '{}'::jsonb)
          INTO _rates
          FROM public.stores s
         WHERE s.user_id = NEW.user_id
         LIMIT 1;
      END IF;

      NEW.opening_exchange_rates := COALESCE(_rates, '{"USD": 1}'::jsonb);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_snapshot_shift_opening_exchange_rates ON public.cash_shifts;
CREATE TRIGGER trg_snapshot_shift_opening_exchange_rates
  BEFORE INSERT ON public.cash_shifts
  FOR EACH ROW
  EXECUTE FUNCTION public.snapshot_shift_opening_exchange_rates();

REVOKE ALL ON FUNCTION public.snapshot_shift_opening_exchange_rates() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.snapshot_shift_opening_exchange_rates() TO authenticated;

CREATE OR REPLACE FUNCTION public.close_cash_shift_atomic(
  _shift_id uuid,
  _actual_balance numeric,
  _variance_reason text DEFAULT NULL::text,
  _decision text DEFAULT 'accept'::text,
  _counts jsonb DEFAULT NULL::jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _shift record;
  _tol numeric := 1;
  _open jsonb;
  _codes text[];
  _c text; _opening_rate numeric; _stored_rate numeric; _rate numeric; _exp numeric; _cnt numeric; _var numeric; _var_usd numeric;
  _details jsonb := '[]'::jsonb;
  _tot_exp_usd numeric := 0; _tot_cnt_usd numeric := 0; _tot_var_usd numeric := 0;
  _beyond boolean := false;
  _inflow numeric := 0; _outflow numeric := 0; _calc_expected numeric := 0; _variance numeric := 0;
  _status text := 'matched'; _dec text := 'none'; _has_counts boolean := (_counts IS NOT NULL AND jsonb_typeof(_counts)='array' AND jsonb_array_length(_counts) > 0);
  _d jsonb;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  SELECT * INTO _shift FROM public.cash_shifts WHERE id = _shift_id AND user_id = _owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الوردية غير موجودة أو لا تتبع للمتجر'; END IF;
  IF _shift.closed_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'already_closed', true, 'shift_id', _shift_id);
  END IF;
  SELECT COALESCE(shift_variance_tolerance_usd, 1) INTO _tol FROM public.store_settings WHERE user_id = _owner LIMIT 1;
  _tol := COALESCE(_tol, 1);
  _open := COALESCE(_shift.opening_by_currency, jsonb_build_object('USD', COALESCE(_shift.opening_balance,0)));

  IF _has_counts THEN
    _codes := ARRAY(SELECT DISTINCT c FROM (
        SELECT jsonb_object_keys(_open) AS c
        UNION SELECT upper(COALESCE(currency,'USD')) FROM public.shift_transactions WHERE shift_id = _shift_id
        UNION SELECT upper(e->>'code') FROM jsonb_array_elements(_counts) e) s WHERE c IS NOT NULL);
    FOREACH _c IN ARRAY _codes LOOP
      _rate := NULLIF((SELECT (e->>'rate')::numeric FROM jsonb_array_elements(_counts) e WHERE upper(e->>'code') = _c LIMIT 1), 0);
      -- Prefer shift opening_exchange_rates snapshot over live store_settings.exchange_rates
      _opening_rate := NULLIF((_shift.opening_exchange_rates->>_c)::numeric, 0);
      IF _opening_rate IS NOT NULL AND _opening_rate > 0 THEN
        _rate := _opening_rate;
      ELSE
        SELECT NULLIF((ss.exchange_rates->>_c)::numeric, 0)
          INTO _stored_rate
          FROM public.store_settings ss
         WHERE ss.user_id = _shift.user_id
         LIMIT 1;
        IF _stored_rate IS NOT NULL AND _stored_rate > 0 THEN
          _rate := _stored_rate;
        END IF;
      END IF;
      IF _c = 'USD' THEN _rate := 1; END IF;
      IF _rate IS NULL THEN
        SELECT exchange_rate INTO _rate FROM public.shift_transactions WHERE shift_id=_shift_id AND upper(COALESCE(currency,'USD'))=_c AND exchange_rate > 0 ORDER BY created_at DESC LIMIT 1;
      END IF;
      IF _rate IS NULL OR _rate <= 0 THEN RAISE EXCEPTION 'سعر صرف العملة % غير متوفر', _c; END IF;
      _exp := COALESCE((_open->>_c)::numeric, 0) + COALESCE((
        SELECT SUM(CASE
            WHEN type IN ('sale','deposit','deposit_capital','deposit_revenue','deposit_purchase_cover','debt_payment','surplus','expense_refund','supplier_refund','fx_in','transfer_in') THEN COALESCE(currency_amount, amount)
            WHEN type IN ('expense','refund','withdrawal','supplier_payment','store_credit_refund','shortage','fx_out','transfer_out') THEN -COALESCE(currency_amount, amount)
            ELSE 0 END)
        FROM public.shift_transactions WHERE shift_id = _shift_id AND upper(COALESCE(currency,'USD')) = _c), 0);
      _cnt := COALESCE((SELECT (e->>'counted')::numeric FROM jsonb_array_elements(_counts) e WHERE upper(e->>'code') = _c LIMIT 1), 0);
      _var := round(_cnt - _exp, 4);
      _var_usd := round(_var / _rate, 4);
      _tot_exp_usd := _tot_exp_usd + _exp / _rate; _tot_cnt_usd := _tot_cnt_usd + _cnt / _rate; _tot_var_usd := _tot_var_usd + _var_usd;
      IF abs(_var_usd) > _tol THEN _beyond := true; END IF;
      _details := _details || jsonb_build_object('code', _c, 'rate', _rate, 'expected', round(_exp,4), 'counted', round(_cnt,4), 'variance', _var, 'variance_usd', _var_usd);
    END LOOP;
    IF abs(_tot_var_usd) > _tol THEN _beyond := true; END IF;
    _calc_expected := round(_tot_exp_usd, 2);
    _variance := round(_tot_var_usd, 2);
  ELSE
    SELECT COALESCE(SUM(amount),0) INTO _inflow FROM public.shift_transactions WHERE shift_id=_shift_id AND type IN ('sale','deposit','deposit_capital','deposit_revenue','deposit_purchase_cover','debt_payment','surplus','expense_refund','supplier_refund','fx_in','transfer_in');
    SELECT COALESCE(SUM(amount),0) INTO _outflow FROM public.shift_transactions WHERE shift_id=_shift_id AND type IN ('expense','refund','withdrawal','supplier_payment','store_credit_refund','shortage','fx_out','transfer_out');
    _calc_expected := round(COALESCE(_shift.opening_balance,0) + _inflow - _outflow, 2);
    _variance := round(COALESCE(_actual_balance,0) - _calc_expected, 2);
    _beyond := abs(_variance) > _tol;
    _details := jsonb_build_array(jsonb_build_object('code','USD','rate',1,'expected',_calc_expected,'counted',round(COALESCE(_actual_balance,0),2),'variance',_variance,'variance_usd',_variance));
  END IF;

  IF NOT _beyond THEN
    _dec := CASE WHEN abs(_variance) >= 0.01 OR _has_counts AND _tot_var_usd <> 0 THEN 'within_tolerance' ELSE 'none' END;
    _status := 'matched';
  ELSIF _decision = 'defer' THEN
    _dec := 'deferred'; _status := 'pending';
  ELSE
    _dec := 'accepted';
    _status := CASE WHEN _variance_reason IS NOT NULL AND length(trim(_variance_reason)) > 0 THEN 'matched' ELSE 'unmatched' END;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(_details) d WHERE (d->>'variance')::numeric <> 0) THEN
      PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'إقفال الوردية');
    END IF;
    FOR _d IN SELECT * FROM jsonb_array_elements(_details) LOOP
      IF (_d->>'variance')::numeric <> 0 THEN
        INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,currency,currency_amount,exchange_rate,notes,created_at)
        VALUES (_shift_id,_owner, CASE WHEN (_d->>'variance')::numeric > 0 THEN 'surplus' ELSE 'shortage' END,
                abs((_d->>'variance_usd')::numeric), _d->>'code', abs((_d->>'variance')::numeric), (_d->>'rate')::numeric,
                CASE WHEN (_d->>'variance')::numeric > 0 THEN 'فائض صندوق عند الإقفال: ' ELSE 'عجز صندوق عند الإقفال: ' END || COALESCE(_variance_reason,''), now());
      END IF;
    END LOOP;
  END IF;

  UPDATE public.cash_shifts SET closed_at = now(), expected_balance = _calc_expected,
         actual_balance = CASE WHEN _has_counts THEN round(_tot_cnt_usd,2) ELSE round(COALESCE(_actual_balance,0),2) END,
         variance = _variance, variance_reason = _variance_reason, reconciliation_status = _status,
         currency_counts = _details, variance_decision = _dec, updated_at = now()
   WHERE id = _shift_id;

  RETURN jsonb_build_object('success', true, 'shift_id', _shift_id, 'expected_balance', _calc_expected,
    'variance', _variance, 'status', _status, 'decision', _dec, 'tolerance_usd', _tol, 'currencies', _details);
END;
$function$;

REVOKE ALL ON FUNCTION public.close_cash_shift_atomic(uuid, numeric, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_cash_shift_atomic(uuid, numeric, text, text, jsonb) TO authenticated;
