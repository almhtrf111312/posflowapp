-- Money precision (docs/FINANCE_LAW.md F-02): stored money amounts and cached drawer / partner / customer balances keep 8 decimals.
-- Found by the re-audit follow-up (2026-11-25): these functions still rounded USD amounts and balances to 2 decimals, so a small
-- amount in a high-rate currency was stored wrongly (5,000 LBP at 89,500 = 0.0559 USD was stored as 0.06) and the error accumulated.
-- Only the rounding scale of USD amounts and cached balances changes. NOT changed on purpose: foreign-currency amounts (physical cash),
-- shift closing (expected / variance), error messages, and columns that are numeric(18,4) in the schema.
-- Each function below is its current final definition with only the listed scales changed:
--   add_expense_atomic: 2 site(s)
--   delete_expense_atomic: 1 site(s)
--   record_debt_payment_atomic: 2 site(s)
--   partner_deposit_atomic: 2 site(s)
--   partner_withdrawal_atomic: 1 site(s)
--   process_quick_purchase_atomic: 1 site(s)
--   payout_store_credit_atomic: 1 site(s)
--   mark_invoice_digital: 1 site(s)
--   _allocate_sales_refund: 2 site(s)
--   confirm_partner_debt_profit_atomic: 6 site(s)
--   post_shift_sale_atomic: 6 site(s)
--   process_pos_sale_atomic: 2 site(s)
--   _supplier_drawer_tx: 1 site (and the file now matches the version live already has)
-- _supplier_drawer_tx: the repo had a different (fallback-to-latest-open-shift) definition than the live database. This migration makes the
-- repo match live: a valid, open shift of this store is required, otherwise the operation fails and nothing is recorded.
-- Written by the implementing agent. The owner reviews it before it is applied.

CREATE OR REPLACE FUNCTION public.add_expense_atomic(_operation_id text, _expense_type text, _amount numeric, _description text DEFAULT NULL::text, _date date DEFAULT CURRENT_DATE, _notes text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _paid_from text DEFAULT NULL::text, _original_currency text DEFAULT 'USD'::text, _original_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _owner uuid;
  _op_uuid uuid;
  _amt numeric := round(coalesce(_amount, 0), 8);
  _orig_ccy text := upper(COALESCE(NULLIF(trim(_original_currency), ''), 'USD'));
  _orig_rate numeric;
  _orig_amt numeric;
  _target_shift_id uuid := NULL;
  _dist jsonb := '[]'::jsonb;
  p record;
  _pct numeric;
  _part numeric;
  _pct_before numeric := 0;
  _cat_total numeric := 0;
  _remaining_amt numeric := 0;
  _drawer boolean := _shift_id IS NOT NULL OR lower(COALESCE(trim(_paid_from), '')) = 'drawer';
  _request jsonb;
  _previous_request jsonb;
  _result jsonb;
BEGIN
  PERFORM set_config('app.partner_source', 'add_expense_atomic', true);
  IF _uid IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF _amt <= 0 OR _amt::text IN ('NaN', 'Infinity', '-Infinity') THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;

  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN RAISE EXCEPTION 'لم يتم العثور على حساب المالك'; END IF;

  IF NULLIF(trim(COALESCE(_operation_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'معرّف العملية مطلوب';
  END IF;

  BEGIN
    _op_uuid := trim(_operation_id)::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    -- Deterministic UUID so retries with a non-UUID _operation_id remain idempotent
    _op_uuid := md5(_owner::text || ':expense:' || trim(_operation_id))::uuid;
  END;

  IF _original_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR _exchange_rate::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'مبلغ المصروف أو سعر الصرف غير صالح';
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

  IF _orig_amt <= 0 OR abs(_orig_amt / _orig_rate - _amt) > 0.005 + 0.00005 / _orig_rate THEN
    RAISE EXCEPTION 'مبلغ المصروف الأصلي لا يطابق القيمة الدفترية وسعر الصرف';
  END IF;
  IF _drawer AND _shift_id IS NULL THEN
    RAISE EXCEPTION 'يجب تحديد الوردية الأصلية لتسجيل مصروف من الصندوق';
  END IF;
  IF _shift_id IS NOT NULL AND NULLIF(trim(_paid_from), '') IS NOT NULL AND lower(trim(_paid_from)) <> 'drawer' THEN
    RAISE EXCEPTION 'مصدر المصروف لا يطابق الوردية';
  END IF;

  _request := jsonb_build_object(
    'expense_type', _expense_type, 'amount', _amt, 'description', _description,
    'date', COALESCE(_date, CURRENT_DATE), 'notes', _notes, 'shift_id', _shift_id,
    'original_currency', _orig_ccy, 'original_amount', _orig_amt, 'exchange_rate', _orig_rate
  );
  PERFORM pg_advisory_xact_lock(hashtext('expense_op:' || _op_uuid::text));
  SELECT request, result INTO _previous_request, _result
    FROM public.accounting_rpc_receipts
   WHERE user_id = _owner AND kind = 'expense_add' AND operation_id = _op_uuid::text;
  IF FOUND THEN
    IF _previous_request IS DISTINCT FROM _request THEN
      RAISE EXCEPTION 'معرّف المصروف مرتبط بطلب مختلف';
    END IF;
    RETURN _result || jsonb_build_object('already_processed', true);
  END IF;
  IF EXISTS (SELECT 1 FROM public.expenses WHERE id = _op_uuid AND user_id = _owner) THEN
    RAISE EXCEPTION 'تم ترحيل معرّف المصروف سابقاً دون إيصال كامل. راجع سجل المصروف قبل إعادة المحاولة';
  END IF;

  PERFORM public.assert_period_open(_owner, COALESCE(_date, CURRENT_DATE), 'تسجيل مصروف');
  IF _drawer THEN
    SELECT id INTO _target_shift_id FROM public.cash_shifts
     WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL
       AND (cashier_id = _uid OR public.is_store_owner(_uid))
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المستخدم';
    END IF;
  END IF;

  PERFORM 1 FROM public.partners WHERE user_id = _owner ORDER BY id FOR UPDATE;

  -- KD-08 / D-09 (owner decision, 2026-11-23), applies to NEW expenses only.
  -- Step 1: category partners (access_all = false) pay their expense share of the TOTAL, taken off the top.
  FOR p IN
    SELECT * FROM public.partners
    WHERE user_id = _owner AND COALESCE(access_all, false) = false AND COALESCE(expense_share_percentage, 0) > 0
    ORDER BY id
  LOOP
    _pct := p.expense_share_percentage;
    _part := round(_amt * _pct / 100, 4);
    IF _part > 0 THEN
      _cat_total := _cat_total + _part;
      _dist := _dist || jsonb_build_object(
        'partnerId', p.id,
        'partnerName', p.name,
        'amount', _part,
        'percentage', _pct,
        'pool', 'category'
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
  END LOOP;

  -- Step 2: general partners (access_all = true) pay their percentage of what REMAINS after step 1.
  -- The store owner keeps the rest (no partner row); general percentages sum to at most 100.
  _remaining_amt := _amt - _cat_total;
  FOR p IN
    SELECT * FROM public.partners
    WHERE user_id = _owner AND COALESCE(access_all, false) = true AND COALESCE(expense_share_percentage, 0) > 0
    ORDER BY id
  LOOP
    _pct := p.expense_share_percentage;
    _part := round(_remaining_amt * (_pct_before + _pct) / 100, 4)
           - round(_remaining_amt * _pct_before / 100, 4);
    _pct_before := _pct_before + _pct;

    IF _part > 0 THEN
      _dist := _dist || jsonb_build_object(
        'partnerId', p.id,
        'partnerName', p.name,
        'amount', _part,
        'percentage', _pct,
        'pool', 'general'
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
    );

    IF FOUND THEN
      UPDATE public.cash_shifts
         SET expected_balance = round(COALESCE(expected_balance, 0) - _amt, 8),
             updated_at = now()
       WHERE id = _target_shift_id
         AND user_id = _owner
         AND closed_at IS NULL;
    END IF;
  END IF;

  _result := jsonb_build_object(
    'success', true,
    'already_processed', false,
    'id', _op_uuid,
    'distributions', _dist,
    'shift_id', _target_shift_id
  );
  INSERT INTO public.accounting_rpc_receipts(user_id, kind, operation_id, request, result)
  VALUES (_owner, 'expense_add', _op_uuid::text, _request, _result);
  RETURN _result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_expense_atomic(_expense_id uuid, _reason text DEFAULT 'إلغاء مصروف'::text, _shift_id uuid DEFAULT NULL::uuid)
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
  _posted_at timestamptz;
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

  _posted_at := clock_timestamp();
  PERFORM public._assert_accounting_posting_open(_owner, _posted_at, 'عكس مصروف');

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
    IF _shift_id IS NULL THEN
      RAISE EXCEPTION 'يجب تحديد الوردية المفتوحة لاسترجاع مصروف مدفوع من الصندوق';
    END IF;
    SELECT id INTO _active_shift_id
      FROM public.cash_shifts
     WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL
       AND (cashier_id = _caller OR public.is_store_owner(_caller))
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية المحددة غير موجودة أو مغلقة أو لا تتبع لهذا المستخدم';
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
         SET expected_balance = round(COALESCE(expected_balance, 0) + _refund_amt, 8),
             updated_at = now()
       WHERE id = _active_shift_id AND user_id = _owner AND closed_at IS NULL;
      _cash_refunded := true;
    END IF;
  END IF;

  IF _exp.distributions IS NOT NULL AND jsonb_array_length(_exp.distributions) > 0 THEN
    FOR _item IN
      SELECT value FROM jsonb_array_elements(_exp.distributions)
       ORDER BY (value->>'partnerId')::uuid
    LOOP
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
    reversed_at = _posted_at,
    reversed_by = _caller,
    reversed_reason = _reason
  WHERE id = _expense_id;

  RETURN jsonb_build_object(
    'success', true,
    'expense_id', _expense_id,
    'amount', _exp.amount,
    'expense_type', _exp.expense_type,
    'cash_refunded', _cash_refunded,
    'shift_id', _active_shift_id,
    'cash_amount', CASE WHEN _cash_refunded THEN _refund_amt END,
    'cash_currency', CASE WHEN _cash_refunded THEN COALESCE(_orig_tx.currency, 'USD') END,
    'cash_currency_amount', CASE WHEN _cash_refunded THEN COALESCE(_orig_tx.currency_amount, _orig_tx.amount, _exp.amount) END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_debt_payment_atomic(_debt_id uuid, _amount numeric, _operation_id text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT NULL::text, _currency_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT NULL::numeric, _payment_method text DEFAULT 'cash'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid := public.get_owner_id(auth.uid());
  v_debt public.debts%ROWTYPE;
  v_existing_payment public.debt_payments%ROWTYPE;
  v_request jsonb;
  v_response jsonb;
  v_legacy_currency_amount numeric;
  v_amount numeric := round(COALESCE(_amount, 0)::numeric, 4);
  v_cash_amount numeric := round(COALESCE(_amount, 0)::numeric, 8);
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
  v_inv_currency text;
  v_inv_rate numeric;
  v_pay_currency text;
  v_fx_credit_rate numeric := NULL;
  v_credit numeric;
  v_fx_difference numeric(18,4) := 0;
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

  IF v_payment_method NOT IN ('cash', 'transfer') THEN RAISE EXCEPTION 'طريقة قبض الدين غير صالحة'; END IF;
  v_request := jsonb_build_object('debt_id', _debt_id, 'amount', _amount, 'shift_id', _shift_id,
    'currency', upper(COALESCE(NULLIF(trim(_currency), ''), 'USD')), 'currency_amount', _currency_amount,
    'exchange_rate', _exchange_rate, 'payment_method', v_payment_method);
  v_response := public._read_sales_settlement_replay(v_owner, 'debt_payment', _operation_id, v_request);
  IF v_response IS NOT NULL THEN RETURN v_response || jsonb_build_object('already_processed', true); END IF;

  -- A refund locks the invoice first. Debt collection takes the same lock order.
  PERFORM 1 FROM public.invoices i
    JOIN public.debts d ON d.user_id = i.user_id AND d.id = _debt_id
   WHERE i.user_id = v_owner AND NOT COALESCE(d.is_cash_debt, false)
     AND d.invoice_id IN (i.invoice_number, i.id::text)
   ORDER BY i.id FOR UPDATE OF i;
  SELECT * INTO v_debt FROM public.debts WHERE id = _debt_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND OR v_debt.user_id <> v_owner THEN
    RAISE EXCEPTION 'الدين غير موجود أو لا يتبع للمتجر';
  END IF;

  -- FINANCE LAW F-27 / D-04: a debt paid in the SAME foreign currency as its invoice is credited at the INVOICE's
  -- original rate. _amount stays the cash value in USD at the payment-day rate (it feeds the drawer);
  -- the difference between the two is the FX difference (D-06), kept apart from sales profit.
  v_pay_currency := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  IF v_pay_currency <> 'USD' AND COALESCE(_currency_amount, 0) > 0
     AND v_debt.invoice_id IS NOT NULL AND NOT COALESCE(v_debt.is_cash_debt, false) THEN
    SELECT upper(NULLIF(trim(i.currency), '')), i.exchange_rate
      INTO v_inv_currency, v_inv_rate
      FROM public.invoices i
     WHERE i.user_id = v_owner
       AND (i.invoice_number = v_debt.invoice_id OR i.id::text = v_debt.invoice_id)
     LIMIT 1;
    IF v_inv_currency = v_pay_currency AND COALESCE(v_inv_rate, 0) > 0 THEN
      v_fx_credit_rate := v_inv_rate;
    END IF;
  END IF;
  v_credit := CASE WHEN v_fx_credit_rate IS NOT NULL THEN round(_currency_amount / v_fx_credit_rate, 4) ELSE v_amount END;

  -- Only an exactly corroborated historical payment may satisfy a new replay request.
  SELECT dp.*
    INTO v_existing_payment
    FROM public.debt_payments dp
   WHERE dp.user_id = v_owner
     AND dp.operation_id = _operation_id
   LIMIT 1;

  IF FOUND THEN
    v_legacy_currency_amount := CASE WHEN v_existing_payment.currency = 'USD' THEN v_existing_payment.amount
      ELSE v_existing_payment.currency_amount END;
    IF v_legacy_currency_amount IS NULL AND v_existing_payment.shift_id IS NOT NULL THEN
      SELECT t.currency_amount INTO v_legacy_currency_amount
        FROM public.shift_transactions t
       WHERE t.user_id = v_owner AND t.shift_id = v_existing_payment.shift_id
         AND t.type = 'debt_payment' AND t.reference_id = _operation_id
         AND t.amount = v_existing_payment.amount AND t.currency = v_existing_payment.currency
         AND t.exchange_rate = v_existing_payment.exchange_rate;
    END IF;
    IF v_existing_payment.debt_id IS DISTINCT FROM _debt_id
       OR v_existing_payment.shift_id IS DISTINCT FROM _shift_id
       OR v_existing_payment.payment_method IS DISTINCT FROM v_payment_method
       OR v_existing_payment.currency IS DISTINCT FROM (v_request->>'currency')
       OR v_existing_payment.exchange_rate IS DISTINCT FROM
          (CASE WHEN v_request->>'currency' = 'USD' THEN 1 ELSE _exchange_rate END)
       OR v_existing_payment.amount IS DISTINCT FROM v_cash_amount
       OR v_existing_payment.settled_amount IS DISTINCT FROM v_credit
       OR v_legacy_currency_amount IS NULL
       OR v_legacy_currency_amount IS DISTINCT FROM COALESCE(round(_currency_amount, 4),
          round(v_cash_amount * v_existing_payment.exchange_rate, 4)) THEN
      RAISE EXCEPTION 'تعارض في معرّف العملية (%): تعذّر إثبات تطابق بيانات الدفعة السابقة', _operation_id
        USING ERRCODE = '23505';
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'total_debt', v_debt.total_debt,
      'total_paid', v_debt.total_paid,
      'remaining_debt', v_debt.remaining_debt,
      'status', v_debt.status,
      'amount', v_existing_payment.amount,
      'settled_amount', v_existing_payment.settled_amount,
      'rounding_adjustment', v_existing_payment.rounding_adjustment
    );
  END IF;

  IF COALESCE(v_debt.status, '') IN ('fully_paid', 'cancelled', 'written_off') THEN
    RAISE EXCEPTION 'لا يمكن تسديد دين مغلق';
  END IF;
  IF v_payment_method NOT IN ('cash', 'transfer') THEN
    RAISE EXCEPTION 'طريقة قبض الدين غير صالحة';
  END IF;
  IF (v_payment_method = 'cash' AND _shift_id IS NULL)
     OR (v_payment_method = 'transfer' AND _shift_id IS NOT NULL) THEN
    RAISE EXCEPTION 'القبض النقدي يتطلب وردية أصلية، والتحويل لا يُرحّل إلى الصندوق';
  END IF;

  PERFORM public.assert_period_open(v_owner, CURRENT_DATE, 'تسديد دين');

  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'أدخل مبلغًا صحيحًا أكبر من الصفر';
  END IF;

  v_prev_remaining := round(COALESCE(v_debt.remaining_debt, v_debt.total_debt - COALESCE(v_debt.total_paid, 0))::numeric, 4);

  IF v_credit > v_prev_remaining + 0.005 THEN
    RAISE EXCEPTION 'المبلغ المدخل (%) أكبر من المتبقي (%)', v_credit, v_prev_remaining;
  END IF;

  -- Separate cash tendered (2 decimals) from debt settlement (snapping within 0.005 USD)
  IF abs(v_prev_remaining - v_credit) <= 0.005 THEN
    v_settlement := v_prev_remaining;
    v_new_remaining := 0;
    v_new_total_paid := v_debt.total_debt;
    v_rounding_adjustment := round(v_settlement - v_cash_amount, 4);
    IF abs(v_rounding_adjustment) > 0 THEN
      v_rounding_note := ' (تعديل تقريب: ' || v_rounding_adjustment::text || ' USD)';
    END IF;
  ELSE
    v_settlement := v_credit;
    v_rounding_adjustment := round(v_settlement - v_cash_amount, 4);
    v_new_remaining := GREATEST(round(v_prev_remaining - v_credit, 4), 0);
    v_new_total_paid := round(COALESCE(v_debt.total_paid, 0) + v_credit, 4);
  END IF;

  IF v_fx_credit_rate IS NOT NULL THEN
    v_fx_difference := round(v_cash_amount - v_settlement, 4);   -- > 0 gain, < 0 loss
    v_rounding_adjustment := 0;
    v_rounding_note := CASE WHEN v_fx_difference <> 0 THEN ' (فرق صرف: ' || v_fx_difference::text || ' USD)' ELSE '' END;
  END IF;

  v_tx_currency := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  v_tx_exchange_rate := CASE WHEN v_tx_currency = 'USD' THEN 1 ELSE _exchange_rate END;
  IF COALESCE(v_tx_exchange_rate, 0) <= 0 THEN RAISE EXCEPTION 'سعر صرف الدفعة غير صالح'; END IF;
  v_tx_currency_amount := COALESCE(round(_currency_amount, 4), round(v_cash_amount * v_tx_exchange_rate, 4));
  IF v_tx_currency_amount < 0 OR abs(v_tx_currency_amount / v_tx_exchange_rate - v_cash_amount) > 0.005
     OR (v_cash_amount > 0 AND v_tx_currency_amount <= 0) THEN
    RAISE EXCEPTION 'مبلغ العملة الأصلية لا يطابق مبلغ الدفعة';
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
    currency, currency_amount, exchange_rate, payment_method,
    paid_by, shift_id, fx_difference_usd, fx_credit_rate
  ) VALUES (
    v_owner, _debt_id, _operation_id, v_cash_amount,
    v_settlement, v_rounding_adjustment,
    v_tx_currency, v_tx_currency_amount, v_tx_exchange_rate, v_payment_method,
    auth.uid(), _shift_id, v_fx_difference, v_fx_credit_rate
  );

  IF _shift_id IS NOT NULL AND v_cash_amount > 0 THEN
    INSERT INTO public.shift_transactions(
      shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes
    ) VALUES (
      _shift_id, v_owner, 'debt_payment', v_cash_amount,
      v_tx_currency, v_tx_currency_amount, v_tx_exchange_rate,
      _operation_id,
      'تسديد دين للعميل: ' || COALESCE(v_debt.customer_name, '') || v_rounding_note
    );

    IF FOUND THEN
      UPDATE public.cash_shifts
         SET expected_balance = round(COALESCE(expected_balance, 0) + v_cash_amount, 8),
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

  v_response := jsonb_build_object(
    'success', true,
    'total_debt', v_debt.total_debt,
    'total_paid', v_debt.total_paid,
    'remaining_debt', v_debt.remaining_debt,
    'status', v_debt.status,
    'amount', v_cash_amount,
    'settled_amount', v_settlement,
    'rounding_adjustment', v_rounding_adjustment,
    'fx_difference_usd', v_fx_difference,
    'fx_credit_rate', v_fx_credit_rate,
    'confirmed_profit', _total_confirmed
  );
  INSERT INTO public.sales_settlement_replays(user_id, kind, operation_id, request, response)
  VALUES (v_owner, 'debt_payment', _operation_id, v_request, v_response);
  RETURN v_response;
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_deposit_atomic(_partner_id uuid, _amount_usd numeric, _deposit_target text DEFAULT 'capital'::text, _notes text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT 'USD'::text, _original_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT 1.0)
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
  _amt_usd numeric := round(COALESCE(_amount_usd, 0), 4);
  _ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  _orig_amt numeric;
  _rate numeric;
  _cap_record jsonb;
  _tx_note text;
BEGIN
  PERFORM set_config('app.partner_source', 'partner_deposit_atomic', true);
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير مسجل الدخول';
  END IF;

  IF NOT public.is_store_owner(_uid) THEN
    RAISE EXCEPTION 'هذه العملية مخصصة لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'لم يتم العثور على حساب المالك';
  END IF;

  IF _deposit_target IS NULL OR _deposit_target NOT IN ('capital', 'balance') THEN
    RAISE EXCEPTION 'وجهة الإيداع غير صالحة: %', COALESCE(_deposit_target, 'NULL');
  END IF;

  IF _amt_usd <= 0 OR _amt_usd::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'مبلغ الإيداع يجب أن يكون أكبر من الصفر';
  END IF;

  IF _original_amount::text IN ('NaN','Infinity','-Infinity')
     OR _exchange_rate::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'المبلغ أو سعر الصرف غير صالح';
  END IF;
  IF _ccy = 'USD' THEN
    _rate := 1.0;
    _orig_amt := round(_amt_usd, 8);
  ELSE
    _rate := COALESCE(_exchange_rate, 0);
    IF _rate <= 0 THEN
      RAISE EXCEPTION 'سعر الصرف غير صالح';
    END IF;
    _orig_amt := round(COALESCE(_original_amount, _amt_usd * _rate), 2);
    IF _orig_amt <= 0 THEN
      RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
    END IF;
    IF _original_amount IS NOT NULL AND _original_amount > 0 THEN
      IF abs(_orig_amt - round(_amt_usd * _rate, 2)) > (0.005 + 0.005 * _rate) THEN
        RAISE EXCEPTION 'تعارض في تحويل العملة: المبلغ الأصلي (%) لا يطابق المبلغ بالدولار (%) × سعر الصرف (%)',
          _orig_amt, _amt_usd, _rate;
      END IF;
    END IF;
  END IF;

  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'إيداع شريك');

  IF _shift_id IS NOT NULL THEN
    PERFORM 1 FROM public.cash_shifts
    WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
    END IF;
  END IF;

  SELECT * INTO _partner
  FROM public.partners
  WHERE id = _partner_id AND user_id = _owner
  FOR UPDATE;

  IF _partner IS NULL THEN
    RAISE EXCEPTION 'الشريك غير موجود أو غير تابع لهذا المتجر';
  END IF;

  _tx_note := COALESCE(_notes, CASE WHEN _deposit_target = 'balance' THEN 'إيداع رصيد للشريك' ELSE 'إيداع رأس مال' END);
  IF _ccy <> 'USD' AND _orig_amt IS NOT NULL THEN
    _tx_note := _tx_note || ' (' || _orig_amt::text || ' ' || _ccy || ')';
  END IF;

  _cap_record := jsonb_build_object(
    'id', _tx_id,
    'amount', _amt_usd,
    'type', 'deposit',
    'target', _deposit_target,
    'currency', _ccy,
    'originalAmount', _orig_amt,
    'exchangeRate', _rate,
    'date', now(),
    'notes', _tx_note
  );

  IF _deposit_target = 'balance' THEN
    UPDATE public.partners SET
      current_balance = round(COALESCE(current_balance, 0) + _amt_usd, 4),
      capital_history = COALESCE(capital_history, '[]'::jsonb) || _cap_record,
      updated_at = now()
    WHERE id = _partner_id;
  ELSE
    UPDATE public.partners SET
      initial_capital = round(COALESCE(initial_capital, 0) + _amt_usd, 4),
      current_capital = round(COALESCE(current_capital, 0) + _amt_usd, 4),
      capital_history = COALESCE(capital_history, '[]'::jsonb) || _cap_record,
      updated_at = now()
    WHERE id = _partner_id;
  END IF;

  IF _shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions (
      shift_id, user_id, type, amount, currency_amount, currency, exchange_rate, notes, reference_id
    ) VALUES (
      _shift_id, _owner, 'deposit_capital', _amt_usd, _orig_amt, _ccy, _rate,
      _tx_note || ' - الشريك: ' || _partner.name,
      _partner_id::text || ':' || gen_random_uuid()::text
    );

    UPDATE public.cash_shifts
       SET expected_balance = round(COALESCE(expected_balance, 0) + _amt_usd, 8),
           updated_at = now()
     WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'partner_id', _partner_id,
    'amount_usd', _amt_usd,
    'currency', _ccy,
    'original_amount', _orig_amt,
    'deposit_target', _deposit_target,
    'new_balance', CASE WHEN _deposit_target = 'balance' THEN round(COALESCE(_partner.current_balance, 0) + _amt_usd, 4) ELSE _partner.current_balance END,
    'new_capital', CASE WHEN _deposit_target = 'capital' THEN round(COALESCE(_partner.current_capital, 0) + _amt_usd, 4) ELSE _partner.current_capital END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_withdrawal_atomic(_partner_id uuid, _amount numeric, _withdrawal_type text, _notes text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT 'USD'::text, _original_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT 1.0, _operation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_owner uuid := public.get_owner_id(v_caller);
  v_partner public.partners%ROWTYPE;
  v_amt numeric := round(COALESCE(_amount, 0)::numeric, 4);
  v_ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  v_op_id text := NULLIF(trim(COALESCE(_operation_id, '')), '');
  v_orig_amt numeric;
  v_rate numeric;
  v_avail_profit numeric := 0;
  v_avail_capital numeric := 0;
  v_profit_part numeric := 0;
  v_capital_part numeric := 0;
  v_new_balance numeric;
  v_new_capital numeric;
  v_withdrawals jsonb := '[]'::jsonb;
  v_capital_entries jsonb := '[]'::jsonb;
  v_note_text text;
  v_shift_label text;
  v_request jsonb;
  v_recorded_request jsonb;
  v_result jsonb;
  v_profit_original numeric;
  v_capital_original numeric;
  v_cap_rate numeric;
BEGIN
  PERFORM set_config('app.partner_source', 'partner_withdrawal_atomic', true);
  IF v_op_id IS NOT NULL THEN
    PERFORM set_config('app.partner_ref', v_op_id, true);
  END IF;

  IF v_caller IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(v_caller) THEN
    RAISE EXCEPTION 'هذه العملية مخصصة لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  IF _withdrawal_type IS NULL OR _withdrawal_type NOT IN ('profit', 'capital', 'auto') THEN
    RAISE EXCEPTION 'نوع السحب غير صالح: %', COALESCE(_withdrawal_type, 'NULL');
  END IF;

  IF v_amt <= 0 OR v_amt::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر';
  END IF;

  IF v_op_id IS NOT NULL AND length(v_op_id) > 128 THEN
    RAISE EXCEPTION 'معرّف العملية غير صالح';
  END IF;

  IF _original_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR _exchange_rate::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'المبلغ أو سعر الصرف غير صالح';
  END IF;

  -- KD-08 / D-10: a capital withdrawal in a foreign currency is valued at the ORIGINAL deposit rate
  -- (weighted over the partner's capital deposits). The server computes the USD amount itself.
  IF _withdrawal_type = 'capital' AND v_ccy <> 'USD' THEN
    IF _original_amount IS NULL OR _original_amount <= 0 THEN
      RAISE EXCEPTION 'المبلغ الأصلي مطلوب لسحب رأس المال بعملة أجنبية';
    END IF;
    SELECT * INTO v_partner FROM public.partners WHERE id = _partner_id AND user_id = v_owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الشريك غير موجود أو غير تابع للمتجر';
    END IF;
    SELECT COALESCE(SUM((h->>'originalAmount')::numeric) / NULLIF(SUM((h->>'amount')::numeric), 0), 0)
      INTO v_cap_rate
      FROM jsonb_array_elements(COALESCE(v_partner.capital_history, '[]'::jsonb)) h
     WHERE h->>'type' = 'deposit'
       AND COALESCE((h->>'amount')::numeric, 0) > 0
       AND COALESCE((h->>'originalAmount')::numeric, 0) > 0;
    IF COALESCE(v_cap_rate, 0) <= 0 THEN
      RAISE EXCEPTION 'لا يمكن حساب سعر الإيداع الأصلي لرأس مال الشريك';
    END IF;
    v_amt := round(_original_amount / v_cap_rate, 4);
  END IF;

  -- Strict FX validation
  IF v_ccy = 'USD' THEN
    IF _exchange_rate IS NOT NULL AND abs(_exchange_rate - 1.0) > 0.0001 THEN
      RAISE EXCEPTION 'سعر الصرف لعملة USD يجب أن يساوي 1 (المستلم: %)', _exchange_rate;
    END IF;
    v_rate := 1.0;
    IF _original_amount IS NOT NULL THEN
      IF _original_amount <= 0 THEN
        RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
      END IF;
      v_orig_amt := round(_original_amount, 2);
      IF abs(v_orig_amt - round(v_amt, 2)) > 0.005 THEN
        RAISE EXCEPTION 'تعارض في المبلغ بالدولار: المبلغ الأصلي (%) لا يطابق المبلغ (%)',
          v_orig_amt, round(v_amt, 2);
      END IF;
    ELSE
      v_orig_amt := round(v_amt, 2);
    END IF;
  ELSE
    IF _withdrawal_type = 'capital' THEN
      v_rate := v_cap_rate;
    ELSE
      v_rate := COALESCE(_exchange_rate, 0);
    END IF;
    IF v_rate <= 0 THEN
      RAISE EXCEPTION 'سعر الصرف غير صالح لعملة %', v_ccy;
    END IF;
    IF _original_amount IS NOT NULL AND _original_amount <= 0 THEN
      RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
    END IF;
    v_orig_amt := round(COALESCE(_original_amount, v_amt * v_rate), 2);
    IF v_orig_amt <= 0 THEN
      RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
    END IF;
    IF _original_amount IS NOT NULL THEN
      IF abs(v_orig_amt - round(v_amt * v_rate, 2)) > (0.005 + 0.005 * v_rate) THEN
        RAISE EXCEPTION 'تعارض في تحويل العملة: المبلغ الأصلي (%) لا يطابق المبلغ بالدولار (%) × سعر الصرف (%)',
          v_orig_amt, v_amt, v_rate;
      END IF;
    END IF;
  END IF;

  -- KD-08 / D-10: automatic split (profit first, then capital) is for USD only. A foreign-currency withdrawal
  -- is sent as two separate rows (profit row, capital row), each valued at its own rate.
  IF _withdrawal_type = 'auto' AND v_ccy <> 'USD' THEN
    RAISE EXCEPTION 'السحب التلقائي بعملة أجنبية غير مدعوم: اسحب الربح ورأس المال في سطرين منفصلين';
  END IF;

  IF v_op_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('partner_withdraw_op:' || v_owner::text || ':' || v_op_id));
    v_request := jsonb_build_object(
      'partner_id', _partner_id, 'amount', v_amt, 'withdrawal_type', _withdrawal_type,
      'currency', v_ccy, 'original_amount', v_orig_amt, 'exchange_rate', v_rate,
      'shift_id', _shift_id, 'notes', NULLIF(trim(_notes), '')
    );
    SELECT request, result INTO v_recorded_request, v_result
      FROM public.accounting_rpc_receipts
     WHERE user_id = v_owner AND kind = 'partner_withdrawal' AND operation_id = v_op_id;
    IF FOUND THEN
      IF v_recorded_request IS DISTINCT FROM v_request THEN
        RAISE EXCEPTION 'معرّف السحب مرتبط بطلب مختلف';
      END IF;
      RETURN v_result || jsonb_build_object('already_processed', true);
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.partner_ledger_entries ple
       WHERE ple.user_id = v_owner AND ple.source = 'partner_withdrawal_atomic' AND ple.reference = v_op_id
    ) OR EXISTS (
      SELECT 1 FROM public.partners p
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.withdrawal_history, '[]'::jsonb)) h
       WHERE p.user_id = v_owner AND h->>'operationId' = v_op_id
    ) THEN
      RAISE EXCEPTION 'تم ترحيل معرّف السحب سابقاً دون إيصال كامل. راجع دفتر الشريك قبل إعادة المحاولة';
    END IF;
  END IF;

  PERFORM public.assert_period_open(v_owner, CURRENT_DATE, 'سحب شريك');

  IF _shift_id IS NOT NULL THEN
    PERFORM 1 FROM public.cash_shifts
    WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
    END IF;
  END IF;

  SELECT * INTO v_partner FROM public.partners WHERE id = _partner_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'الشريك غير موجود أو غير تابع للمتجر';
  END IF;

  v_note_text := COALESCE(_notes, '');
  IF v_ccy <> 'USD' AND v_orig_amt IS NOT NULL THEN
    v_note_text := v_note_text || ' (' || v_orig_amt::text || ' ' || v_ccy || ')';
  END IF;

  IF _withdrawal_type = 'profit' THEN
    IF v_amt > COALESCE(v_partner.current_balance, 0) THEN
      RAISE EXCEPTION 'رصيد أرباح الشريك لا يكفي (المتاح: %)', v_partner.current_balance;
    END IF;
    v_profit_part := v_amt;
    v_capital_part := 0;

    v_withdrawals := jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'id', gen_random_uuid()::text,
        'operationId', v_op_id,
        'amount', v_profit_part,
        'currency', v_ccy,
        'originalAmount', v_orig_amt,
        'exchangeRate', v_rate,
        'type', 'profit',
        'date', now()::text,
        'notes', v_note_text
      ))
    );

  ELSIF _withdrawal_type = 'capital' THEN
    IF v_amt > COALESCE(v_partner.current_capital, 0) THEN
      RAISE EXCEPTION 'رأس مال الشريك لا يكفي (المتاح: %)', v_partner.current_capital;
    END IF;
    v_profit_part := 0;
    v_capital_part := v_amt;

    v_withdrawals := jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'id', gen_random_uuid()::text,
        'operationId', v_op_id,
        'amount', v_capital_part,
        'currency', v_ccy,
        'originalAmount', v_orig_amt,
        'exchangeRate', v_rate,
        'type', 'capital',
        'date', now()::text,
        'notes', v_note_text
      ))
    );

    v_capital_entries := jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'id', gen_random_uuid()::text || '_cap',
        'operationId', v_op_id,
        'amount', v_capital_part,
        'currency', v_ccy,
        'originalAmount', v_orig_amt,
        'exchangeRate', v_rate,
        'type', 'withdrawal',
        'date', now()::text,
        'notes', v_note_text
      ))
    );

  ELSE
    -- _withdrawal_type = 'auto': deduct available profit first, remainder from capital
    v_avail_profit := GREATEST(COALESCE(v_partner.current_balance, 0), 0);
    v_avail_capital := GREATEST(COALESCE(v_partner.current_capital, 0), 0);

    IF v_amt > round(v_avail_profit + v_avail_capital, 4) THEN
      RAISE EXCEPTION 'الرصيد الإجمالي للشريك لا يكفي (أرباح متاحة: %، رأس مال متاح: %)',
        v_avail_profit, v_avail_capital;
    END IF;

    v_profit_part := round(LEAST(v_amt, v_avail_profit), 4);
    v_capital_part := round(v_amt - v_profit_part, 4);
    v_profit_original := round(v_orig_amt * v_profit_part / v_amt, 2);
    v_capital_original := v_orig_amt - v_profit_original;

    IF v_profit_part > 0 THEN
      v_withdrawals := v_withdrawals || jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'id', gen_random_uuid()::text,
          'operationId', v_op_id,
          'amount', v_profit_part,
          'currency', v_ccy,
          'originalAmount', v_profit_original,
          'exchangeRate', v_rate,
          'type', 'profit',
          'autoSplit', (v_capital_part > 0),
          'date', now()::text,
          'notes', v_note_text
        ))
      );
    END IF;

    IF v_capital_part > 0 THEN
      v_withdrawals := v_withdrawals || jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'id', gen_random_uuid()::text,
          'operationId', v_op_id,
          'amount', v_capital_part,
          'currency', v_ccy,
          'originalAmount', v_capital_original,
          'exchangeRate', v_rate,
          'type', 'capital',
          'autoSplit', (v_profit_part > 0),
          'date', now()::text,
          'notes', v_note_text
        ))
      );

      v_capital_entries := jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'id', gen_random_uuid()::text || '_cap',
          'operationId', v_op_id,
          'amount', v_capital_part,
          'currency', v_ccy,
          'originalAmount', v_capital_original,
          'exchangeRate', v_rate,
          'type', 'withdrawal',
          'autoSplit', (v_profit_part > 0),
          'date', now()::text,
          'notes', v_note_text
        ))
      );
    END IF;
  END IF;

  v_new_balance := round(COALESCE(v_partner.current_balance, 0) - v_profit_part, 4);
  v_new_capital := round(COALESCE(v_partner.current_capital, 0) - v_capital_part, 4);

  UPDATE public.partners
     SET current_balance = v_new_balance,
         current_capital = v_new_capital,
         total_withdrawn = round(COALESCE(total_withdrawn, 0) + v_amt, 4),
         withdrawal_history = COALESCE(withdrawal_history, '[]'::jsonb) || v_withdrawals,
         capital_history = CASE
           WHEN jsonb_array_length(v_capital_entries) > 0
           THEN COALESCE(capital_history, '[]'::jsonb) || v_capital_entries
           ELSE capital_history
         END,
         updated_at = now()
   WHERE id = _partner_id;

  IF _shift_id IS NOT NULL THEN
    v_shift_label := CASE
      WHEN _withdrawal_type = 'capital' THEN 'رأس مال'
      WHEN _withdrawal_type = 'auto' THEN
        CASE
          WHEN v_profit_part > 0 AND v_capital_part > 0 THEN 'أرباح ورأس مال (تلقائي)'
          WHEN v_capital_part > 0 THEN 'رأس مال (تلقائي)'
          ELSE 'أرباح (تلقائي)'
        END
      ELSE 'أرباح'
    END;

    INSERT INTO public.shift_transactions (
      shift_id, user_id, type, amount, currency_amount, currency, exchange_rate, notes, reference_id
    ) VALUES (
      _shift_id, v_owner, 'withdrawal', v_amt, v_orig_amt, v_ccy, v_rate,
      'سحب ' || v_shift_label || ' للشريك: ' || v_partner.name || CASE WHEN v_note_text <> '' THEN ' - ' || v_note_text ELSE '' END,
      COALESCE(v_op_id, _partner_id::text || ':' || gen_random_uuid()::text)
    );

    UPDATE public.cash_shifts
       SET expected_balance = round(COALESCE(expected_balance, 0) - v_amt, 8),
           updated_at = now()
     WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL;
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'already_processed', false,
    'partner_id', _partner_id,
    'operation_id', v_op_id,
    'amount', v_amt,
    'currency', v_ccy,
    'original_amount', v_orig_amt,
    'exchange_rate', v_rate,
    'withdrawal_type', _withdrawal_type,
    'profit_deducted', v_profit_part,
    'capital_deducted', v_capital_part,
    'new_balance', v_new_balance,
    'new_capital', v_new_capital
  );
  IF v_op_id IS NOT NULL THEN
    INSERT INTO public.accounting_rpc_receipts(user_id, kind, operation_id, request, result)
    VALUES (v_owner, 'partner_withdrawal', v_op_id, v_request, v_result);
  END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.process_quick_purchase_atomic(_operation_id uuid, _purchase jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _existing public.purchase_invoices%ROWTYPE;
  _product_id uuid := NULLIF(_purchase->>'productId', '')::uuid;
  _shift_id uuid := NULLIF(_purchase->>'shiftId', '')::uuid;
  _supplier_id uuid := NULLIF(_purchase->>'supplierId', '')::uuid;
  _name text := NULLIF(btrim(_purchase->>'productName'), '');
  _barcode text := NULLIF(btrim(_purchase->>'barcode'), '');
  _category text := NULLIF(btrim(_purchase->>'category'), '');
  _image text := NULLIF(_purchase->>'imageUrl', '');
  _method text := _purchase->>'paymentMethod';
  _qty numeric := (_purchase->>'quantity')::numeric;
  _cost numeric := (_purchase->>'costPrice')::numeric;
  _price numeric := COALESCE((_purchase->>'salePrice')::numeric, _cost);
  _total numeric;
  _invoice_number text := 'QP-' || _operation_id::text;
  _result jsonb;
  _cash_amount numeric;
  _cash_shift_id uuid;
  _creates_product boolean;
BEGIN
  IF _caller IS NULL OR _operation_id IS NULL THEN
    RAISE EXCEPTION 'Authentication and operation ID are required';
  END IF;
  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'Store context is required';
  END IF;
  IF _name IS NULL OR _method IS NULL OR _method NOT IN ('cash', 'credit')
     OR _qty IS NULL OR NOT (_qty > 0 AND _qty < 1000000000)
     OR _cost IS NULL OR NOT (_cost >= 0 AND _cost < 1000000000)
     OR _price IS NULL OR NOT (_price >= 0 AND _price < 1000000000) THEN
    RAISE EXCEPTION 'Invalid quick purchase input';
  END IF;
  _total := round(_qty * _cost, 8);

  -- F7 (audit 2026-11-24): a credit quick purchase must name an active supplier of this store.
  IF _method = 'credit' THEN
    IF _supplier_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.suppliers sp WHERE sp.id = _supplier_id AND sp.user_id = _owner AND COALESCE(sp.is_active, true)
    ) THEN
      RAISE EXCEPTION 'يلزم اختيار مورد للشراء الآجل';
    END IF;
  END IF;

  -- Serialize duplicate requests and product resolution for quick purchases within the same store.
  PERFORM pg_advisory_xact_lock(hashtextextended('flowpos-quick-purchase:' || _owner::text, 0));
  SELECT * INTO _existing FROM public.purchase_invoices
    WHERE id = _operation_id AND user_id = _owner;
  IF FOUND THEN
    IF _existing.invoice_number <> _invoice_number OR _existing.status IS DISTINCT FROM 'finalized' THEN
      RAISE EXCEPTION 'Operation ID is already used by a different purchase';
    END IF;
    SELECT amount, shift_id INTO _cash_amount, _cash_shift_id FROM public.shift_transactions
      WHERE user_id = _owner AND type = 'withdrawal' AND reference_id = _operation_id::text
      LIMIT 1;
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'invoice_id', _existing.id,
      'cash_amount', _cash_amount, 'shift_id', _cash_shift_id);
  END IF;

  -- Lock the specific drawer before writing stock. Closure and payment must agree on the shift.
  IF _method = 'cash' AND _total > 0 THEN
    PERFORM 1 FROM public.cash_shifts
    WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL
      AND (cashier_id::text = _caller::text OR _caller = _owner)
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'An open cash shift for this purchase is required';
    END IF;
  END IF;

  IF _product_id IS NOT NULL THEN
    PERFORM 1 FROM public.products
      WHERE id = _product_id AND user_id = _owner AND NOT COALESCE(archived, false);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product is not available in this store';
    END IF;
  ELSE
    IF _barcode IS NOT NULL THEN
      SELECT id INTO _product_id FROM public.products WHERE user_id = _owner AND barcode = _barcode
        ORDER BY created_at, id LIMIT 1;
    END IF;
    IF _product_id IS NULL THEN
      SELECT id INTO _product_id FROM public.products
        WHERE user_id = _owner AND lower(btrim(name)) = lower(_name)
        ORDER BY created_at, id LIMIT 1;
    END IF;
    IF _product_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.products WHERE id = _product_id AND COALESCE(archived, false)
    ) THEN
      RAISE EXCEPTION 'Matching product is archived';
    END IF;
  END IF;
  _creates_product := _product_id IS NULL;

  INSERT INTO public.purchase_invoices (
    id, user_id, invoice_number, supplier_name, invoice_date, status, payment_method, image_url, supplier_id,
    expected_items_count, expected_total_quantity, expected_grand_total,
    actual_items_count, actual_total_quantity, actual_grand_total
  ) VALUES (
    _operation_id, _owner, _invoice_number, CASE WHEN _method = 'credit' THEN (SELECT sp.name FROM public.suppliers sp WHERE sp.id = _supplier_id) ELSE _name END, CURRENT_DATE, 'draft', _method, _image, CASE WHEN _method = 'credit' THEN _supplier_id ELSE NULL END,
    1, _qty, _total, 1, _qty, _total
  );
  INSERT INTO public.purchase_invoice_items (
    invoice_id, product_id, product_name, barcode, category, quantity, cost_price, sale_price, total_cost
  ) VALUES (_operation_id, _product_id, _name, _barcode, _category, _qty, _cost, _price, _total);

  _result := public.finalize_purchase_invoice_atomic(_operation_id);
  IF NOT COALESCE((_result->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'Purchase finalization failed';
  END IF;
  SELECT product_id INTO STRICT _product_id FROM public.purchase_invoice_items WHERE invoice_id = _operation_id;

  UPDATE public.products
  SET sale_price = CASE WHEN _price > 0 THEN _price ELSE sale_price END,
      barcode = COALESCE(_barcode, barcode),
      category = COALESCE(_category, category),
      expiry_date = COALESCE(NULLIF(_purchase->>'expiryDate', '')::date, expiry_date),
      image_url = COALESCE(_image, image_url),
      custom_fields = CASE WHEN _purchase ? 'wholesalePrice'
        THEN COALESCE(custom_fields, '{}'::jsonb) || jsonb_build_object('wholesalePrice', (_purchase->>'wholesalePrice')::numeric)
        ELSE custom_fields END,
      min_stock_level = CASE WHEN _creates_product THEN COALESCE((_purchase->>'minStockLevel')::integer, min_stock_level) ELSE min_stock_level END,
      track_by_unit = CASE WHEN _creates_product AND _purchase->>'trackByUnit' IN ('piece','bulk') THEN _purchase->>'trackByUnit' ELSE track_by_unit END,
      bulk_unit = CASE WHEN _creates_product THEN COALESCE(_purchase->>'bulkUnit', bulk_unit) ELSE bulk_unit END,
      small_unit = CASE WHEN _creates_product THEN COALESCE(_purchase->>'smallUnit', small_unit) ELSE small_unit END,
      conversion_factor = CASE WHEN _creates_product THEN GREATEST(COALESCE((_purchase->>'conversionFactor')::numeric, 1), 1) ELSE conversion_factor END,
      bulk_cost_price = CASE WHEN _creates_product THEN COALESCE((_purchase->>'bulkCostPrice')::numeric, bulk_cost_price) ELSE bulk_cost_price END,
      bulk_sale_price = CASE WHEN _creates_product THEN COALESCE((_purchase->>'bulkSalePrice')::numeric, bulk_sale_price) ELSE bulk_sale_price END,
      updated_at = now()
  WHERE id = _product_id AND user_id = _owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unable to update product details';
  END IF;

  IF _method = 'cash' AND _total > 0 THEN
    INSERT INTO public.shift_transactions (
      shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes
    ) VALUES (
      _shift_id, _owner, 'withdrawal', _total, 'USD', _total, 1, _operation_id::text, 'Quick purchase'
    );
    -- Keep the drawer cache in step with the movement (the row is already locked above; replays return earlier)
    UPDATE public.cash_shifts
       SET expected_balance = round(COALESCE(expected_balance, 0) - _total, 8)
     WHERE id = _shift_id AND user_id = _owner;
  END IF;

  RETURN jsonb_build_object('success', true, 'already_processed', false, 'invoice_id', _operation_id,
    'cash_amount', CASE WHEN _method = 'cash' THEN _total END,
    'shift_id', CASE WHEN _method = 'cash' AND _total > 0 THEN _shift_id END);
END;
$function$;

CREATE OR REPLACE FUNCTION public.payout_store_credit_atomic(_customer_id uuid, _amount numeric, _shift_id uuid, _operation_id text, _currency text DEFAULT 'USD'::text, _currency_amount numeric DEFAULT NULL::numeric, _rate numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _o uuid := public._credit_actor(true);
  _id uuid;
  _bal numeric;
  _amt numeric := round(COALESCE(_amount, 0), 4);
  _ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  _eff_rate numeric;
  _eff_ccy_amt numeric;
BEGIN
  IF _amt <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  IF _shift_id IS NULL THEN RAISE EXCEPTION 'صرف الرصيد نقداً يتطلب وردية مفتوحة'; END IF;
  IF COALESCE(_operation_id,'') = '' THEN RAISE EXCEPTION 'معرّف العملية مطلوب'; END IF;

  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'صرف رصيد عميل');

  IF _ccy = 'USD' THEN
    _eff_rate := 1;
    _eff_ccy_amt := _amt;
  ELSE
    _eff_rate := COALESCE(_rate, (SELECT NULLIF((ss.exchange_rates->>_ccy)::numeric, 0) FROM public.store_settings ss WHERE ss.user_id = _o LIMIT 1));
    IF _eff_rate IS NULL OR _eff_rate <= 0 THEN
      RAISE EXCEPTION 'سعر صرف العملة % غير صالح', _ccy;
    END IF;
    _eff_ccy_amt := round(COALESCE(NULLIF(_currency_amount, 0), _amt * _eff_rate), 4);
    IF _eff_ccy_amt <= 0 THEN
      RAISE EXCEPTION 'مبلغ العملة % غير صالح', _ccy;
    END IF;
    IF _currency_amount IS NOT NULL AND _currency_amount > 0 THEN
      IF abs(_eff_ccy_amt - (_amount * _eff_rate)) > GREATEST(0.05, (_amount * _eff_rate) * 0.01) THEN
        RAISE EXCEPTION 'مبلغ العملة (%) لا يطابق القيمة المحوّلة (% × %)', _eff_ccy_amt, _amount, _eff_rate;
      END IF;
    END IF;
  END IF;

  PERFORM 1 FROM public.customers WHERE id=_customer_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'العميل غير موجود'; END IF;
  SELECT id INTO _id FROM public.customer_credit_ledger WHERE user_id=_o AND operation_id=_operation_id AND entry_type='payout';
  IF _id IS NOT NULL THEN RETURN _id; END IF;

  SELECT round(COALESCE(SUM(amount),0), 4) INTO _bal FROM public.customer_credit_ledger WHERE customer_id=_customer_id;
  IF _amt > _bal THEN RAISE EXCEPTION 'رصيد العميل (%) أقل من المبلغ المطلوب', round(_bal,2); END IF;

  PERFORM 1 FROM public.cash_shifts WHERE id=_shift_id AND user_id=_o AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'لا توجد وردية مفتوحة'; END IF;

  INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,reference_id,notes,currency,currency_amount,exchange_rate)
  VALUES (_shift_id,_o,'store_credit_refund',_amt,_operation_id,'صرف رصيد عميل نقداً',_ccy,_eff_ccy_amt,_eff_rate);

  UPDATE public.cash_shifts
     SET expected_balance = round(COALESCE(expected_balance, 0) - _amt, 8),
         updated_at = now()
   WHERE id = _shift_id AND user_id = _o AND closed_at IS NULL;

  INSERT INTO public.customer_credit_ledger(user_id,customer_id,entry_type,amount,shift_id,reason,operation_id,created_by)
  VALUES (_o,_customer_id,'payout',-_amt,_shift_id,'صرف رصيد نقداً',_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END
$function$;

CREATE OR REPLACE FUNCTION public.mark_invoice_digital(_invoice_number text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _inv public.invoices%ROWTYPE;
  _sale_tx public.shift_transactions%ROWTYPE;
  _shift public.cash_shifts%ROWTYPE;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;
  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'لم يتم العثور على سياق المتجر';
  END IF;

  SELECT * INTO _inv
    FROM public.invoices
   WHERE invoice_number = _invoice_number
     AND user_id = _owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF COALESCE(_inv.status, '') IN ('refunded', 'cancelled', 'written_off') THEN
    RAISE EXCEPTION 'لا يمكن تعديل طريقة الدفع لفاتورة مستردة أو ملغاة أو مشطوبة';
  END IF;

  PERFORM public.assert_period_open(_owner, _inv.date, 'تعديل طريقة الدفع');

  IF COALESCE(_inv.payment_method, 'cash') = 'digital' THEN
    RETURN false;
  END IF;

  -- Lock any cash sale transaction(s) linked to this invoice and their shift(s)
  FOR _sale_tx IN
    SELECT st.*
      FROM public.shift_transactions st
     WHERE st.user_id = _owner
       AND st.type = 'sale'
       AND st.reference_id IN (_inv.invoice_number, _inv.id::text)
     ORDER BY st.created_at ASC
     FOR UPDATE
  LOOP
    SELECT * INTO _shift
      FROM public.cash_shifts
     WHERE id = _sale_tx.shift_id
       AND user_id = _owner
     FOR UPDATE;

    IF FOUND THEN
      IF _shift.closed_at IS NOT NULL THEN
        RAISE EXCEPTION 'لا يمكن تحويل فاتورة مرتبطة بوردية مغلقة إلى دفع إلكتروني مباشرة';
      END IF;

      -- Record reversing settlement entry to remove the sale from cash drawer
      INSERT INTO public.shift_transactions (
        shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes
      ) VALUES (
        _sale_tx.shift_id,
        _owner,
        'transfer_out',
        COALESCE(_sale_tx.amount, 0),
        COALESCE(_sale_tx.currency, 'USD'),
        COALESCE(_sale_tx.currency_amount, _sale_tx.amount, 0),
        COALESCE(_sale_tx.exchange_rate, 1),
        'digital_reclass:' || _sale_tx.id::text,
        'تسوية تحويل الفاتورة ' || _inv.invoice_number || ' إلى دفع إلكتروني'
      )
      ON CONFLICT (shift_id, type, reference_id) DO NOTHING;

      IF FOUND THEN
        UPDATE public.cash_shifts
           SET expected_balance = round(COALESCE(expected_balance, 0) - COALESCE(_sale_tx.amount, 0), 8),
               updated_at = now()
         WHERE id = _sale_tx.shift_id
           AND user_id = _owner
           AND closed_at IS NULL;
      END IF;
    END IF;
  END LOOP;

  UPDATE public.invoices
     SET payment_method = 'digital',
         updated_at = now()
   WHERE id = _inv.id;

  RETURN true;
END $function$;

CREATE OR REPLACE FUNCTION public._allocate_sales_refund(_inv invoices, _kind text, _operation text, _wanted numeric, _shift uuid, _mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  _receipts jsonb := '[]'::jsonb;
  _receipt record;
  _take numeric;
  _pending numeric := greatest(round(coalesce(_wanted, 0), 8), 0);
  _available numeric := 0;
  _previous numeric;
  _previous_usd numeric;
  _previous_original numeric;
  _net_usd numeric;
  _net_original numeric;
  _cash numeric := 0;
  _digital numeric := 0;
  _drawer numeric := 0;
  _drawer_recorded boolean := false;
  _allocations jsonb := '[]'::jsonb;
  _sale_settled numeric;
  _sale_shift public.shift_transactions%ROWTYPE;
  _sale_matches integer;
  _sale_method text;
  _sale_currency text;
  _sale_rate numeric;
  _sale_original numeric;
  _payment record;
BEGIN
  IF _pending <= 0 THEN
    RETURN jsonb_build_object('cash', 0, 'digital', 0, 'drawer', 0, 'allocations', _allocations);
  END IF;
  IF _mode NOT IN ('drawer', 'external_cash') THEN RAISE EXCEPTION 'وضع تسوية المرتجع غير صالح'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.activity_log l
     WHERE l.user_id = _inv.user_id AND l.entity_id = _inv.id::text AND l.action_type = 'partial_refund'
       AND COALESCE((l.metadata->>'cash_to_refund')::numeric, 0)
           + COALESCE((l.metadata->>'digital_to_refund')::numeric, 0) > 0
       AND NOT COALESCE((l.metadata->>'receipt_allocation')::boolean, false)
  ) THEN
    RAISE EXCEPTION 'يلزم مطابقة المرتجع السابق مع إيصالات القبض قبل تسجيل رد إضافي';
  END IF;

  _sale_settled := CASE WHEN _inv.payment_type = 'debt' THEN COALESCE(_inv.paid_at_sale, 0)
    ELSE COALESCE(NULLIF(_inv.paid_at_sale, 0), _inv.total + COALESCE((
      SELECT sum(a.settled_amount) FROM public.sales_refund_allocations a
       WHERE a.user_id = _inv.user_id AND a.invoice_id = _inv.id AND a.receipt_key = 'sale'
    ), 0)) END;
  IF _sale_settled > 0 THEN
    -- Cash receipts must be traceable when refunding a debt invoice. Paid-at-sale was historically inferred.
    _sale_method := CASE _inv.payment_method WHEN 'digital' THEN 'transfer' WHEN 'cash' THEN 'cash' END;
    _sale_currency := upper(COALESCE(NULLIF(trim(_inv.currency), ''), 'USD'));
    _sale_rate := CASE WHEN _sale_currency = 'USD' THEN 1 ELSE _inv.exchange_rate END;
    IF _sale_method IS NULL OR COALESCE(_sale_rate, 0) <= 0 THEN
      RAISE EXCEPTION 'وسيلة قبض البيع الأصلي أو عملته غير موثقة';
    END IF;

    SELECT count(*) INTO _sale_matches FROM public.shift_transactions t
     WHERE t.user_id = _inv.user_id AND t.reference_id IN (_inv.operation_id, _inv.invoice_number, _inv.id::text)
       AND t.type IN ('sale', 'digital_sale');
    IF _sale_matches = 1 THEN
      SELECT t.* INTO _sale_shift FROM public.shift_transactions t
       WHERE t.user_id = _inv.user_id AND t.reference_id IN (_inv.operation_id, _inv.invoice_number, _inv.id::text)
         AND t.type IN ('sale', 'digital_sale');
      IF (CASE _sale_shift.type WHEN 'sale' THEN 'cash' ELSE 'transfer' END) <> _sale_method
         OR upper(COALESCE(_sale_shift.currency, 'USD')) <> _sale_currency
         OR abs(_sale_shift.amount - _sale_settled) > 0.005 THEN
        RAISE EXCEPTION 'حركة قبض البيع الأصلي لا تطابق الفاتورة';
      END IF;
      _sale_original := CASE WHEN _sale_currency = 'USD' THEN _sale_shift.amount ELSE _sale_shift.currency_amount END;
      IF COALESCE(_sale_original, 0) <= 0 OR abs(_sale_original / _sale_rate - _sale_shift.amount) > 0.005 THEN
        RAISE EXCEPTION 'مبلغ عملة حركة البيع الأصلية غير موثق';
      END IF;
    ELSIF _sale_matches <> 0 OR _inv.payment_type = 'debt' THEN
      RAISE EXCEPTION 'تعذّر تحديد حركة الدفعة الأولى الأصلية';
    ELSE
      _sale_original := round(_sale_settled * _sale_rate, 4);
    END IF;
    _receipts := _receipts || jsonb_build_object('key', 'sale', 'method', _sale_method,
      'ccy', _sale_currency, 'rate', _sale_rate, 'settled', _sale_settled,
      'usd', CASE WHEN _sale_matches = 1 THEN _sale_shift.amount ELSE round(_sale_settled, 2) END,
      'original', _sale_original);
  END IF;

  IF _inv.payment_type = 'debt' THEN
    FOR _payment IN
      SELECT p.*, (SELECT count(*) FROM public.shift_transactions t
               WHERE t.shift_id = p.shift_id AND t.user_id = p.user_id AND t.type = 'debt_payment'
                 AND t.reference_id = p.operation_id) AS movements,
             (SELECT t.currency_amount FROM public.shift_transactions t
               WHERE t.shift_id = p.shift_id AND t.user_id = p.user_id AND t.type = 'debt_payment'
                 AND t.reference_id = p.operation_id
                 AND t.amount = p.amount AND upper(t.currency) = upper(p.currency) AND t.exchange_rate = p.exchange_rate
               LIMIT 1) AS movement_currency_amount
        FROM public.debt_payments p JOIN public.debts d ON d.id = p.debt_id AND d.user_id = p.user_id
       WHERE p.user_id = _inv.user_id AND NOT COALESCE(d.is_cash_debt, false)
         AND d.invoice_id IN (_inv.invoice_number, _inv.id::text)
       ORDER BY p.created_at, p.id
    LOOP
      IF COALESCE(_payment.settled_amount, 0) <= 0 OR COALESCE(_payment.amount, -1) < 0
         OR COALESCE(_payment.payment_method, '') NOT IN ('cash', 'transfer')
         OR NULLIF(trim(_payment.currency), '') IS NULL OR COALESCE(_payment.exchange_rate, 0) <= 0
         OR (_payment.payment_method = 'cash' AND _payment.amount > 0
             AND (_payment.movements <> 1 OR _payment.movement_currency_amount IS NULL))
         OR (_payment.payment_method = 'transfer' AND _payment.shift_id IS NOT NULL) THEN
        RAISE EXCEPTION 'إحدى دفعات الدين الأصلية غير موثقة بما يكفي للرد';
      END IF;
      _sale_original := CASE WHEN upper(_payment.currency) = 'USD' THEN _payment.amount
                        ELSE COALESCE(_payment.currency_amount, _payment.movement_currency_amount) END;
      IF _sale_original IS NULL OR _sale_original < 0
          OR (_payment.amount > 0 AND _sale_original <= 0)
          OR abs(_sale_original / _payment.exchange_rate - _payment.amount) > 0.005 THEN
        RAISE EXCEPTION 'مبلغ العملة الأصلية لإحدى الدفعات غير موثق';
      END IF;
      _receipts := _receipts || jsonb_build_object('key', 'debt:' || _payment.id::text,
        'method', _payment.payment_method, 'ccy', upper(_payment.currency), 'rate', _payment.exchange_rate,
        'settled', _payment.settled_amount, 'usd', _payment.amount, 'original', _sale_original);
    END LOOP;
  END IF;

  SELECT COALESCE(sum(s.settled - COALESCE(previous.used, 0)), 0) INTO _available
    FROM jsonb_to_recordset(_receipts) AS s(key text, settled numeric)
    LEFT JOIN LATERAL (SELECT sum(a.settled_amount) AS used FROM public.sales_refund_allocations a
      WHERE a.user_id = _inv.user_id AND a.invoice_id = _inv.id AND a.receipt_key = s.key) previous ON true;
  IF _pending > _available + 0.0001
       OR (_inv.payment_type = 'debt' AND abs(_available - COALESCE(_inv.debt_paid, 0)) > 0.0001) THEN
    RAISE EXCEPTION 'مبلغ الرد لا يطابق المتبقي من إيصالات القبض الأصلية';
  END IF;
  _pending := LEAST(_pending, _available);

  IF _mode = 'drawer' AND EXISTS (SELECT 1 FROM jsonb_to_recordset(_receipts) AS s(method text) WHERE s.method = 'cash') THEN
    IF _shift IS NOT NULL THEN
      PERFORM 1 FROM public.cash_shifts WHERE id = _shift AND user_id = _inv.user_id AND closed_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'وردية الرد غير موجودة أو مغلقة أو لا تتبع لهذا المتجر'; END IF;
    END IF;
  END IF;

  FOR _receipt IN
    SELECT s.* FROM jsonb_array_elements(_receipts) WITH ORDINALITY r(value, ordinal)
      CROSS JOIN LATERAL jsonb_to_record(r.value)
        AS s(key text, method text, ccy text, rate numeric, settled numeric, usd numeric, original numeric)
      ORDER BY r.ordinal
  LOOP
    EXIT WHEN _pending <= 0;
    SELECT COALESCE(sum(a.settled_amount), 0), COALESCE(sum(a.tender_usd), 0), COALESCE(sum(a.currency_amount), 0)
      INTO _previous, _previous_usd, _previous_original
      FROM public.sales_refund_allocations a
     WHERE a.user_id = _inv.user_id AND a.invoice_id = _inv.id AND a.receipt_key = _receipt.key;
    _take := LEAST(_pending, _receipt.settled - _previous);
    CONTINUE WHEN _take <= 0;
    _net_usd := round(_receipt.usd * (_previous + _take) / _receipt.settled, 8) - _previous_usd;
    _net_original := round(_receipt.original * (_previous + _take) / _receipt.settled,
      CASE WHEN _receipt.ccy = 'USD' THEN 2 ELSE 4 END) - _previous_original;
    IF _net_usd < 0 OR _net_original < 0 THEN RAISE EXCEPTION 'تعارض في رصيد إيصال القبض التاريخي'; END IF;

    IF _receipt.method = 'cash' THEN
      _cash := _cash + _net_usd;
      IF _mode = 'drawer' AND (_net_usd > 0 OR _net_original > 0) THEN
        IF _shift IS NULL THEN RAISE EXCEPTION 'الرد النقدي يتطلب وردية تسوية صريحة ومفتوحة'; END IF;
        INSERT INTO public.shift_transactions(shift_id, user_id, type, amount, reference_id, notes, currency, currency_amount, exchange_rate)
        VALUES (_shift, _inv.user_id, 'refund', _net_usd, 'receipt-refund:' || _kind || ':' || _operation || ':' || _receipt.key,
          'رد إيصال قبض للفاتورة ' || _inv.invoice_number, _receipt.ccy, _net_original, _receipt.rate);
        _drawer := _drawer + _net_usd;
        _drawer_recorded := true;
      END IF;
    ELSE
      _digital := _digital + _net_usd;
    END IF;

    INSERT INTO public.sales_refund_allocations(user_id, invoice_id, kind, operation_id, receipt_key,
      method, currency, exchange_rate, settled_amount, tender_usd, currency_amount, shift_id, settlement_mode)
    VALUES (_inv.user_id, _inv.id, _kind, _operation, _receipt.key, _receipt.method, _receipt.ccy, _receipt.rate,
      _take, _net_usd, _net_original, CASE WHEN _receipt.method = 'cash' AND _mode = 'drawer' THEN _shift END, _mode);
    _allocations := _allocations || jsonb_build_object('method', _receipt.method, 'currency', _receipt.ccy, 'exchange_rate', _receipt.rate,
      'currency_amount', _net_original, 'tender_usd', _net_usd, 'settled_amount', _take);
    _pending := _pending - _take;
  END LOOP;

  IF _drawer > 0 THEN
    UPDATE public.cash_shifts SET expected_balance = round(COALESCE(expected_balance, 0) - _drawer, 8), updated_at = now()
     WHERE id = _shift AND user_id = _inv.user_id AND closed_at IS NULL;
  END IF;

  RETURN jsonb_build_object('cash', _cash, 'digital', _digital, 'drawer', _drawer,
    'drawer_recorded', _drawer_recorded, 'allocations', _allocations);
END;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_partner_debt_profit_atomic(_invoice_id text, _payment_ratio numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        _confirm_amt := round(_item_amt * LEAST(_payment_ratio, 1.0), 8);
        _total_confirmed := _total_confirmed + _confirm_amt;

        -- الاحتفاظ بالمتبقي إن وجد
        IF (_item_amt - _confirm_amt) > 0.01 THEN
          _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_item_amt - _confirm_amt, 8)));
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
        pending_profit = GREATEST(0, round(COALESCE(pending_profit, 0) - _total_confirmed, 8)),
        confirmed_profit = round(COALESCE(confirmed_profit, 0) + _total_confirmed, 8),
        current_balance = round(COALESCE(current_balance, 0) + _total_confirmed, 8),
        total_profit_earned = round(COALESCE(total_profit_earned, 0) + _total_confirmed, 8),
        pending_profit_details = _updated_details,
        profit_history = _updated_history,
        updated_at = now()
      WHERE id = p.id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'invoice_id', _invoice_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_shift_sale_atomic(_shift_id uuid, _operation_id text, _amount_usd numeric, _currency text DEFAULT 'USD'::text, _currency_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT 1, _notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_amount numeric := round(COALESCE(_amount_usd, 0), 4);
  v_ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  v_rate numeric;
  v_orig numeric;
  v_existing public.shift_transactions%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'المستخدم غير مسجل الدخول'; END IF;
  v_owner := public.get_owner_id(v_uid);
  IF v_owner IS NULL THEN RAISE EXCEPTION 'لم يتم العثور على حساب المالك'; END IF;
  IF _operation_id IS NULL OR length(_operation_id) < 8 THEN RAISE EXCEPTION 'رقم العملية غير صالح'; END IF;
  IF v_amount <= 0 OR v_amount::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'مبلغ البيع النقدي يجب أن يكون أكبر من الصفر';
  END IF;
  IF v_ccy = 'USD' THEN
    v_rate := 1; v_orig := round(v_amount, 8);
  ELSE
    v_rate := COALESCE(_exchange_rate, 0);
    IF v_rate <= 0 OR v_rate::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'سعر الصرف غير صالح'; END IF;
    v_orig := round(COALESCE(_currency_amount, v_amount * v_rate), 2);
  END IF;

  -- Same lock order as the other drawer RPCs: shift row first.
  PERFORM 1 FROM public.cash_shifts WHERE id = _shift_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الوردية غير موجودة أو لا تتبع لهذا المتجر'; END IF;

  SELECT * INTO v_existing FROM public.shift_transactions
   WHERE shift_id = _shift_id AND type = 'sale' AND reference_id = _operation_id;
  IF FOUND THEN
    IF abs(v_existing.amount - round(v_amount, 8)) > 0.01 THEN
      RAISE EXCEPTION 'تعارض في معرّف العملية (%): مبلغ مختلف عن الحركة المسجلة', _operation_id USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'amount', v_existing.amount);
  END IF;

  -- A sale can only be posted into an OPEN shift (a closed shift is immutable, F-20).
  PERFORM 1 FROM public.cash_shifts WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'الوردية مغلقة: لا يمكن ترحيل بيع نقدي إليها'; END IF;

  INSERT INTO public.shift_transactions (shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, notes, reference_id)
  VALUES (_shift_id, v_owner, 'sale', round(v_amount, 8), v_ccy, v_orig, v_rate, COALESCE(_notes, 'مبيعات نقدية'), _operation_id);

  UPDATE public.cash_shifts
     SET expected_balance = round(COALESCE(expected_balance, 0) + round(v_amount, 8), 8)
   WHERE id = _shift_id;

  RETURN jsonb_build_object('success', true, 'already_processed', false, 'amount', round(v_amount, 8));
END;
$function$;

CREATE OR REPLACE FUNCTION public.process_pos_sale_atomic(_operation_id text, _payment_type text, _customer_name text, _customer_phone text, _subtotal numeric, _discount numeric, _discount_percentage numeric, _tax_rate numeric, _tax_amount numeric, _total numeric, _profit numeric, _currency text, _warehouse_id uuid, _items jsonb, _down_payment numeric DEFAULT 0, _exchange_rate numeric DEFAULT NULL::numeric, _tax_mode text DEFAULT NULL::text, _sale_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(success boolean, already_processed boolean, invoice_id uuid, invoice_number text, subtotal numeric, discount numeric, tax_amount numeric, total numeric, cogs numeric, profit numeric, debt_paid numeric, debt_remaining numeric, stock_shortage boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _sale_ts timestamptz;
  _inv_date date;
  _inv_time time;
  _owner uuid;
  _existing public.invoices%ROWTYPE;
  _new_invoice public.invoices%ROWTYPE;
  _next bigint;
  _number text;
  _item jsonb;
  _product_id uuid;
  _quantity numeric;
  _available numeric;
  _product_name text;
  _warehouse_name text;
  _track_inventory boolean := true;
  _src uuid;
  _dp numeric := 0;
  _sub numeric;
  _disc numeric;
  _applied_tax_rate numeric := 0;
  _tax numeric;
  _tot numeric;
  _tax_enabled boolean;
  _store_tax_rate numeric;
  _shortage boolean := false;
  _cust uuid;
  _cname text;
  _remaining numeric;
  _cogs numeric;
  _clean_exchange_rate numeric;
  _clean_currency text;
  _inclusive boolean := false;
  _kind text := 'exact';
  _diff numeric := 0;
  _unit text;
  _conv numeric;
  _need numeric;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'Owner context is required';
  END IF;

  IF _operation_id IS NULL OR length(trim(_operation_id)) < 8 OR length(_operation_id) > 128 THEN
    RAISE EXCEPTION 'Invalid operation id';
  END IF;

  IF _payment_type NOT IN ('cash', 'debt') THEN
    RAISE EXCEPTION 'Invalid payment type';
  END IF;

  IF COALESCE(_discount, 0) < 0 OR COALESCE(_down_payment, 0) < 0 THEN
    RAISE EXCEPTION 'Invalid financial values';
  END IF;

  IF _items IS NULL OR jsonb_typeof(_items) <> 'array' OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'Sale items are required';
  END IF;

  _clean_currency := COALESCE(NULLIF(trim(_currency), ''), 'USD');

  IF _clean_currency = 'USD' THEN
    _clean_exchange_rate := COALESCE(_exchange_rate, 1.0);
  ELSE
    IF _exchange_rate IS NOT NULL AND _exchange_rate > 0 THEN
      _clean_exchange_rate := _exchange_rate;
    ELSE
      RAISE EXCEPTION 'Valid exchange rate is required for non-USD currency (%)', _clean_currency;
    END IF;
  END IF;

  -- فحص التكرار (Idempotency)
  SELECT i.* INTO _existing
  FROM public.invoices i
  WHERE i.user_id = _owner AND i.operation_id = trim(_operation_id)
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT
      true, true, _existing.id, _existing.invoice_number, _existing.subtotal,
      _existing.discount, _existing.tax_amount, _existing.total,
      (SELECT COALESCE(SUM(ii.cost_price * ii.quantity), 0) FROM public.invoice_items ii WHERE ii.invoice_id = _existing.id),
      _existing.profit, _existing.debt_paid, _existing.debt_remaining, false;
    RETURN;
  END IF;

  SELECT
    NOT (COALESCE(s.store_type, 'general') IN ('bakery', 'repair', 'restaurant')),
    COALESCE(s.tax_enabled, false),
    COALESCE(s.tax_rate, 0)
  INTO _track_inventory, _tax_enabled, _store_tax_rate
  FROM public.stores s WHERE s.user_id = _owner LIMIT 1;

  _track_inventory := COALESCE(_track_inventory, true);

  IF _warehouse_id IS NOT NULL THEN
    SELECT w.name INTO _warehouse_name
    FROM public.warehouses w
    WHERE w.id = _warehouse_id AND w.user_id = _owner AND COALESCE(w.is_active, true);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Warehouse not found or inactive';
    END IF;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.pos_sale_items(
    product_id uuid PRIMARY KEY,
    product_name text NOT NULL,
    quantity numeric(14,3) NOT NULL,
    unit_price numeric,
    cost_price numeric,
    amount_original numeric,
    amount_usd numeric,
    profit numeric,
    unit text,
    conversion_factor numeric,
    source_warehouse_id uuid
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.pos_sale_items;

  FOR _item IN SELECT value FROM jsonb_array_elements(_items) LOOP
    BEGIN
      _product_id := (_item->>'product_id')::uuid;
      IF (_item->>'quantity') IS NULL OR (_item->>'quantity') !~ '^[0-9]+([.][0-9]+)?$' THEN
        RAISE EXCEPTION 'Invalid item quantity format';
      END IF;
      _quantity := round((_item->>'quantity')::numeric, 3);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Invalid sale item structure';
    END;

    IF _product_id IS NULL OR _quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid item quantity';
    END IF;

    IF COALESCE(NULLIF(_item->>'unit_price','')::numeric, 0) < 0 OR COALESCE(NULLIF(_item->>'amount_usd','')::numeric, 0) < 0 THEN
      RAISE EXCEPTION 'Invalid item price';
    END IF;

    INSERT INTO pg_temp.pos_sale_items(product_id, product_name, quantity, unit_price, cost_price, amount_original, amount_usd, profit, unit, conversion_factor, source_warehouse_id)
    VALUES (
      _product_id,
      COALESCE(NULLIF(_item->>'product_name', ''), 'Product'),
      _quantity,
      round(COALESCE(NULLIF(_item->>'unit_price', '')::numeric, 0), 8),
      0,
      round(COALESCE(NULLIF(_item->>'amount_original', '')::numeric, 0), 8),
      round(COALESCE(NULLIF(_item->>'amount_usd', '')::numeric, 0), 8),
      0,
      COALESCE(NULLIF(_item->>'unit', ''), 'piece'),
      GREATEST(COALESCE(NULLIF(_item->>'conversion_factor', '')::numeric, 1), 1),
      NULL
    )
    ON CONFLICT(product_id) DO UPDATE SET
      quantity = CASE WHEN pg_temp.pos_sale_items.unit = EXCLUDED.unit AND pg_temp.pos_sale_items.conversion_factor = EXCLUDED.conversion_factor THEN pg_temp.pos_sale_items.quantity + EXCLUDED.quantity ELSE (CASE WHEN pg_temp.pos_sale_items.unit = 'bulk' THEN pg_temp.pos_sale_items.quantity * pg_temp.pos_sale_items.conversion_factor ELSE pg_temp.pos_sale_items.quantity END) + (CASE WHEN EXCLUDED.unit = 'bulk' THEN EXCLUDED.quantity * EXCLUDED.conversion_factor ELSE EXCLUDED.quantity END) END, /* mixed_unit_merge */
      unit_price = CASE WHEN pg_temp.pos_sale_items.unit = EXCLUDED.unit AND pg_temp.pos_sale_items.conversion_factor = EXCLUDED.conversion_factor THEN pg_temp.pos_sale_items.unit_price ELSE round((pg_temp.pos_sale_items.amount_usd + EXCLUDED.amount_usd) / NULLIF((CASE WHEN pg_temp.pos_sale_items.unit = 'bulk' THEN pg_temp.pos_sale_items.quantity * pg_temp.pos_sale_items.conversion_factor ELSE pg_temp.pos_sale_items.quantity END) + (CASE WHEN EXCLUDED.unit = 'bulk' THEN EXCLUDED.quantity * EXCLUDED.conversion_factor ELSE EXCLUDED.quantity END), 0), 8) END,
      unit = CASE WHEN pg_temp.pos_sale_items.unit = EXCLUDED.unit AND pg_temp.pos_sale_items.conversion_factor = EXCLUDED.conversion_factor THEN pg_temp.pos_sale_items.unit ELSE 'piece' END,
      conversion_factor = CASE WHEN pg_temp.pos_sale_items.unit = EXCLUDED.unit AND pg_temp.pos_sale_items.conversion_factor = EXCLUDED.conversion_factor THEN pg_temp.pos_sale_items.conversion_factor ELSE 1 END,
      amount_original = pg_temp.pos_sale_items.amount_original + EXCLUDED.amount_original,
      amount_usd = pg_temp.pos_sale_items.amount_usd + EXCLUDED.amount_usd;
  END LOOP;

  -- فحص المخزون والكرتونة
  FOR _product_id, _product_name, _quantity, _unit, _conv IN SELECT psi.product_id, psi.product_name, psi.quantity, psi.unit, psi.conversion_factor FROM pg_temp.pos_sale_items psi LOOP
    PERFORM 1 FROM public.products p
    WHERE p.id = _product_id AND p.user_id = _owner AND COALESCE(p.archived, false) = false;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or archived (%)', _product_id;
    END IF;

    IF NOT _track_inventory THEN CONTINUE; END IF;

    _src := NULL;
    _available := NULL;

    IF _warehouse_id IS NOT NULL THEN
      SELECT ws.quantity INTO _available
      FROM public.warehouse_stock ws
      WHERE ws.warehouse_id = _warehouse_id AND ws.product_id = _product_id FOR UPDATE;
      IF FOUND THEN _src := _warehouse_id; END IF;
    END IF;

    IF _src IS NULL THEN
      SELECT p.quantity INTO _available
      FROM public.products p
      WHERE p.id = _product_id AND p.user_id = _owner FOR UPDATE;
    END IF;

    -- ضرب الكرتونة في معامل التحويل
    _need := CASE WHEN _unit = 'bulk' THEN _quantity * GREATEST(COALESCE(_conv, 1), 1) ELSE _quantity END;
    IF COALESCE(_available, 0) < _need THEN
      -- F-11: stock never goes below zero unless the owner's allow-negative setting is on
      IF NOT COALESCE((SELECT st.allow_negative_stock FROM public.stores st WHERE st.user_id = _owner ORDER BY st.created_at LIMIT 1), false) THEN
        RAISE EXCEPTION 'الكمية المطلوبة أكبر من المخزون المتاح للمنتج %', _product_name;
      END IF;
      _shortage := true;
    END IF;

    UPDATE pg_temp.pos_sale_items SET source_warehouse_id = _src WHERE product_id = _product_id;
  END LOOP;

  SELECT round(COALESCE(SUM(amount_usd), 0), 8) INTO _sub FROM pg_temp.pos_sale_items;
  _disc := round(LEAST(GREATEST(COALESCE(_discount, 0), 0), _sub), 8);

  IF _tax_enabled THEN
    _applied_tax_rate := LEAST(GREATEST(COALESCE(_store_tax_rate, 0), 0), 100);
  ELSE
    _applied_tax_rate := 0;
  END IF;

  -- معالجة الضريبة الشاملة
  _inclusive := _applied_tax_rate > 0 AND (
    lower(COALESCE(_tax_mode, '')) IN ('inclusive', 'gross')
    OR (COALESCE(_tax_mode, '') = '' AND _total IS NOT NULL
        AND abs(_total - (COALESCE(_subtotal, _sub) - COALESCE(_discount, 0))) <= 0.0001)
  );
  IF _inclusive THEN
    _tax := round((_sub - _disc) * _applied_tax_rate / (100 + _applied_tax_rate), 8);
    _tot := round(_sub - _disc, 8);
  ELSE
    _tax := round((_sub - _disc) * _applied_tax_rate / 100, 8);
    _tot := round(_sub - _disc + _tax, 8);
  END IF;

  _dp := round(COALESCE(_down_payment, 0), 8);
  IF _payment_type <> 'debt' THEN _dp := 0; END IF;
  _dp := LEAST(_dp, _tot);
  _remaining := CASE WHEN _payment_type = 'debt' THEN round(_tot - _dp, 8) ELSE 0 END;

  IF _remaining > 0 THEN _kind := 'debt'; _diff := _remaining;
  ELSIF _disc > 0 THEN _kind := 'discount'; _diff := _disc;
  END IF;

  _cname := NULLIF(trim(_customer_name), '');
  IF _cname IS NOT NULL AND _cname NOT IN ('عميل نقدي', 'عميل بيع مؤجل') THEN
    SELECT c.id INTO _cust
    FROM public.customers c
    WHERE c.user_id = _owner AND lower(trim(c.name)) = lower(_cname)
    ORDER BY c.created_at LIMIT 1 FOR UPDATE;

    IF _cust IS NULL THEN
      INSERT INTO public.customers(user_id, name, phone, cashier_id)
      VALUES(_owner, _cname, NULLIF(trim(_customer_phone), ''), _caller)
      RETURNING id INTO _cust;
    END IF;
  END IF;

  -- Sale time (2026-11-24): a queued offline sale keeps the time it was made, never later than now.
  -- If that day falls inside a closed accounting period, the sale takes its real posting time instead.
  _sale_ts := LEAST(COALESCE(_sale_at, now()), now());
  IF EXISTS (SELECT 1 FROM public.accounting_period_closures c WHERE c.user_id = _owner
             AND (_sale_ts AT TIME ZONE 'UTC')::date BETWEEN c.period_start AND c.period_end) THEN
    _sale_ts := now();
  END IF;
  _inv_date := (_sale_ts AT TIME ZONE 'UTC')::date;
  _inv_time := (_sale_ts AT TIME ZONE 'UTC')::time;

  _next := public.get_next_invoice_number(_owner);
  PERFORM public.assert_period_open(_owner, _inv_date, 'إنشاء فاتورة بيع');
  _number := to_char(_inv_date, 'YYYYMMDD') || '-' || lpad(_next::text, 5, '0');

  INSERT INTO public.invoices(
    user_id, invoice_number, invoice_sequence, operation_id, invoice_type,
    date, time, cashier_id, cashier_name, customer_id, customer_name, customer_phone,
    subtotal, discount, discount_percentage, tax_rate, tax_amount, total, profit,
    currency, exchange_rate, payment_type, status, debt_paid, debt_remaining, warehouse_id,
    tax_inclusive, settlement_kind, settlement_diff_usd, created_at
  )
  SELECT
    _owner, _number, _next, trim(_operation_id), 'sale',
    _inv_date, _inv_time, _caller::text, p.full_name, _cust, _cname, NULLIF(trim(_customer_phone), ''),
    _sub, _disc, COALESCE(_discount_percentage, 0), _applied_tax_rate, _tax, _tot, 0,
    _clean_currency, _clean_exchange_rate, _payment_type,
    CASE WHEN _remaining > 0 THEN 'pending' ELSE 'paid' END,
    CASE WHEN _payment_type = 'debt' THEN _dp ELSE 0 END,
    _remaining, _warehouse_id,
    _inclusive, _kind, _diff, _sale_ts
  FROM (SELECT 1) seed
  LEFT JOIN public.profiles p ON p.user_id = _caller
  LIMIT 1
  RETURNING * INTO _new_invoice;

  INSERT INTO public.invoice_items(
    invoice_id, product_id, product_name, quantity, unit_price, cost_price,
    currency, amount_original, amount_usd, profit, unit, conversion_factor, stock_warehouse_id,
    category_snapshot
  )
  SELECT
    _new_invoice.id, psi.product_id, psi.product_name, psi.quantity, psi.unit_price,
    0, _clean_currency, psi.amount_original, psi.amount_usd, 0, psi.unit, psi.conversion_factor,
    CASE WHEN _track_inventory THEN psi.source_warehouse_id ELSE NULL END,
    NULLIF(trim(p.category), '')
  FROM pg_temp.pos_sale_items psi
  LEFT JOIN public.products p ON p.id = psi.product_id AND p.user_id = _owner;

  DECLARE _sv record; _ser text[]; _cnt int;
  BEGIN
    FOR _sv IN SELECT psi.product_id, (psi.quantity * CASE WHEN psi.unit = 'bulk' THEN GREATEST(COALESCE(psi.conversion_factor,1),1) ELSE 1 END) AS quantity, p.name, COALESCE(p.warranty_months,0) AS wm FROM pg_temp.pos_sale_items psi JOIN public.products p ON p.id=psi.product_id WHERE p.track_serials LOOP
      SELECT COALESCE(array_agg(x),'{}'::text[]) INTO _ser FROM jsonb_array_elements(_items) it, LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(it.value->'serials')='array' THEN it.value->'serials' ELSE '[]'::jsonb END) x WHERE (it.value->>'product_id')::uuid=_sv.product_id;
      IF cardinality(_ser) <> _sv.quantity OR cardinality(_ser) <> (SELECT count(DISTINCT lower(trim(y))) FROM unnest(_ser) y) THEN RAISE EXCEPTION 'المنتج % يتطلب اختيار % رقم تسلسلي مختلف', _sv.name, _sv.quantity; END IF;
      UPDATE public.product_serials ps SET status='sold', sold_invoice_id=_new_invoice.id, sold_invoice_number=_new_invoice.invoice_number, sold_at=now(), customer_name=_cname, warranty_until=CASE WHEN _sv.wm>0 THEN (CURRENT_DATE + (_sv.wm||' months')::interval)::date END, updated_at=now() WHERE ps.user_id=_owner AND ps.product_id=_sv.product_id AND ps.status='in_stock' AND lower(ps.serial)=ANY(SELECT lower(trim(y)) FROM unnest(_ser) y);
      GET DIAGNOSTICS _cnt = ROW_COUNT;
      IF _cnt <> cardinality(_ser) THEN RAISE EXCEPTION 'رقم تسلسلي غير متوفر في المخزون للمنتج %', _sv.name; END IF;
      INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) SELECT _owner, ps.id, 'sold', _new_invoice.invoice_number, _caller FROM public.product_serials ps WHERE ps.sold_invoice_id=_new_invoice.id AND ps.product_id=_sv.product_id;
    END LOOP;
  END;

  -- 1) حساب الأرباح آلياً بدقة 8 منازل واستبعاد الضريبة
  PERFORM public.recalc_pos_invoice_profit(_new_invoice.id);

  -- 2) ✅ توزيع أرباح الشركاء ذرياً في نفس المعاملة
  PERFORM public.distribute_invoice_partner_profits_atomic(_new_invoice.id);

  IF _track_inventory THEN
    PERFORM set_config('app.stock_movement_type', 'sale', true);
    PERFORM set_config('app.stock_invoice_id', _new_invoice.id::text, true);
    PERFORM set_config('app.stock_invoice_number', _new_invoice.invoice_number, true);
    PERFORM set_config('app.stock_actor_id', _caller::text, true);
    PERFORM set_config('app.stock_source', 'atomic_pos_sale', true);

    UPDATE public.warehouse_stock ws
    SET quantity = ws.quantity - (CASE WHEN psi.unit = 'bulk' THEN psi.quantity * GREATEST(COALESCE(psi.conversion_factor, 1), 1) ELSE psi.quantity END), last_updated = now()
    FROM pg_temp.pos_sale_items psi
    WHERE psi.source_warehouse_id IS NOT NULL
      AND ws.warehouse_id = psi.source_warehouse_id
      AND ws.product_id = psi.product_id;

    UPDATE public.products p
    SET quantity = COALESCE(p.quantity, 0) - (CASE WHEN psi.unit = 'bulk' THEN psi.quantity * GREATEST(COALESCE(psi.conversion_factor, 1), 1) ELSE psi.quantity END), updated_at = now()
    FROM pg_temp.pos_sale_items psi
    WHERE psi.source_warehouse_id IS NULL
      AND p.id = psi.product_id
      AND p.user_id = _owner;
  END IF;

  IF _remaining > 0 AND _cust IS NOT NULL THEN
    DECLARE _lim numeric; _open numeric;
    BEGIN
      SELECT c.credit_limit, COALESCE(c.total_debt,0) INTO _lim, _open FROM public.customers c WHERE c.id=_cust;
      IF _lim IS NOT NULL AND _open + _remaining > _lim + 0.0001 THEN
        RAISE EXCEPTION 'تجاوز حد الائتمان للعميل: الحد %، الدين الحالي %، المطلوب %', round(_lim,2), round(_open,2), round(_remaining,2);
      END IF;
    END;
  END IF;

  IF _remaining > 0 THEN
    INSERT INTO public.debts(
      user_id, invoice_id, customer_id, customer_name, customer_phone, total_debt,
      total_paid, remaining_debt, due_date, status, is_cash_debt, cashier_id
    )
    VALUES(
      _owner, _new_invoice.invoice_number, _cust, COALESCE(_cname, 'عميل بيع مؤجل'),
      NULLIF(trim(_customer_phone), ''), _tot, _dp, _remaining,
      CURRENT_DATE + 30, CASE WHEN _dp > 0 THEN 'partial' ELSE 'due' END, false, _caller
    );
  END IF;

  IF _cust IS NOT NULL THEN
    UPDATE public.customers c SET
      total_purchases = round(COALESCE(c.total_purchases, 0) + _tot, 8),
      total_debt = round(COALESCE(c.total_debt, 0) + _remaining, 8),
      invoice_count = COALESCE(c.invoice_count, 0) + 1,
      last_purchase = now(),
      updated_at = now()
    WHERE c.id = _cust;
  END IF;

  SELECT i.* INTO _new_invoice FROM public.invoices i WHERE i.id = _new_invoice.id;
  SELECT COALESCE(SUM(ii.cost_price * ii.quantity), 0) INTO _cogs FROM public.invoice_items ii WHERE ii.invoice_id = _new_invoice.id;

  RETURN QUERY SELECT
    true, false, _new_invoice.id, _new_invoice.invoice_number, _sub, _disc, _tax, _tot,
    round(_cogs, 8), _new_invoice.profit, _new_invoice.debt_paid, _new_invoice.debt_remaining, _shortage;

EXCEPTION WHEN unique_violation THEN
  SELECT i.* INTO _existing
  FROM public.invoices i
  WHERE i.user_id = _owner AND i.operation_id = trim(_operation_id)
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT
      true, true, _existing.id, _existing.invoice_number, _existing.subtotal,
      _existing.discount, _existing.tax_amount, _existing.total, 0::numeric,
      _existing.profit, _existing.debt_paid, _existing.debt_remaining, false;
    RETURN;
  END IF;

  RAISE;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 3. Fix public._supplier_drawer_tx (strict shift validation, no auto-fallback)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._supplier_drawer_tx(
  _owner uuid,
  _shift uuid,
  _type text,
  _amount numeric,
  _ccy text,
  _ccy_amount numeric,
  _rate numeric,
  _ref text,
  _note text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _inserted int := 0;
  _delta numeric := 0;
BEGIN
  IF _shift IS NULL THEN
    RAISE EXCEPTION 'يجب تحديد وردية مفتوحة صالحة لتسجيل حركة صندوق المورد';
  END IF;

  PERFORM 1
    FROM public.cash_shifts
   WHERE id = _shift
     AND user_id = _owner
     AND closed_at IS NULL
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'الوردية المحددة غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
  END IF;

  INSERT INTO public.shift_transactions(
    shift_id, user_id, type, amount, reference_id, notes, currency, currency_amount, exchange_rate
  )
  VALUES (
    _shift, _owner, _type, round(_amount, 4), _ref, _note,
    COALESCE(_ccy, 'USD'), COALESCE(_ccy_amount, _amount), _rate
  )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS _inserted = ROW_COUNT;
  IF _inserted > 0 THEN
    _delta := CASE WHEN _type = 'supplier_refund' THEN round(_amount, 4) ELSE -round(_amount, 4) END;
    UPDATE public.cash_shifts
       SET expected_balance = round(COALESCE(expected_balance, 0) + _delta, 8),
           updated_at = now()
     WHERE id = _shift AND user_id = _owner AND closed_at IS NULL;
  END IF;
END;
$function$;
