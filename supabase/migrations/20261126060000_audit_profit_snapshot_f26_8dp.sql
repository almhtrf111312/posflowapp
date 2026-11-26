-- Accounting audit follow-up (external Gemini report, verified 2026-11-26; owner: "صلحها").
-- 1) F-25 / D-12: the sale-time profit snapshot (profit_records) was written by the client with a direct insert, rounded to 2 decimals,
--    and for a credit sale it stored only the down-payment share of the profit, while D-12 reads it as the invoice's ORIGINAL profit.
--    New RPC record_sale_profit_snapshot writes it on the server from the invoice itself: full profit, 8 decimals, once per invoice.
-- 2) F-26: record_debt_payment_atomic absorbed a settlement rounding difference only up to 0.005 USD; the law says 0.05 (noted in
--    rounding_adjustment). The client used to trim the difference silently instead.
-- 3) F-02: USD amounts still rounded to 4 (or 2) decimals inside these functions now keep 8. Original-currency sanity checks that compare
--    a foreign amount at 2 decimals, and the counted cash of a shift close, keep their precision on purpose.

CREATE OR REPLACE FUNCTION public.record_sale_profit_snapshot(_invoice_number text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _owner uuid := public.get_owner_id(auth.uid());
  _inv public.invoices%ROWTYPE;
  _cogs numeric;
BEGIN
  IF auth.uid() IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  SELECT * INTO _inv FROM public.invoices WHERE user_id = _owner AND invoice_number = _invoice_number LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'الفاتورة غير موجودة'; END IF;
  -- One snapshot per invoice: a replay, or a refund that already wrote its row, changes nothing.
  IF EXISTS (SELECT 1 FROM public.profit_records WHERE user_id = _owner AND invoice_id = _invoice_number) THEN RETURN false; END IF;
  IF COALESCE(_inv.status, '') IN ('refunded', 'cancelled') THEN RETURN false; END IF;
  SELECT COALESCE(SUM(COALESCE(cost_price, 0) * COALESCE(quantity, 0)), 0) INTO _cogs FROM public.invoice_items WHERE invoice_id = _inv.id;
  INSERT INTO public.profit_records(user_id, invoice_id, gross_profit, cogs, revenue, currency, recorded_at)
  VALUES (_owner, _invoice_number, round(COALESCE(_inv.profit, 0), 8), round(_cogs, 8),
          round(COALESCE(_inv.total, 0) - COALESCE(_inv.tax_amount, 0), 8), 'USD', COALESCE(_inv.created_at, now()));
  RETURN true;
END $function$;
GRANT EXECUTE ON FUNCTION public.record_sale_profit_snapshot(text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.record_sale_profit_snapshot(text) FROM anon;

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
  v_amount numeric := round(COALESCE(_amount, 0)::numeric, 8);
  v_cash_amount numeric := round(COALESCE(_amount, 0)::numeric, 8);
  v_settlement numeric;
  v_rounding_adjustment numeric := 0;
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
  v_fx_difference numeric := 0;
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
  v_credit := CASE WHEN v_fx_credit_rate IS NOT NULL THEN round(_currency_amount / v_fx_credit_rate, 8) ELSE v_amount END;

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

  v_prev_remaining := round(COALESCE(v_debt.remaining_debt, v_debt.total_debt - COALESCE(v_debt.total_paid, 0))::numeric, 8);

  IF v_credit > v_prev_remaining + 0.05 THEN
    RAISE EXCEPTION 'المبلغ المدخل (%) أكبر من المتبقي (%)', v_credit, v_prev_remaining;
  END IF;

  -- Separate cash tendered from debt settlement (snapping within 0.05 USD, F-26; the difference is kept in rounding_adjustment)
  IF abs(v_prev_remaining - v_credit) <= 0.05 THEN
    v_settlement := v_prev_remaining;
    v_new_remaining := 0;
    v_new_total_paid := v_debt.total_debt;
    v_rounding_adjustment := round(v_settlement - v_cash_amount, 8);
    IF abs(v_rounding_adjustment) > 0 THEN
      v_rounding_note := ' (تعديل تقريب: ' || v_rounding_adjustment::text || ' USD)';
    END IF;
  ELSE
    v_settlement := v_credit;
    v_rounding_adjustment := round(v_settlement - v_cash_amount, 8);
    v_new_remaining := GREATEST(round(v_prev_remaining - v_credit, 8), 0);
    v_new_total_paid := round(COALESCE(v_debt.total_paid, 0) + v_credit, 8);
  END IF;

  IF v_fx_credit_rate IS NOT NULL THEN
    v_fx_difference := round(v_cash_amount - v_settlement, 8);   -- > 0 gain, < 0 loss
    v_rounding_adjustment := 0;
    v_rounding_note := CASE WHEN v_fx_difference <> 0 THEN ' (فرق صرف: ' || v_fx_difference::text || ' USD)' ELSE '' END;
  END IF;

  v_tx_currency := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  v_tx_exchange_rate := CASE WHEN v_tx_currency = 'USD' THEN 1 ELSE _exchange_rate END;
  IF COALESCE(v_tx_exchange_rate, 0) <= 0 THEN RAISE EXCEPTION 'سعر صرف الدفعة غير صالح'; END IF;
  v_tx_currency_amount := COALESCE(round(_currency_amount, 8), round(v_cash_amount * v_tx_exchange_rate, 8));
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
              _confirm_amt := round(_item_amt * v_installment_ratio, 8);
              IF abs(_item_amt - _confirm_amt) > 0.0001 THEN
                _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_item_amt - _confirm_amt, 8)));
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
             SET pending_profit = round((SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(_updated_details) x), 8),
                 confirmed_profit = round(COALESCE(confirmed_profit, 0) + _total_confirmed, 8),
                 current_balance = round(COALESCE(current_balance, 0) + _total_confirmed, 8),
                 total_profit_earned = round(COALESCE(total_profit_earned, 0) + _total_confirmed, 8),
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
$function$
;

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
    _orig_amt := COALESCE(NULLIF(_original_amount, 0), round(_amt * _orig_rate, 8));
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
    _part := round(_amt * _pct / 100, 8);
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
          current_balance = round(coalesce(current_balance, 0) - _part, 8),
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
    _part := round(_remaining_amt * (_pct_before + _pct) / 100, 8)
           - round(_remaining_amt * _pct_before / 100, 8);
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
          current_balance = round(coalesce(current_balance, 0) - _part, 8),
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
$function$
;

CREATE OR REPLACE FUNCTION public.distribute_invoice_partner_profits_atomic(_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE;
  _owner uuid;
  _is_debt boolean;
  _cat_profit record;
  _remaining_profit numeric;
  _partner record;
  _partner_share numeric;
  _cat_share jsonb;
  _pct numeric;
  _eff_pct numeric;
  _cat_pct_used numeric;
  _all_pct_used numeric;
  _profit_record jsonb;
  _pending_detail jsonb;
  _total_distributed numeric := 0;
  _distributions jsonb := '[]'::jsonb;
BEGIN
  PERFORM set_config('app.partner_source', 'distribute_invoice_partner_profits_atomic', true);

  -- Lock invoice row BEFORE advisory lock to avoid AB/BA deadlocks with callers holding invoice row lock
  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  -- Serialize concurrent distribution calls for the same invoice BEFORE already_processed check
  PERFORM pg_advisory_xact_lock(hashtext('partner_dist:' || _invoice_id::text));

  _owner := _inv.user_id;

  IF auth.uid() IS NOT NULL AND public.get_owner_id(auth.uid()) IS DISTINCT FROM _owner THEN
    RAISE EXCEPTION 'غير مصرح' USING ERRCODE = '42501';
  END IF;
  _is_debt := (_inv.payment_type = 'debt' AND COALESCE(_inv.debt_remaining, 0) > 0);

  IF EXISTS (
    SELECT 1 FROM public.partners p,
    jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb)) ph
    WHERE p.user_id = _owner AND ph->>'invoiceId' = _inv.invoice_number
  ) THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'invoice_number', _inv.invoice_number);
  END IF;

  IF COALESCE(_inv.created_at, now()) < now() - interval '1 hour' THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'invoice_number', _inv.invoice_number, 'skipped', 'stale_invoice');
  END IF;

  FOR _cat_profit IN
    SELECT
      COALESCE(NULLIF(trim(ii.category_snapshot), ''), NULLIF(trim(p.category), ''), 'عام') AS category_name,
      round(SUM(COALESCE(ii.profit, 0)), 8) AS total_category_profit
    FROM public.invoice_items ii
    LEFT JOIN public.products p ON p.id = ii.product_id AND p.user_id = _owner
    WHERE ii.invoice_id = _invoice_id
    GROUP BY COALESCE(NULLIF(trim(ii.category_snapshot), ''), NULLIF(trim(p.category), ''), 'عام')
    HAVING SUM(COALESCE(ii.profit, 0)) <> 0
  LOOP
    _remaining_profit := _cat_profit.total_category_profit;
    _cat_pct_used := 0;

    FOR _partner IN
      SELECT * FROM public.partners
      WHERE user_id = _owner
        AND COALESCE(access_all, false) = false
        AND category_shares IS NOT NULL
      ORDER BY id
      FOR UPDATE
    LOOP
      SELECT cs INTO _cat_share
      FROM jsonb_array_elements(_partner.category_shares) cs
      WHERE (cs->>'enabled')::boolean = true
        AND trim(COALESCE(cs->>'categoryName', '')) = _cat_profit.category_name
      LIMIT 1;

      IF _cat_share IS NOT NULL AND COALESCE((_cat_share->>'percentage')::numeric, 0) > 0 THEN
        _pct := (_cat_share->>'percentage')::numeric;
        -- Defense-in-depth: cap cumulative category share percentage at 100%
        _eff_pct := LEAST(_pct, GREATEST(100.0 - _cat_pct_used, 0.0));
        IF _eff_pct <= 0 THEN
          CONTINUE;
        END IF;
        _cat_pct_used := _cat_pct_used + _eff_pct;
        _partner_share := round((_cat_profit.total_category_profit * _eff_pct / 100.0), 8);

        IF _partner_share <> 0 THEN
          _remaining_profit := _remaining_profit - _partner_share;
          _total_distributed := _total_distributed + _partner_share;

          _profit_record := jsonb_build_object(
            'id', extract(epoch from now())::text || _partner.id::text || _cat_profit.category_name,
            'invoiceId', _inv.invoice_number,
            'amount', _partner_share,
            'category', _cat_profit.category_name,
            'isDebt', _is_debt,
            'createdAt', now()
          );

          IF _is_debt THEN
            _pending_detail := jsonb_build_object(
              'invoiceId', _inv.invoice_number,
              'amount', _partner_share,
              'customerName', COALESCE(_inv.customer_name, 'عميل بيع مؤجل'),
              'createdAt', now()
            );

            UPDATE public.partners SET
              pending_profit = round(COALESCE(pending_profit, 0) + _partner_share, 8),
              pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || _pending_detail,
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          ELSE
            UPDATE public.partners SET
              confirmed_profit = round(COALESCE(confirmed_profit, 0) + _partner_share, 8),
              current_balance = round(COALESCE(current_balance, 0) + _partner_share, 8),
              total_profit_earned = round(COALESCE(total_profit_earned, 0) + _partner_share, 8),
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          END IF;

          _distributions := _distributions || jsonb_build_object(
            'partnerId', _partner.id,
            'partnerName', _partner.name,
            'amount', _partner_share,
            'category', _cat_profit.category_name
          );
        END IF;
      END IF;
    END LOOP;

    -- Same-sign guard: never debit a fake loss (or credit fake profit) if category shares reached 100%
    IF (_cat_profit.total_category_profit > 0 AND _remaining_profit > 0)
       OR (_cat_profit.total_category_profit < 0 AND _remaining_profit < 0) THEN
      _all_pct_used := 0;
      FOR _partner IN
        SELECT * FROM public.partners
        WHERE user_id = _owner
          AND COALESCE(access_all, false) = true
          AND COALESCE(share_percentage, 0) > 0
        ORDER BY id
        FOR UPDATE
      LOOP
        _eff_pct := LEAST(_partner.share_percentage, GREATEST(100.0 - _all_pct_used, 0.0));
        IF _eff_pct <= 0 THEN
          CONTINUE;
        END IF;
        _all_pct_used := _all_pct_used + _eff_pct;
        _partner_share := round((_remaining_profit * _eff_pct / 100.0), 8);

        IF _partner_share <> 0 THEN
          _total_distributed := _total_distributed + _partner_share;

          _profit_record := jsonb_build_object(
            'id', extract(epoch from now())::text || _partner.id::text || _cat_profit.category_name,
            'invoiceId', _inv.invoice_number,
            'amount', _partner_share,
            'category', _cat_profit.category_name,
            'isDebt', _is_debt,
            'createdAt', now()
          );

          IF _is_debt THEN
            _pending_detail := jsonb_build_object(
              'invoiceId', _inv.invoice_number,
              'amount', _partner_share,
              'customerName', COALESCE(_inv.customer_name, 'عميل بيع مؤجل'),
              'createdAt', now()
            );

            UPDATE public.partners SET
              pending_profit = round(COALESCE(pending_profit, 0) + _partner_share, 8),
              pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || _pending_detail,
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          ELSE
            UPDATE public.partners SET
              confirmed_profit = round(COALESCE(confirmed_profit, 0) + _partner_share, 8),
              current_balance = round(COALESCE(current_balance, 0) + _partner_share, 8),
              total_profit_earned = round(COALESCE(total_profit_earned, 0) + _partner_share, 8),
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          END IF;

          _distributions := _distributions || jsonb_build_object(
            'partnerId', _partner.id,
            'partnerName', _partner.name,
            'amount', _partner_share,
            'category', _cat_profit.category_name
          );
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', _invoice_id,
    'total_distributed', _total_distributed,
    'distributions', _distributions
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.edit_purchase_invoice_atomic(_invoice_id uuid, _new_lines jsonb, _op_id text, _reason text DEFAULT 'Purchase invoice edit'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _orig_inv record;
  _existing_id uuid;
  _new_invoice_id uuid;
  _old_item record;
  _line jsonb;
  _prod_id uuid;
  _prod_qty numeric;
  _prod_cost numeric;
  _prod_name text;
  _prod_barcode text;
  _prod_cat text;
  _cur_stock numeric;
  _cur_cost numeric;
  _new_stock numeric;
  _new_cost numeric;
  _calc_cost numeric;
  _rem_val numeric;
  v_variance numeric := 0;
  _no_inventory boolean := false;
  _has_subsequent_sale boolean := false;
  _has_newer_purchase boolean := false;
  _items_count int := 0;
  _total_qty numeric := 0;
  _grand_total numeric := 0;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'owner not found';
  END IF;

  SELECT id INTO _existing_id
    FROM public.purchase_invoices
   WHERE operation_id = _op_id AND user_id = _owner;
  IF _existing_id IS NOT NULL THEN
    RETURN _existing_id;
  END IF;

  IF _new_lines IS NULL OR jsonb_typeof(_new_lines) <> 'array' OR jsonb_array_length(_new_lines) = 0 THEN
    RAISE EXCEPTION 'لا توجد بنود صالحة لتعديل الفاتورة';
  END IF;

  SELECT * INTO _orig_inv
    FROM public.purchase_invoices
   WHERE id = _invoice_id AND user_id = _owner
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original invoice not found';
  END IF;

  IF COALESCE(_orig_inv.status, '') = 'cancelled'
     OR COALESCE(_orig_inv.payment_status, '') = 'cancelled'
     OR _orig_inv.replaced_by IS NOT NULL THEN
    RAISE EXCEPTION 'الفاتورة ملغاة أو سبق استبدالها';
  END IF;

  -- Guard upfront before any mutation
  IF EXISTS (SELECT 1 FROM public.purchase_returns WHERE invoice_id = _invoice_id) THEN
    RAISE EXCEPTION 'لا يمكن تعديل فاتورة لها مرتجعات';
  END IF;

  PERFORM public.assert_period_open(_owner, _orig_inv.invoice_date::date, 'تعديل فاتورة الشراء');

  -- --------------------------------------------------------------------------
  -- Path A: Draft / Reconciled — edit invoice items & header totals ONLY
  --         (never touch inventory, cost_price, serials, or supplier ledger)
  -- --------------------------------------------------------------------------
  IF COALESCE(_orig_inv.status, 'draft') IN ('draft', 'reconciled') THEN
    DELETE FROM public.purchase_invoice_items
     WHERE invoice_id = _invoice_id;

    FOR _line IN SELECT * FROM jsonb_array_elements(_new_lines) LOOP
      _prod_id := NULLIF(_line->>'product_id', '')::uuid;
      _prod_qty := GREATEST(0, COALESCE((_line->>'quantity')::numeric, 0));
      _prod_cost := GREATEST(0, COALESCE((_line->>'cost_price')::numeric, 0));
      _prod_name := COALESCE(NULLIF(trim(_line->>'product_name'), ''), 'صنف');
      _prod_barcode := NULLIF(trim(_line->>'barcode'), '');
      _prod_cat := NULLIF(trim(_line->>'category'), '');

      INSERT INTO public.purchase_invoice_items(
        invoice_id, product_id, product_name, barcode, category,
        quantity, cost_price, sale_price, total_cost, serials
      )
      VALUES (
        _invoice_id,
        _prod_id,
        _prod_name,
        _prod_barcode,
        _prod_cat,
        _prod_qty,
        _prod_cost,
        NULLIF(_line->>'sale_price', '')::numeric,
        round(_prod_qty * _prod_cost, 8),
        CASE
          WHEN jsonb_typeof(_line->'serials') = 'array' THEN
            ARRAY(SELECT trim(x) FROM jsonb_array_elements_text(_line->'serials') x WHERE trim(x) <> '')
          ELSE NULL
        END
      );

      _items_count := _items_count + 1;
      _total_qty := _total_qty + _prod_qty;
      _grand_total := _grand_total + round(_prod_qty * _prod_cost, 8);
    END LOOP;

    UPDATE public.purchase_invoices
       SET actual_items_count = _items_count,
           actual_total_quantity = _total_qty,
           actual_grand_total = round(_grand_total, 8),
           expected_items_count = _items_count,
           expected_total_quantity = _total_qty,
           expected_grand_total = round(_grand_total, 8),
           operation_id = _op_id,
           edit_reason = _reason,
           updated_at = now()
     WHERE id = _invoice_id;

    RETURN _invoice_id;
  END IF;

  -- --------------------------------------------------------------------------
  -- Path B: Finalized / Completed — controlled reversal & replacement
  -- --------------------------------------------------------------------------
  IF COALESCE(_orig_inv.status, 'draft') NOT IN ('finalized', 'completed') THEN
    RAISE EXCEPTION 'لا يمكن تعديل فاتورة شراء بحالة %', _orig_inv.status;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.product_serials
     WHERE purchase_invoice_id = _invoice_id
       AND user_id = _owner
       AND status <> 'in_stock'
  ) THEN
    RAISE EXCEPTION 'لا يمكن تعديل الفاتورة: بعض أرقامها التسلسلية بيعت أو أُخرجت';
  END IF;

  SELECT COALESCE(s.store_type, 'general') IN ('bakery', 'repair')
    INTO _no_inventory
    FROM public.stores s
   WHERE s.user_id = _owner
   LIMIT 1;
  _no_inventory := COALESCE(_no_inventory, false);

  PERFORM set_config('app.stock_movement_type', 'purchase_edit', true);
  PERFORM set_config('app.stock_actor_id', _caller::text, true);
  PERFORM set_config('app.stock_source', 'edit_purchase_invoice_atomic', true);

  FOR _old_item IN
    SELECT * FROM public.purchase_invoice_items WHERE invoice_id = _invoice_id
  LOOP
    IF _old_item.product_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT quantity, cost_price
      INTO _cur_stock, _cur_cost
      FROM public.products
     WHERE id = _old_item.product_id AND user_id = _owner
       FOR UPDATE;

    IF FOUND THEN
      IF _no_inventory THEN
        SELECT EXISTS (
          SELECT 1
            FROM public.purchase_invoice_items pii
            JOIN public.purchase_invoices pi ON pi.id = pii.invoice_id
           WHERE pii.product_id = _old_item.product_id
             AND pi.user_id = _owner
             AND pi.id <> _invoice_id
             AND pi.replaced_by IS NULL
             AND COALESCE(pi.status, '') IN ('finalized', 'completed')
             AND COALESCE(pi.payment_status, '') <> 'cancelled'
             AND COALESCE(pi.finalized_at, pi.created_at) > COALESCE(_orig_inv.finalized_at, _orig_inv.created_at)
        ) INTO _has_newer_purchase;

        IF NOT _has_newer_purchase AND _old_item.cost_price_before IS NOT NULL THEN
          UPDATE public.products
             SET cost_price = _old_item.cost_price_before,
                 updated_at = now()
           WHERE id = _old_item.product_id;
        END IF;
      ELSE
        IF COALESCE(_cur_stock, 0) < COALESCE(_old_item.quantity, 0) THEN
          RAISE EXCEPTION 'لا يمكن تعديل الفاتورة: جزء من كمية "%" بيع أو أُخرج من المخزون', _old_item.product_name;
        END IF;

        _new_stock := round(COALESCE(_cur_stock, 0) - COALESCE(_old_item.quantity, 0), 3);
        _rem_val := (COALESCE(_cur_stock, 0) * COALESCE(_cur_cost, 0))
                  - (COALESCE(_old_item.quantity, 0) * COALESCE(_old_item.cost_price, 0));

        SELECT EXISTS (
          SELECT 1
            FROM public.invoice_items ii
            JOIN public.invoices inv ON inv.id = ii.invoice_id
           WHERE ii.product_id = _old_item.product_id
             AND inv.user_id = _owner
             AND COALESCE(inv.status, '') NOT IN ('cancelled', 'refunded', 'void', 'voided')
             AND inv.created_at > COALESCE(_orig_inv.finalized_at, _orig_inv.created_at)
        ) INTO _has_subsequent_sale;

        IF _has_subsequent_sale THEN
          _new_cost := COALESCE(_cur_cost, 0);
        ELSIF _new_stock > 0 AND _rem_val > 0 THEN
          _calc_cost := round(_rem_val / _new_stock, 8);
          IF _calc_cost <= 0
             OR _calc_cost > GREATEST(COALESCE(_cur_cost, 0), COALESCE(_old_item.cost_price_before, COALESCE(_cur_cost, 0)))
             OR _calc_cost < LEAST(COALESCE(_cur_cost, 0), COALESCE(_old_item.cost_price_before, COALESCE(_cur_cost, 0))) THEN
            _new_cost := COALESCE(_cur_cost, 0);
          ELSE
            _new_cost := _calc_cost;
          END IF;
        ELSIF _new_stock > 0 AND _rem_val <= 0 THEN
          _new_cost := COALESCE(_cur_cost, 0);
        ELSIF _old_item.cost_price_before IS NOT NULL THEN
          _new_cost := _old_item.cost_price_before;
        ELSE
          _new_cost := COALESCE(_cur_cost, 0);
        END IF;

        v_variance := round((_new_stock * _new_cost) - _rem_val, 8);
        IF v_variance <> 0 THEN
          INSERT INTO public.inventory_valuation_adjustments(
            user_id, source_type, source_id, product_id, variance_usd, notes
          ) VALUES (
            _owner,
            'purchase_edit',
            _invoice_id,
            _old_item.product_id,
            v_variance,
            'فرق تقييم مخزون عند تعديل فاتورة الشراء ' || COALESCE(_orig_inv.invoice_number, '')
          );
        END IF;

        UPDATE public.products
           SET quantity = _new_stock,
               cost_price = _new_cost,
               updated_at = now()
         WHERE id = _old_item.product_id;
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.purchase_invoices (
    user_id, invoice_number, supplier_name, supplier_company, invoice_date, status,
    finalized_at, notes, payment_status, payment_method, operation_id, edit_reason
  )
  VALUES (
    _owner,
    _orig_inv.invoice_number || '-E',
    _orig_inv.supplier_name,
    _orig_inv.supplier_company,
    _orig_inv.invoice_date,
    COALESCE(_orig_inv.status, 'finalized'),
    now(),
    COALESCE(_reason, 'تعديل الفاتورة ' || _orig_inv.invoice_number),
    _orig_inv.payment_status,
    _orig_inv.payment_method,
    _op_id,
    _reason
  )
  RETURNING id INTO _new_invoice_id;

  UPDATE public.product_serials
     SET purchase_invoice_id = _new_invoice_id,
         updated_at = now()
   WHERE purchase_invoice_id = _invoice_id
     AND user_id = _owner
     AND status = 'in_stock';

  FOR _line IN SELECT * FROM jsonb_array_elements(_new_lines) LOOP
    _prod_id := (_line->>'product_id')::uuid;
    _prod_qty := GREATEST(0, (_line->>'quantity')::numeric);
    _prod_cost := GREATEST(0, (_line->>'cost_price')::numeric);
    _prod_name := COALESCE(_line->>'product_name', 'صنف');
    _prod_barcode := _line->>'barcode';
    _prod_cat := _line->>'category';

    SELECT quantity, cost_price
      INTO _cur_stock, _cur_cost
      FROM public.products
     WHERE id = _prod_id AND user_id = _owner
       FOR UPDATE;

    IF FOUND THEN
      IF _no_inventory THEN
        UPDATE public.products
           SET cost_price = _prod_cost,
               updated_at = now()
         WHERE id = _prod_id;
      ELSE
        _new_stock := round(COALESCE(_cur_stock, 0) + _prod_qty, 3);
        _new_cost := CASE
          WHEN _new_stock > 0 THEN
            ((COALESCE(_cur_stock, 0) * COALESCE(_cur_cost, 0)) + (_prod_qty * _prod_cost)) / _new_stock
          ELSE _prod_cost
        END;
        UPDATE public.products
           SET quantity = _new_stock,
               cost_price = _new_cost,
               updated_at = now()
         WHERE id = _prod_id;
      END IF;

      INSERT INTO public.purchase_invoice_items(
        invoice_id, product_id, product_name, barcode, category,
        quantity, cost_price, cost_price_before, sale_price, total_cost, serials
      )
      VALUES (
        _new_invoice_id,
        _prod_id,
        _prod_name,
        _prod_barcode,
        _prod_cat,
        _prod_qty,
        _prod_cost,
        _cur_cost,
        (_line->>'sale_price')::numeric,
        round(_prod_qty * _prod_cost, 8),
        CASE
          WHEN jsonb_typeof(_line->'serials') = 'array' THEN
            ARRAY(SELECT trim(x) FROM jsonb_array_elements_text(_line->'serials') x WHERE trim(x) <> '')
          ELSE NULL
        END
      );

      IF jsonb_typeof(_line->'serials') = 'array' THEN
        DECLARE
          _ns text[];
          _missing text[];
        BEGIN
          SELECT COALESCE(array_agg(DISTINCT trim(x)), '{}'::text[]) INTO _ns
            FROM jsonb_array_elements_text(_line->'serials') x
           WHERE trim(x) <> '';

          INSERT INTO public.product_serial_events(user_id, serial_id, event, ref, actor)
          SELECT _owner, ps.id, 'returned_to_supplier', 'edit:' || _orig_inv.invoice_number, _caller
            FROM public.product_serials ps
           WHERE ps.user_id = _owner
             AND ps.product_id = _prod_id
             AND ps.purchase_invoice_id = _new_invoice_id
             AND ps.status = 'in_stock'
             AND lower(ps.serial) <> ALL(SELECT lower(u) FROM unnest(_ns) u);

          UPDATE public.product_serials
             SET status = 'returned_to_supplier',
                 updated_at = now()
           WHERE user_id = _owner
             AND product_id = _prod_id
             AND purchase_invoice_id = _new_invoice_id
             AND status = 'in_stock'
             AND lower(serial) <> ALL(SELECT lower(u) FROM unnest(_ns) u);

          SELECT COALESCE(array_agg(s), '{}'::text[]) INTO _missing
            FROM unnest(_ns) s
           WHERE NOT EXISTS (
             SELECT 1
               FROM public.product_serials ps
              WHERE ps.user_id = _owner
                AND ps.product_id = _prod_id
                AND lower(ps.serial) = lower(s)
           );

          IF cardinality(_missing) > 0 THEN
            PERFORM public._register_serials(_owner, _prod_id, _missing, _prod_cost, _new_invoice_id, cardinality(_missing));
          END IF;
        END;
      END IF;

      _items_count := _items_count + 1;
      _total_qty := _total_qty + _prod_qty;
      _grand_total := _grand_total + round(_prod_qty * _prod_cost, 8);
    END IF;
  END LOOP;

  UPDATE public.purchase_invoices
     SET actual_items_count = _items_count,
         actual_total_quantity = _total_qty,
         actual_grand_total = round(_grand_total, 8),
         expected_items_count = _items_count,
         expected_total_quantity = _total_qty,
         expected_grand_total = round(_grand_total, 8),
         updated_at = now()
   WHERE id = _new_invoice_id;

  IF _orig_inv.supplier_id IS NOT NULL THEN
    INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, created_by)
    SELECT user_id, supplier_id, 'adjustment', -amount, 'purchase_cancel', reference_id, 'عكس بسبب تعديل الفاتورة', _caller
      FROM public.supplier_ledger_entries
     WHERE reference_type = 'purchase_invoice'
       AND reference_id = _invoice_id::text
       AND entry_type IN ('purchase', 'payment');

    INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, created_by)
    VALUES (_owner, _orig_inv.supplier_id, 'purchase', round(_grand_total, 8), 'purchase_invoice', _new_invoice_id::text, 'فاتورة معدّلة ', _caller);

    IF COALESCE(_orig_inv.amount_paid, 0) + COALESCE(_orig_inv.supplier_credit, 0) > 0 THEN
      INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, created_by)
      VALUES (_owner, _orig_inv.supplier_id, 'payment', -round(COALESCE(_orig_inv.amount_paid, 0) + COALESCE(_orig_inv.supplier_credit, 0), 8), 'purchase_invoice', _new_invoice_id::text, 'دفعة منقولة من الفاتورة الأصلية', _caller);
    END IF;

    UPDATE public.purchase_invoices
       SET supplier_id = _orig_inv.supplier_id,
           amount_paid = LEAST(COALESCE(_orig_inv.amount_paid, 0) + COALESCE(_orig_inv.supplier_credit, 0), round(_grand_total, 8))
     WHERE id = _new_invoice_id;
  END IF;

  -- F8 (audit 2026-11-24): the replacement keeps the drawer reference of the original payment, and shows the
  -- supplier credit (paid above the new total) that the supplier ledger already records.
  UPDATE public.purchase_invoices
     SET paid_from = _orig_inv.paid_from,
         paid_shift_id = _orig_inv.paid_shift_id,
         paid_currency = _orig_inv.paid_currency,
         paid_currency_amount = _orig_inv.paid_currency_amount,
         paid_rate = _orig_inv.paid_rate,
         supplier_credit = GREATEST(COALESCE(_orig_inv.amount_paid, 0) + COALESCE(_orig_inv.supplier_credit, 0) - round(_grand_total, 8), 0)
   WHERE id = _new_invoice_id;

  UPDATE public.purchase_invoices
     SET payment_status = 'cancelled',
         replaced_by = _new_invoice_id,
         edit_reason = _reason,
         updated_at = now(),
         notes = COALESCE(notes, '') || ' [تم استبدالها بـ ' || _orig_inv.invoice_number || '-E]'
   WHERE id = _invoice_id;

  RETURN _new_invoice_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.finalize_purchase_invoice_atomic(_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _inv public.purchase_invoices%ROWTYPE;
  _it record;
  _pid uuid;
  _old_cost numeric;
  _no_inventory boolean := false;
  _hist jsonb;
  _count integer := 0;
  _total_qty numeric := 0;
  _grand_total numeric := 0;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'اعتماد فاتورة الشراء مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'Owner context is required';
  END IF;

  SELECT * INTO _inv
    FROM public.purchase_invoices
   WHERE id = _invoice_id AND user_id = _owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase invoice not found';
  END IF;

  IF _inv.status = 'finalized' THEN
    RETURN jsonb_build_object('success', true, 'already_finalized', true, 'invoice_id', _invoice_id);
  END IF;

  IF COALESCE(_inv.status, 'draft') NOT IN ('draft', 'reconciled') THEN
    RAISE EXCEPTION 'Purchase invoice cannot be finalized from status %', _inv.status;
  END IF;

  PERFORM public.assert_period_open(_owner, COALESCE(_inv.invoice_date::date, CURRENT_DATE), 'اعتماد فاتورة شراء');

  -- FX tolerance cross-check for non-USD payments (drawer or external)
  IF COALESCE(_inv.amount_paid, 0) > 0
     AND upper(COALESCE(NULLIF(trim(_inv.paid_currency), ''), 'USD')) <> 'USD'
     AND COALESCE(_inv.paid_currency_amount, 0) > 0 THEN
    IF COALESCE(_inv.paid_rate, 0) <= 0 THEN
      RAISE EXCEPTION 'سعر صرف عملة الدفع (%) غير صالح', _inv.paid_currency;
    END IF;
    IF abs(_inv.paid_currency_amount - (_inv.amount_paid * _inv.paid_rate))
         > GREATEST(0.05, (_inv.amount_paid * _inv.paid_rate) * 0.01) THEN
      RAISE EXCEPTION 'مبلغ العملة المدفوعة (%) لا يتطابق مع المبلغ بالدولار وسعر الصرف (المتوقع %)',
        round(_inv.paid_currency_amount, 8),
        round(_inv.amount_paid * _inv.paid_rate, 8);
    END IF;
  END IF;

  SELECT COALESCE(s.store_type, 'general') IN ('bakery', 'repair')
    INTO _no_inventory
    FROM public.stores s
   WHERE s.user_id = _owner
   LIMIT 1;
  _no_inventory := COALESCE(_no_inventory, false);

  FOR _it IN
    SELECT * FROM public.purchase_invoice_items
     WHERE invoice_id = _invoice_id
     ORDER BY created_at, id
  LOOP
    _count := _count + 1;
    _total_qty := _total_qty + COALESCE(_it.quantity, 0);
    _grand_total := _grand_total + (COALESCE(_it.quantity, 0) * COALESCE(_it.cost_price, 0));
    _pid := _it.product_id;

    PERFORM set_config('app.stock_movement_type', 'purchase', true);
    PERFORM set_config('app.stock_source', 'finalize_purchase_invoice', true);
    PERFORM set_config('app.stock_invoice_number', COALESCE(_inv.invoice_number, ''), true);

    _hist := jsonb_build_array(jsonb_build_object(
      'invoice_id', _invoice_id,
      'invoice_number', _inv.invoice_number,
      'supplier_name', _inv.supplier_name,
      'date', _inv.invoice_date,
      'quantity', _it.quantity,
      'cost_price', _it.cost_price,
      'added_at', now()
    ));

    IF _pid IS NOT NULL THEN
      PERFORM 1 FROM public.products p WHERE p.id = _pid AND p.user_id = _owner;
      IF NOT FOUND THEN
        _pid := NULL;
      END IF;
    END IF;

    IF _pid IS NULL AND NULLIF(trim(_it.barcode), '') IS NOT NULL THEN
      SELECT p.id INTO _pid
        FROM public.products p
       WHERE p.user_id = _owner AND p.barcode = trim(_it.barcode)
       ORDER BY p.created_at
       LIMIT 1;
    END IF;

    IF _pid IS NULL AND NULLIF(trim(_it.product_name), '') IS NOT NULL THEN
      SELECT p.id INTO _pid
        FROM public.products p
       WHERE p.user_id = _owner AND lower(trim(p.name)) = lower(trim(_it.product_name))
       ORDER BY p.created_at
       LIMIT 1;
    END IF;

    IF _pid IS NULL THEN
      INSERT INTO public.products(
        user_id, name, barcode, category, quantity, cost_price, sale_price, min_stock_level, purchase_history
      ) VALUES (
        _owner, _it.product_name, NULLIF(trim(_it.barcode), ''), _it.category,
        CASE WHEN _no_inventory THEN 99999 ELSE _it.quantity END,
        COALESCE(_it.cost_price, 0),
        COALESCE(NULLIF(_it.sale_price, 0), _it.cost_price, 0),
        5, _hist
      )
      RETURNING id INTO _pid;

      UPDATE public.purchase_invoice_items
         SET product_id = _pid, cost_price_before = 0
       WHERE id = _it.id;
    ELSE
      SELECT COALESCE(p.cost_price, 0) INTO _old_cost
        FROM public.products p
       WHERE p.id = _pid
         FOR UPDATE;

      UPDATE public.purchase_invoice_items
         SET product_id = _pid, cost_price_before = _old_cost
       WHERE id = _it.id;

      IF _no_inventory THEN
        UPDATE public.products
           SET cost_price = COALESCE(_it.cost_price, 0), updated_at = now()
         WHERE id = _pid;
      ELSE
        PERFORM public.receive_stock_wac(
          _pid,
          _it.quantity::numeric,
          COALESCE(_it.cost_price, 0)::numeric,
          'purchase_invoice:' || COALESCE(_inv.invoice_number, '')
        );
      END IF;

      UPDATE public.products
         SET purchase_history = (CASE WHEN jsonb_typeof(purchase_history) = 'array' THEN purchase_history ELSE '[]'::jsonb END) || _hist
       WHERE id = _pid;
    END IF;
  END LOOP;

  IF _count = 0 THEN
    RAISE EXCEPTION 'Purchase invoice has no items';
  END IF;

  UPDATE public.purchase_invoices
     SET status = 'finalized',
         finalized_at = now(),
         actual_items_count = _count,
         actual_total_quantity = _total_qty,
         actual_grand_total = round(_grand_total, 8),
         updated_at = now()
   WHERE id = _invoice_id;

  DECLARE _sr record;
  BEGIN
    FOR _sr IN
      SELECT i.product_id, i.quantity, i.cost_price, i.serials, p.track_serials, p.name
        FROM public.purchase_invoice_items i
        JOIN public.products p ON p.id = i.product_id
       WHERE i.invoice_id = _invoice_id
         AND (p.track_serials OR cardinality(COALESCE(i.serials, '{}'::text[])) > 0)
    LOOP
      IF _sr.track_serials AND cardinality(COALESCE(_sr.serials, '{}'::text[])) = 0 THEN
        RAISE EXCEPTION 'المنتج % يتطلب إدخال أرقام تسلسلية', _sr.name;
      END IF;
      PERFORM public._register_serials(_owner, _sr.product_id, _sr.serials, _sr.cost_price, _invoice_id, _sr.quantity);
      UPDATE public.products SET track_serials = true WHERE id = _sr.product_id AND NOT track_serials;
    END LOOP;
  END;

  IF _inv.supplier_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.supplier_ledger_entries
        WHERE reference_type = 'purchase_invoice'
          AND reference_id = _invoice_id::text
          AND entry_type = 'purchase'
     ) THEN
    DECLARE
      _tot numeric := round(_grand_total, 8);
      _paid numeric := COALESCE(_inv.amount_paid, 0);
    BEGIN
      IF _paid > _tot + 0.0001 THEN
        RAISE EXCEPTION 'المدفوع أكبر من إجمالي الفاتورة';
      END IF;
      IF _paid > 0 AND _inv.paid_from = 'drawer' THEN
        PERFORM public._supplier_drawer_tx(
          _owner,
          _inv.paid_shift_id,
          'supplier_payment',
          _paid,
          _inv.paid_currency,
          _inv.paid_currency_amount,
          _inv.paid_rate,
          'purchase:' || _invoice_id::text,
          'دفعة فاتورة شراء ' || COALESCE(_inv.invoice_number, '')
        );
      END IF;
      IF _tot > 0 THEN
        INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, created_by)
        VALUES (_owner, _inv.supplier_id, 'purchase', _tot, 'purchase_invoice', _invoice_id::text, 'فاتورة شراء ' || COALESCE(_inv.invoice_number, ''), _caller);
      END IF;
      IF _paid > 0 THEN
        INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, payment_method, payment_source, shift_id, note, created_by)
        VALUES (
          _owner,
          _inv.supplier_id,
          'payment',
          -round(_paid, 8),
          'purchase_invoice',
          _invoice_id::text,
          _inv.payment_method,
          COALESCE(_inv.paid_from, 'external'),
          CASE WHEN _inv.paid_from = 'drawer' THEN _inv.paid_shift_id ELSE NULL END,
          'دفعة عند الشراء ' || COALESCE(_inv.invoice_number, ''),
          _caller
        );
      END IF;
    END;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_finalized', false,
    'invoice_id', _invoice_id,
    'items', _count,
    'actual_grand_total', round(_grand_total, 8)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.writeoff_debt_atomic(_debt_id uuid, _reason text, _operation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _debt public.debts%ROWTYPE;
  _partner record;
  _clean_details jsonb;
  _item jsonb;
  _inv_id uuid;
  _inv_total numeric := 0;
  _inv_profit numeric := 0;
  _inv_tax numeric := 0;
  _has_inv boolean := false;
  _amount numeric := 0;
  _pending_cancelled numeric := 0;
  _tax_cancelled numeric := 0;
  _loss numeric := 0;
  _total_cost numeric := 0;
  _cat record;
  _cat_loss numeric;
  _remaining_loss numeric;
  _cat_share jsonb;
  _part numeric;
  _impact jsonb := '[]'::jsonb;
  _partners_total numeric := 0;
  _wo_key text;
  _resolved_customer_id uuid;
BEGIN
  PERFORM set_config('app.partner_source', 'writeoff_debt_atomic', true);
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'شطب الدين مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  IF _operation_id IS NULL OR length(_operation_id) < 8 THEN
    RAISE EXCEPTION 'معرف العملية غير صالح';
  END IF;

  SELECT * INTO _debt
    FROM public.debts
   WHERE id = _debt_id AND user_id = _owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'الدين غير موجود أو لا يتبع لهذا المتجر';
  END IF;

  IF _debt.status = 'written_off' THEN
    RETURN jsonb_build_object('success', true, 'already_written_off', true, 'debt_id', _debt_id);
  END IF;

  IF COALESCE(_debt.status, '') IN ('cancelled', 'fully_paid') THEN
    RAISE EXCEPTION 'لا يمكن شطب دين ملغى أو مسدد بالكامل';
  END IF;

  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'شطب دين');

  _amount := round(GREATEST(COALESCE(_debt.remaining_debt, 0), 0), 8);
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'لا يوجد مبلغ متبقٍ لشطبه';
  END IF;
  _wo_key := 'WO-' || COALESCE(_debt.invoice_id, _debt_id::text);

  IF _debt.invoice_id IS NOT NULL AND NOT COALESCE(_debt.is_cash_debt, false) THEN
    SELECT i.id, COALESCE(i.total, 0), COALESCE(i.profit, 0), COALESCE(i.tax_amount, 0)
      INTO _inv_id, _inv_total, _inv_profit, _inv_tax
      FROM public.invoices i
     WHERE i.user_id = _owner
       AND (i.invoice_number = _debt.invoice_id OR i.id::text = _debt.invoice_id)
     ORDER BY i.created_at
     LIMIT 1;
    _has_inv := FOUND;
  END IF;

  IF _has_inv AND _inv_total > 0 THEN
    _pending_cancelled := round(_inv_profit * LEAST(_amount, _inv_total) / _inv_total, 8);
    _tax_cancelled := round(_inv_tax * LEAST(_amount, _inv_total) / _inv_total, 8);
  END IF;
  _loss := GREATEST(round(_amount - _pending_cancelled - _tax_cancelled, 8), 0);

  PERFORM set_config('app.debt_writeoff_internal', '1', true);

  UPDATE public.debts
     SET status = 'written_off',
         notes = concat_ws(E'\n', notes, '[شطب دين]: ' || COALESCE(_reason, 'شطب إداري')),
         updated_at = now()
   WHERE id = _debt_id;

  IF _debt.invoice_id IS NOT NULL AND NOT COALESCE(_debt.is_cash_debt, false) THEN
    UPDATE public.invoices
       SET status = 'written_off',
           debt_remaining = 0,
           notes = concat_ws(E'\n', notes, '[دين مشطوب]: ' || COALESCE(_reason, '')),
           updated_at = now()
     WHERE user_id = _owner
       AND (invoice_number = _debt.invoice_id OR id::text = _debt.invoice_id);
  END IF;

  _resolved_customer_id := _debt.customer_id;
  IF _resolved_customer_id IS NULL THEN
    IF NULLIF(trim(COALESCE(_debt.customer_phone, '')), '') IS NOT NULL THEN
      SELECT CASE WHEN count(*) = 1 THEN (array_agg(id))[1] ELSE NULL END
        INTO _resolved_customer_id
        FROM public.customers
       WHERE user_id = _owner
         AND trim(COALESCE(phone, '')) = trim(_debt.customer_phone);
    END IF;
    IF _resolved_customer_id IS NULL AND NULLIF(trim(COALESCE(_debt.customer_name, '')), '') IS NOT NULL THEN
      SELECT id INTO _resolved_customer_id
        FROM public.customers
       WHERE user_id = _owner
         AND name = _debt.customer_name
       ORDER BY created_at ASC
       LIMIT 1;
    END IF;
  END IF;

  IF _resolved_customer_id IS NOT NULL THEN
    PERFORM public.recalc_customer_open_debt(_owner, _resolved_customer_id);
  END IF;

  IF _debt.invoice_id IS NOT NULL THEN
    FOR _partner IN
      SELECT * FROM public.partners
       WHERE user_id = _owner
         AND pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', _debt.invoice_id))
       FOR UPDATE
    LOOP
      _clean_details := '[]'::jsonb;
      FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb))
      LOOP
        IF (_item->>'invoiceId') <> _debt.invoice_id THEN
          _clean_details := _clean_details || _item;
        END IF;
      END LOOP;

      UPDATE public.partners
         SET pending_profit_details = _clean_details,
             pending_profit = (
               SELECT COALESCE(SUM((x->>'amount')::numeric), 0)
                 FROM jsonb_array_elements(_clean_details) AS x
             ),
             updated_at = now()
       WHERE id = _partner.id;
    END LOOP;
  END IF;

  IF _loss > 0 AND _has_inv THEN
    SELECT COALESCE(SUM(COALESCE(ii.cost_price, 0) * COALESCE(ii.quantity, 0)), 0)
      INTO _total_cost
      FROM public.invoice_items ii
     WHERE ii.invoice_id = _inv_id;

    FOR _cat IN
      SELECT c.category_name, c.cat_cost
        FROM (
          SELECT COALESCE(NULLIF(trim(p.category), ''), 'عام') AS category_name,
                 SUM(COALESCE(ii.cost_price, 0) * COALESCE(ii.quantity, 0)) AS cat_cost
            FROM public.invoice_items ii
            LEFT JOIN public.products p ON p.id = ii.product_id AND p.user_id = _owner
           WHERE _total_cost > 0 AND ii.invoice_id = _inv_id
           GROUP BY COALESCE(NULLIF(trim(p.category), ''), 'عام')
          HAVING SUM(COALESCE(ii.cost_price, 0) * COALESCE(ii.quantity, 0)) > 0
          UNION ALL
          SELECT 'عام'::text, 1::numeric WHERE NOT (_total_cost > 0)
        ) c
    LOOP
      _cat_loss := CASE WHEN _total_cost > 0
                        THEN round(_loss * _cat.cat_cost / _total_cost, 8)
                        ELSE _loss END;
      _remaining_loss := _cat_loss;

      BEGIN
        FOR _partner IN
          SELECT * FROM public.partners
           WHERE user_id = _owner
             AND COALESCE(access_all, false) = false
             AND category_shares IS NOT NULL
           FOR UPDATE
        LOOP
          SELECT cs INTO _cat_share
            FROM jsonb_array_elements(_partner.category_shares) cs
           WHERE (cs->>'enabled')::boolean = true
             AND cs->>'categoryName' = _cat.category_name
           LIMIT 1;

          IF _cat_share IS NOT NULL AND COALESCE((_cat_share->>'percentage')::numeric, 0) > 0 THEN
            _part := round(_cat_loss * (_cat_share->>'percentage')::numeric / 100.0, 8);
            IF _part > 0 THEN
              _remaining_loss := _remaining_loss - _part;
              _partners_total := _partners_total + _part;

              UPDATE public.partners SET
                confirmed_profit = round(COALESCE(confirmed_profit, 0) - _part, 8),
                current_balance = round(COALESCE(current_balance, 0) - _part, 8),
                total_profit_earned = round(COALESCE(total_profit_earned, 0) - _part, 8),
                profit_history = COALESCE(profit_history, '[]'::jsonb) || jsonb_build_object(
                  'id', 'wo-' || _debt_id::text || '-' || _partner.id::text || '-' || _cat.category_name,
                  'invoiceId', _wo_key,
                  'amount', -_part,
                  'category', 'خسارة دين معدوم',
                  'isDebt', false,
                  'isWriteoff', true,
                  'createdAt', now()
                ),
                updated_at = now()
              WHERE id = _partner.id;

              _impact := _impact || jsonb_build_object(
                'partnerId', _partner.id,
                'partnerName', _partner.name,
                'amount', _part,
                'category', _cat.category_name
              );
            END IF;
          END IF;
        END LOOP;
      END;

      IF _remaining_loss > 0 THEN
        FOR _partner IN
          SELECT * FROM public.partners
           WHERE user_id = _owner
             AND COALESCE(access_all, false) = true
             AND COALESCE(share_percentage, 0) > 0
           FOR UPDATE
        LOOP
          _part := round(_remaining_loss * _partner.share_percentage / 100.0, 8);
          IF _part > 0 THEN
            _partners_total := _partners_total + _part;

            UPDATE public.partners SET
              confirmed_profit = round(COALESCE(confirmed_profit, 0) - _part, 8),
              current_balance = round(COALESCE(current_balance, 0) - _part, 8),
              total_profit_earned = round(COALESCE(total_profit_earned, 0) - _part, 8),
              profit_history = COALESCE(profit_history, '[]'::jsonb) || jsonb_build_object(
                'id', 'wo-' || _debt_id::text || '-' || _partner.id::text || '-' || _cat.category_name,
                'invoiceId', _wo_key,
                'amount', -_part,
                'category', 'خسارة دين معدوم',
                'isDebt', false,
                'isWriteoff', true,
                'createdAt', now()
              ),
              updated_at = now()
            WHERE id = _partner.id;

            _impact := _impact || jsonb_build_object(
              'partnerId', _partner.id,
              'partnerName', _partner.name,
              'amount', _part,
              'category', _cat.category_name
            );
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.debt_writeoffs(
    user_id, debt_id, customer_name, amount, reason, written_off_at, written_off_by, notes,
    loss_amount, pending_profit_cancelled, partner_impact, capital_impact
  ) VALUES (
    _owner, _debt_id, _debt.customer_name, _amount, COALESCE(_reason, 'شطب إداري'), now(), _caller, _debt.invoice_id,
    _loss, _pending_cancelled, _impact, round(_loss - _partners_total, 8)
  );

  RETURN jsonb_build_object(
    'success', true,
    'debt_id', _debt_id,
    'written_off_amount', _amount,
    'pending_profit_cancelled', _pending_cancelled,
    'loss_amount', _loss,
    'partners_loss', _partners_total,
    'owner_loss', round(_loss - _partners_total, 8),
    'partner_impact', _impact,
    'status', 'written_off'
  );
END;
$function$
;

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
          current_balance = round(COALESCE(current_balance, 0) + _part_amount, 8),
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
$function$
;

CREATE OR REPLACE FUNCTION public.revert_invoice_partner_profits_atomic(_invoice_id uuid, _revert_ratio numeric DEFAULT 1.0, _category_profits jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE;
  _owner uuid;
  _partner record;
  _ratio numeric := LEAST(GREATEST(COALESCE(_revert_ratio, 1.0), 0.0), 1.0);
  _full boolean;
  _use_cat_map boolean;
  _updated_details jsonb;
  _revert_record jsonb;
  _rev_entries jsonb;
  _pending_reverted numeric;
  _confirmed_reverted numeric;
  _orig_share numeric;
  _pending_now numeric;
  _already_reverted numeric;
  _confirmed_net numeric;
  _avail_total numeric;
  _target_rev numeric;
  _pending_scale numeric;
  _item jsonb;
  _amt numeric;
  _total_reverted numeric := 0;
  _rem_by_cat jsonb;
  _cat_entry record;
  _cat_share jsonb;
  _pct numeric;
  _cat_amt numeric;
  _orig_cat_profit numeric;
  _cat_rev_list jsonb;
  _rev_item jsonb;
  _scale numeric;
  _idx int;
BEGIN
  PERFORM set_config('app.partner_source', 'revert_invoice_partner_profits_atomic', true);
  PERFORM pg_advisory_xact_lock(hashtext('partner_dist:' || _invoice_id::text));

  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  _owner := _inv.user_id;
  _full := _ratio >= 0.9999;
  _use_cat_map := (_category_profits IS NOT NULL AND jsonb_typeof(_category_profits) = 'object' AND _category_profits <> '{}'::jsonb);

  IF _use_cat_map THEN
    _rem_by_cat := _category_profits;

    FOR _partner IN
      SELECT * FROM public.partners
      WHERE user_id = _owner
        AND COALESCE(access_all, false) = false
        AND (
          profit_history @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
          OR pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
        )
      ORDER BY id
      FOR UPDATE
    LOOP
      _target_rev := 0;
      _cat_rev_list := '[]'::jsonb;

      IF _partner.category_shares IS NOT NULL AND jsonb_typeof(_partner.category_shares) = 'array' THEN
        FOR _cat_entry IN
          SELECT key AS cat_name, COALESCE(NULLIF(value, '')::numeric, 0) AS cat_profit
          FROM jsonb_each_text(_category_profits)
        LOOP
          IF _cat_entry.cat_profit = 0 THEN
            CONTINUE;
          END IF;

          SELECT cs INTO _cat_share
          FROM jsonb_array_elements(_partner.category_shares) cs
          WHERE COALESCE((cs->>'enabled')::boolean, false) = true
            AND trim(COALESCE(cs->>'categoryName', '')) = trim(_cat_entry.cat_name)
          LIMIT 1;

          IF _cat_share IS NOT NULL AND COALESCE((_cat_share->>'percentage')::numeric, 0) > 0 THEN
            _pct := (_cat_share->>'percentage')::numeric;
            _cat_amt := round((_cat_entry.cat_profit * _pct / 100.0), 8);
            IF _cat_amt <> 0 THEN
              _target_rev := _target_rev + _cat_amt;
              _rem_by_cat := jsonb_set(
                _rem_by_cat,
                ARRAY[_cat_entry.cat_name],
                to_jsonb(round(COALESCE((_rem_by_cat->>_cat_entry.cat_name)::numeric, 0) - _cat_amt, 8)),
                true
              );
              _cat_rev_list := _cat_rev_list || jsonb_build_object('category', _cat_entry.cat_name, 'amount', _cat_amt);
            END IF;
          END IF;
        END LOOP;
      END IF;

      IF _target_rev = 0 THEN
        CONTINUE;
      END IF;

      SELECT COALESCE(SUM(COALESCE((x->>'amount')::numeric, 0)), 0) INTO _pending_now
        FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb)) x
       WHERE x->>'invoiceId' = _inv.invoice_number;

      SELECT COALESCE(SUM(COALESCE((x->>'amount')::numeric, 0)), 0) INTO _orig_share
        FROM jsonb_array_elements(COALESCE(_partner.profit_history, '[]'::jsonb)) x
       WHERE x->>'invoiceId' = _inv.invoice_number
         AND COALESCE((x->>'isReversal')::boolean, false) = false
         AND COALESCE((x->>'isRelease')::boolean, false) = false
         AND COALESCE(x->>'id', '') NOT LIKE '%-rel'
         AND COALESCE(x->>'category', '') <> 'تحرير دفعة دين';

      SELECT COALESCE(SUM(-COALESCE((x->>'amount')::numeric, 0)), 0) INTO _already_reverted
        FROM jsonb_array_elements(COALESCE(_partner.profit_history, '[]'::jsonb)) x
       WHERE x->>'invoiceId' = _inv.invoice_number
         AND COALESCE((x->>'isReversal')::boolean, false) = true;

      _confirmed_net := round(_orig_share - _pending_now - _already_reverted, 8);
      _confirmed_net := CASE WHEN _orig_share >= 0 THEN GREATEST(_confirmed_net, 0) ELSE LEAST(_confirmed_net, 0) END;
      _avail_total := round(_pending_now + _confirmed_net, 8);

      IF _orig_share >= 0 AND _target_rev > 0 THEN
        _target_rev := LEAST(_target_rev, GREATEST(_avail_total, 0));
      ELSIF _orig_share < 0 AND _target_rev < 0 THEN
        _target_rev := GREATEST(_target_rev, LEAST(_avail_total, 0));
      END IF;

      IF _target_rev = 0 THEN
        CONTINUE;
      END IF;

      _pending_reverted := 0;
      IF _pending_now <> 0 AND ((_target_rev > 0 AND _pending_now > 0) OR (_target_rev < 0 AND _pending_now < 0)) THEN
        IF abs(_target_rev) >= abs(_pending_now) THEN
          _pending_reverted := _pending_now;
        ELSE
          _pending_reverted := round(_target_rev, 8);
        END IF;
      END IF;

      _confirmed_reverted := round(_target_rev - _pending_reverted, 8);
      IF _orig_share >= 0 AND _confirmed_reverted > 0 THEN
        _confirmed_reverted := LEAST(_confirmed_reverted, GREATEST(_confirmed_net, 0));
      ELSIF _orig_share < 0 AND _confirmed_reverted < 0 THEN
        _confirmed_reverted := GREATEST(_confirmed_reverted, LEAST(_confirmed_net, 0));
      END IF;

      _updated_details := '[]'::jsonb;
      _pending_scale := CASE WHEN _pending_now <> 0 THEN 1.0 - (_pending_reverted / _pending_now) ELSE 1.0 END;
      FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb)) LOOP
        IF _item->>'invoiceId' = _inv.invoice_number THEN
          _amt := COALESCE((_item->>'amount')::numeric, 0);
          IF abs(round(_amt * _pending_scale, 8)) > 0.00005 THEN
            _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_amt * _pending_scale, 8)));
          END IF;
        ELSE
          _updated_details := _updated_details || _item;
        END IF;
      END LOOP;

      IF _pending_reverted <> 0 OR _confirmed_reverted <> 0 THEN
        _rev_entries := '[]'::jsonb;
        _scale := CASE WHEN _target_rev <> 0 THEN (_pending_reverted + _confirmed_reverted) / _target_rev ELSE 1.0 END;
        _idx := 0;
        FOR _rev_item IN SELECT * FROM jsonb_array_elements(_cat_rev_list) LOOP
          _idx := _idx + 1;
          _cat_amt := round((_rev_item->>'amount')::numeric * _scale, 8);
          IF _cat_amt <> 0 THEN
            _rev_entries := _rev_entries || jsonb_build_array(jsonb_build_object(
              'id', extract(epoch from now())::text || _partner.id::text || '-rev-' || _idx::text,
              'invoiceId', _inv.invoice_number,
              'amount', -_cat_amt,
              'pendingReverted', round(_pending_reverted * (_cat_amt / NULLIF(_pending_reverted + _confirmed_reverted, 0)), 8),
              'confirmedReverted', round(_confirmed_reverted * (_cat_amt / NULLIF(_pending_reverted + _confirmed_reverted, 0)), 8),
              'category', _rev_item->>'category',
              'isReversal', true,
              'createdAt', now()
            ));
          END IF;
        END LOOP;

        UPDATE public.partners SET
          pending_profit = round((SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(_updated_details) x), 8),
          confirmed_profit = round(COALESCE(confirmed_profit, 0) - _confirmed_reverted, 8),
          current_balance = round(COALESCE(current_balance, 0) - _confirmed_reverted, 8),
          total_profit_earned = round(COALESCE(total_profit_earned, 0) - _confirmed_reverted, 8),
          pending_profit_details = _updated_details,
          profit_history = COALESCE(profit_history, '[]'::jsonb) || _rev_entries,
          updated_at = now()
        WHERE id = _partner.id;

        _total_reverted := _total_reverted + _pending_reverted + _confirmed_reverted;
      END IF;
    END LOOP;

    FOR _partner IN
      SELECT * FROM public.partners
      WHERE user_id = _owner
        AND COALESCE(access_all, false) = true
        AND COALESCE(share_percentage, 0) > 0
        AND (
          profit_history @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
          OR pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
        )
      ORDER BY id
      FOR UPDATE
    LOOP
      _target_rev := 0;
      _cat_rev_list := '[]'::jsonb;

      FOR _cat_entry IN
        SELECT key AS cat_name, COALESCE(NULLIF(value, '')::numeric, 0) AS rem_profit
        FROM jsonb_each_text(_rem_by_cat)
      LOOP
        _orig_cat_profit := COALESCE((_category_profits->>_cat_entry.cat_name)::numeric, 0);
        IF (_orig_cat_profit > 0 AND _cat_entry.rem_profit > 0)
           OR (_orig_cat_profit < 0 AND _cat_entry.rem_profit < 0) THEN
          _cat_amt := round((_cat_entry.rem_profit * _partner.share_percentage / 100.0), 8);
          IF _cat_amt <> 0 THEN
            _target_rev := _target_rev + _cat_amt;
            _cat_rev_list := _cat_rev_list || jsonb_build_object('category', _cat_entry.cat_name, 'amount', _cat_amt);
          END IF;
        END IF;
      END LOOP;

      IF _target_rev = 0 THEN
        CONTINUE;
      END IF;

      SELECT COALESCE(SUM(COALESCE((x->>'amount')::numeric, 0)), 0) INTO _pending_now
        FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb)) x
       WHERE x->>'invoiceId' = _inv.invoice_number;

      SELECT COALESCE(SUM(COALESCE((x->>'amount')::numeric, 0)), 0) INTO _orig_share
        FROM jsonb_array_elements(COALESCE(_partner.profit_history, '[]'::jsonb)) x
       WHERE x->>'invoiceId' = _inv.invoice_number
         AND COALESCE((x->>'isReversal')::boolean, false) = false
         AND COALESCE((x->>'isRelease')::boolean, false) = false
         AND COALESCE(x->>'id', '') NOT LIKE '%-rel'
         AND COALESCE(x->>'category', '') <> 'تحرير دفعة دين';

      SELECT COALESCE(SUM(-COALESCE((x->>'amount')::numeric, 0)), 0) INTO _already_reverted
        FROM jsonb_array_elements(COALESCE(_partner.profit_history, '[]'::jsonb)) x
       WHERE x->>'invoiceId' = _inv.invoice_number
         AND COALESCE((x->>'isReversal')::boolean, false) = true;

      _confirmed_net := round(_orig_share - _pending_now - _already_reverted, 8);
      _confirmed_net := CASE WHEN _orig_share >= 0 THEN GREATEST(_confirmed_net, 0) ELSE LEAST(_confirmed_net, 0) END;
      _avail_total := round(_pending_now + _confirmed_net, 8);

      IF _orig_share >= 0 AND _target_rev > 0 THEN
        _target_rev := LEAST(_target_rev, GREATEST(_avail_total, 0));
      ELSIF _orig_share < 0 AND _target_rev < 0 THEN
        _target_rev := GREATEST(_target_rev, LEAST(_avail_total, 0));
      END IF;

      IF _target_rev = 0 THEN
        CONTINUE;
      END IF;

      _pending_reverted := 0;
      IF _pending_now <> 0 AND ((_target_rev > 0 AND _pending_now > 0) OR (_target_rev < 0 AND _pending_now < 0)) THEN
        IF abs(_target_rev) >= abs(_pending_now) THEN
          _pending_reverted := _pending_now;
        ELSE
          _pending_reverted := round(_target_rev, 8);
        END IF;
      END IF;

      _confirmed_reverted := round(_target_rev - _pending_reverted, 8);
      IF _orig_share >= 0 AND _confirmed_reverted > 0 THEN
        _confirmed_reverted := LEAST(_confirmed_reverted, GREATEST(_confirmed_net, 0));
      ELSIF _orig_share < 0 AND _confirmed_reverted < 0 THEN
        _confirmed_reverted := GREATEST(_confirmed_reverted, LEAST(_confirmed_net, 0));
      END IF;

      _updated_details := '[]'::jsonb;
      _pending_scale := CASE WHEN _pending_now <> 0 THEN 1.0 - (_pending_reverted / _pending_now) ELSE 1.0 END;
      FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb)) LOOP
        IF _item->>'invoiceId' = _inv.invoice_number THEN
          _amt := COALESCE((_item->>'amount')::numeric, 0);
          IF abs(round(_amt * _pending_scale, 8)) > 0.00005 THEN
            _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_amt * _pending_scale, 8)));
          END IF;
        ELSE
          _updated_details := _updated_details || _item;
        END IF;
      END LOOP;

      IF _pending_reverted <> 0 OR _confirmed_reverted <> 0 THEN
        _rev_entries := '[]'::jsonb;
        _scale := CASE WHEN _target_rev <> 0 THEN (_pending_reverted + _confirmed_reverted) / _target_rev ELSE 1.0 END;
        _idx := 0;
        FOR _rev_item IN SELECT * FROM jsonb_array_elements(_cat_rev_list) LOOP
          _idx := _idx + 1;
          _cat_amt := round((_rev_item->>'amount')::numeric * _scale, 8);
          IF _cat_amt <> 0 THEN
            _rev_entries := _rev_entries || jsonb_build_array(jsonb_build_object(
              'id', extract(epoch from now())::text || _partner.id::text || '-rev-' || _idx::text,
              'invoiceId', _inv.invoice_number,
              'amount', -_cat_amt,
              'pendingReverted', round(_pending_reverted * (_cat_amt / NULLIF(_pending_reverted + _confirmed_reverted, 0)), 8),
              'confirmedReverted', round(_confirmed_reverted * (_cat_amt / NULLIF(_pending_reverted + _confirmed_reverted, 0)), 8),
              'category', _rev_item->>'category',
              'isReversal', true,
              'createdAt', now()
            ));
          END IF;
        END LOOP;

        UPDATE public.partners SET
          pending_profit = round((SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(_updated_details) x), 8),
          confirmed_profit = round(COALESCE(confirmed_profit, 0) - _confirmed_reverted, 8),
          current_balance = round(COALESCE(current_balance, 0) - _confirmed_reverted, 8),
          total_profit_earned = round(COALESCE(total_profit_earned, 0) - _confirmed_reverted, 8),
          pending_profit_details = _updated_details,
          profit_history = COALESCE(profit_history, '[]'::jsonb) || _rev_entries,
          updated_at = now()
        WHERE id = _partner.id;

        _total_reverted := _total_reverted + _pending_reverted + _confirmed_reverted;
      END IF;
    END LOOP;

    RETURN jsonb_build_object(
      'success', true,
      'invoice_number', _inv.invoice_number,
      'total_reverted', round(_total_reverted, 8)
    );
  END IF;

  FOR _partner IN
    SELECT * FROM public.partners
    WHERE user_id = _owner
      AND (
        profit_history @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
        OR pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
      )
    ORDER BY id
    FOR UPDATE
  LOOP
    _pending_reverted := 0;
    _updated_details := '[]'::jsonb;

    FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb)) LOOP
      IF _item->>'invoiceId' = _inv.invoice_number THEN
        _amt := COALESCE((_item->>'amount')::numeric, 0);
        IF _full THEN
          _pending_reverted := _pending_reverted + _amt;
        ELSE
          _pending_reverted := _pending_reverted + round(_amt * _ratio, 8);
          IF abs(round(_amt * (1.0 - _ratio), 8)) > 0.00005 THEN
            _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_amt * (1.0 - _ratio), 8)));
          END IF;
        END IF;
      ELSE
        _updated_details := _updated_details || _item;
      END IF;
    END LOOP;

    SELECT COALESCE(SUM(COALESCE((x->>'amount')::numeric, 0)), 0) INTO _pending_now
      FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb)) x
     WHERE x->>'invoiceId' = _inv.invoice_number;

    SELECT COALESCE(SUM(COALESCE((x->>'amount')::numeric, 0)), 0) INTO _orig_share
      FROM jsonb_array_elements(COALESCE(_partner.profit_history, '[]'::jsonb)) x
     WHERE x->>'invoiceId' = _inv.invoice_number
       AND COALESCE((x->>'isReversal')::boolean, false) = false
       AND COALESCE((x->>'isRelease')::boolean, false) = false
       AND COALESCE(x->>'id', '') NOT LIKE '%-rel'
       AND COALESCE(x->>'category', '') <> 'تحرير دفعة دين';

    SELECT COALESCE(SUM(-COALESCE((x->>'amount')::numeric, 0)), 0) INTO _already_reverted
      FROM jsonb_array_elements(COALESCE(_partner.profit_history, '[]'::jsonb)) x
     WHERE x->>'invoiceId' = _inv.invoice_number
       AND COALESCE((x->>'isReversal')::boolean, false) = true;

    _confirmed_net := round(_orig_share - _pending_now - _already_reverted, 8);
    _confirmed_net := CASE WHEN _orig_share >= 0 THEN GREATEST(_confirmed_net, 0) ELSE LEAST(_confirmed_net, 0) END;
    _confirmed_reverted := CASE WHEN _full THEN _confirmed_net ELSE round(_confirmed_net * _ratio, 8) END;

    IF _pending_reverted <> 0 OR _confirmed_reverted <> 0 THEN
      _revert_record := jsonb_build_object(
        'id', extract(epoch from now())::text || _partner.id::text || '-rev',
        'invoiceId', _inv.invoice_number,
        'amount', -round(_pending_reverted + _confirmed_reverted, 8),
        'pendingReverted', round(_pending_reverted, 8),
        'confirmedReverted', round(_confirmed_reverted, 8),
        'category', 'مرتجع فاتورة',
        'isReversal', true,
        'createdAt', now()
      );

      UPDATE public.partners SET
        pending_profit = round((SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(_updated_details) x), 8),
        confirmed_profit = round(COALESCE(confirmed_profit, 0) - _confirmed_reverted, 8),
        current_balance = round(COALESCE(current_balance, 0) - _confirmed_reverted, 8),
        total_profit_earned = round(COALESCE(total_profit_earned, 0) - _confirmed_reverted, 8),
        pending_profit_details = _updated_details,
        profit_history = COALESCE(profit_history, '[]'::jsonb) || public._split_reversal_by_category(_revert_record, profit_history, _inv.invoice_number),
        updated_at = now()
      WHERE id = _partner.id;

      _total_reverted := _total_reverted + _pending_reverted + _confirmed_reverted;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_number', _inv.invoice_number,
    'total_reverted', round(_total_reverted, 8)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.refund_invoice_partial_atomic(_invoice_number text, _items jsonb, _operation_id text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT NULL::text, _currency_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT NULL::numeric, _settlement_mode text DEFAULT 'drawer'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE; _owner uuid; _item jsonb; _pid uuid; _pname text; _qty numeric; _avail numeric;
  _line record; _take numeric; _factor numeric;
  _gross numeric := 0; _refund numeric := 0; _cogs numeric := 0; _restored numeric := 0;
  _new_sub numeric; _new_disc numeric; _new_tax numeric; _new_total numeric; _new_profit numeric;
  _remaining_units numeric; _full boolean; _debt_red numeric := 0; _cash numeric := 0; _paid_red numeric := 0; _new_debt numeric;
  _digital_to_refund numeric := 0;
  _drawer_tx_recorded boolean := false;
  _drawer_refund_usd numeric := 0;
  _norm_settlement_mode text := lower(COALESCE(NULLIF(trim(_settlement_mode), ''), 'drawer'));
  _profit_ratio numeric := 0;
  _f numeric := 1;
  _disc_ratio numeric := 0;
  _profit_red numeric := 0;
  _unit_factor numeric := 1;
  _track_inventory boolean := true;
  _store_type text;
  _category_profits jsonb := '{}'::jsonb;
  _line_cat text;
  _line_profit_red numeric;
  _prev_meta jsonb;
  _prev_cash numeric := 0;
  _ccy text;
  _rate numeric;
  _ccy_amt numeric;
  _shift_ref text;
  _inserted int := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _owner := public.get_owner_id(auth.uid());

  IF NOT public.can_refund_invoices(auth.uid()) THEN
    RAISE EXCEPTION 'ليست لديك صلاحية الاسترداد. اطلبها من مالك المتجر' USING ERRCODE = '42501';
  END IF;

  IF _norm_settlement_mode NOT IN ('drawer', 'external_cash') THEN
    RAISE EXCEPTION 'وضع التسوية غير صالح: %', _settlement_mode;
  END IF;

  SELECT * INTO _inv FROM public.invoices WHERE invoice_number=_invoice_number AND user_id=_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','invoice_not_found'); END IF;
  IF COALESCE(_inv.status, '') IN ('cancelled', 'written_off') THEN
    RAISE EXCEPTION 'لا يمكن استرداد فاتورة ملغاة أو مشطوبة';
  END IF;
  IF _inv.status='refunded' THEN
    SELECT COALESCE((al.metadata->>'cash_to_refund')::numeric, 0)
      INTO _prev_cash
    FROM public.activity_log al
    WHERE al.user_id = _owner
      AND al.action_type = 'partial_refund'
      AND al.entity_id = _inv.id::text
    ORDER BY al.created_at DESC
    LIMIT 1;
    RETURN jsonb_build_object(
      'success', true,
      'already_refunded', true,
      'already_processed', true,
      'invoice_id', _inv.id,
      'invoice_number', _inv.invoice_number,
      'new_total', _inv.total,
      'cash_to_refund', COALESCE(_prev_cash, 0),
      'drawer_tx_recorded', false,
      'drawer_refund_usd', 0,
      'digital_to_refund', 0
    );
  END IF;
  IF _operation_id IS NOT NULL THEN
    SELECT al.metadata INTO _prev_meta
    FROM public.activity_log al
    WHERE al.user_id = _owner
      AND al.action_type = 'partial_refund'
      AND al.metadata->>'operation_id' = _operation_id
    ORDER BY al.created_at DESC
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_processed', true,
        'invoice_id', _inv.id,
        'invoice_number', _inv.invoice_number,
        'new_total', _inv.total,
        'new_profit', _inv.profit,
        'new_debt_remaining', _inv.debt_remaining,
        'cash_to_refund', COALESCE((_prev_meta->>'cash_to_refund')::numeric, 0),
        'drawer_tx_recorded', false,
        'drawer_refund_usd', 0,
        'digital_to_refund', COALESCE((_prev_meta->>'digital_to_refund')::numeric, 0)
      );
    END IF;
  END IF;

  PERFORM public.assert_period_open(_owner, _inv.date, 'الاسترداد الجزئي');

  SELECT s.store_type INTO _store_type FROM public.stores s WHERE s.user_id = _owner ORDER BY s.created_at LIMIT 1;
  _track_inventory := NOT (COALESCE(_store_type, 'general') IN ('bakery', 'repair', 'restaurant'));

  _factor := CASE WHEN COALESCE(_inv.subtotal,0) > 0 THEN COALESCE(_inv.total,0)/_inv.subtotal ELSE 1 END;
  IF COALESCE(_inv.tax_inclusive, false) AND COALESCE(_inv.tax_rate, 0) > 0 THEN
    _f := 1 / (1 + _inv.tax_rate / 100);
  END IF;
  IF COALESCE(_inv.subtotal,0) > 0 THEN
    _disc_ratio := LEAST(GREATEST(COALESCE(_inv.discount,0) / _inv.subtotal, 0), 1);
  END IF;

  PERFORM set_config('app.stock_movement_type','partial_refund',true);
  PERFORM set_config('app.stock_invoice_id',_inv.id::text,true);
  PERFORM set_config('app.stock_invoice_number',_inv.invoice_number,true);
  PERFORM set_config('app.stock_actor_id',auth.uid()::text,true);
  PERFORM set_config('app.stock_source','partial_refund',true);

  FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_items,'[]'::jsonb)) LOOP
    _pid := NULLIF(_item->>'product_id','')::uuid;
    _pname := NULLIF(regexp_replace(trim(COALESCE(_item->>'product_name','')),'\s+',' ','g'),'');
    _qty := round(COALESCE(NULLIF(_item->>'quantity','')::numeric,0),3);
    IF _qty <= 0 THEN CONTINUE; END IF;

    SELECT COALESCE(SUM(quantity),0) INTO _avail FROM public.invoice_items ii
    WHERE ii.invoice_id=_inv.id AND ((_pid IS NOT NULL AND ii.product_id=_pid) OR (_pid IS NULL AND regexp_replace(trim(ii.product_name),'\s+',' ','g')=_pname));
    IF _avail < _qty THEN RAISE EXCEPTION 'Refund quantity % exceeds remaining % for %',_qty,_avail,COALESCE(_pname,'item'); END IF;

    FOR _line IN SELECT * FROM public.invoice_items ii
      WHERE ii.invoice_id=_inv.id AND ii.quantity>0 AND ((_pid IS NOT NULL AND ii.product_id=_pid) OR (_pid IS NULL AND regexp_replace(trim(ii.product_name),'\s+',' ','g')=_pname))
      ORDER BY ii.id FOR UPDATE
    LOOP
      EXIT WHEN _qty <= 0;
      _take := LEAST(_qty, _line.quantity);
      UPDATE public.invoice_items SET quantity=quantity-_take,
        amount_original=CASE
          WHEN COALESCE(_line.quantity, 0) > 0 AND COALESCE(_line.amount_original, 0) <> 0
            THEN round(_line.amount_original * (quantity - _take) / _line.quantity, 8)
          ELSE round(COALESCE(unit_price, 0) * (quantity - _take) * COALESCE(_inv.exchange_rate, 1), 8)
        END,
        amount_usd=round(COALESCE(unit_price,0)*(quantity-_take),8),
        profit=round(COALESCE(unit_price,0)*(quantity-_take)*(1-_disc_ratio)*_f - COALESCE(cost_price,0)*(quantity-_take),8)
      WHERE id=_line.id;
      _unit_factor := CASE WHEN COALESCE(_line.unit,'piece') = 'bulk' THEN GREATEST(COALESCE(_line.conversion_factor,1),1) ELSE 1 END;
      _gross := _gross + _take*COALESCE(_line.unit_price,0);
      _cogs := _cogs + _take*COALESCE(_line.cost_price,0);

      -- Accumulate per-category refunded profit for exact category partner reversal
      -- Prefer category_snapshot frozen at sale time; fall back to current product category
      _line_cat := NULLIF(trim(_line.category_snapshot), '');
      IF _line_cat IS NULL AND _line.product_id IS NOT NULL THEN
        SELECT NULLIF(trim(p.category), '')
          INTO _line_cat
        FROM public.products p
        WHERE p.id = _line.product_id AND p.user_id = _owner;
      END IF;
      _line_cat := COALESCE(_line_cat, 'عام');
      _line_profit_red := round(_take * COALESCE(_line.unit_price, 0) * (1 - _disc_ratio) * _f - _take * COALESCE(_line.cost_price, 0), 8);
      IF _line_profit_red <> 0 THEN
        _category_profits := jsonb_set(
          _category_profits,
          ARRAY[_line_cat],
          to_jsonb(round(COALESCE((_category_profits->>_line_cat)::numeric, 0) + _line_profit_red, 8)),
          true
        );
      END IF;

      IF _track_inventory AND _line.product_id IS NOT NULL THEN
        IF _line.stock_warehouse_id IS NOT NULL THEN
          UPDATE public.warehouse_stock SET quantity=COALESCE(quantity,0)+_take*_unit_factor,last_updated=now()
          WHERE warehouse_id=_line.stock_warehouse_id AND product_id=_line.product_id;
          IF NOT FOUND THEN
            UPDATE public.products SET quantity=COALESCE(quantity,0)+_take*_unit_factor WHERE id=_line.product_id AND user_id=_owner;
          END IF;
        ELSE
          UPDATE public.products SET quantity=COALESCE(quantity,0)+_take*_unit_factor WHERE id=_line.product_id AND user_id=_owner;
        END IF;
      END IF;
      _restored := _restored + _take;
      _qty := _qty - _take;
    END LOOP;
  END LOOP;

  IF _restored <= 0 THEN RAISE EXCEPTION 'No items selected for refund'; END IF;

  -- Run explicit serial validation/release BEFORE updating invoices.status to 'refunded'
  -- so trg_release_serials_on_refund does not pre-release serials and break final partial refunds.
  DECLARE _ri record; _sid uuid; _released int; -- _refund_serial_release_v2
  BEGIN
    FOR _ri IN
      SELECT (e->>'product_id')::uuid AS pid,
             floor(COALESCE((e->>'quantity')::numeric,0) * COALESCE((SELECT CASE WHEN ii.unit='bulk' THEN GREATEST(COALESCE(ii.conversion_factor,1),1) ELSE 1 END FROM public.invoice_items ii WHERE ii.invoice_id=_inv.id AND ii.product_id=(e->>'product_id')::uuid LIMIT 1),1))::int AS q,
             CASE WHEN jsonb_typeof(e->'serials') = 'array' THEN ARRAY(SELECT lower(trim(x)) FROM jsonb_array_elements_text(e->'serials') x WHERE trim(x) <> '') ELSE NULL END AS req_serials
      FROM jsonb_array_elements(_items) e
      WHERE NULLIF(e->>'product_id','') IS NOT NULL
    LOOP
      IF _ri.q > 0 AND EXISTS (SELECT 1 FROM public.products WHERE id=_ri.pid AND track_serials) THEN
        IF _ri.req_serials IS NOT NULL AND cardinality(_ri.req_serials) > 0 THEN
          IF cardinality(_ri.req_serials) <> _ri.q THEN
            RAISE EXCEPTION 'عدد الأرقام التسلسلية المحددة للاسترداد (%) لا يطابق الكمية (%)', cardinality(_ri.req_serials), _ri.q;
          END IF;
          _released := 0;
          FOR _sid IN
            SELECT id FROM public.product_serials
             WHERE user_id=_owner AND sold_invoice_id=_inv.id AND product_id=_ri.pid AND status='sold'
               AND lower(serial) = ANY(_ri.req_serials)
             FOR UPDATE
          LOOP
            UPDATE public.product_serials SET status='in_stock', sold_invoice_id=NULL, sold_invoice_number=NULL, sold_at=NULL, customer_name=NULL, warranty_until=NULL, updated_at=now() WHERE id=_sid;
            INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) VALUES (_owner,_sid,'customer_return',_inv.invoice_number,auth.uid());
            _released := _released + 1;
          END LOOP;
          IF _released <> cardinality(_ri.req_serials) THEN
            RAISE EXCEPTION 'بعض الأرقام التسلسلية المحددة غير مرتبطة بهذه الفاتورة أو سبق إرجاعها';
          END IF;
        ELSE
          FOR _sid IN SELECT id FROM public.product_serials WHERE user_id=_owner AND sold_invoice_id=_inv.id AND product_id=_ri.pid AND status='sold' ORDER BY sold_at DESC, id LIMIT _ri.q FOR UPDATE LOOP
            UPDATE public.product_serials SET status='in_stock', sold_invoice_id=NULL, sold_invoice_number=NULL, sold_at=NULL, customer_name=NULL, warranty_until=NULL, updated_at=now() WHERE id=_sid;
            INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) VALUES (_owner,_sid,'customer_return',_inv.invoice_number,auth.uid());
          END LOOP;
        END IF;
      END IF;
    END LOOP;
  END;

  _refund := round(_gross*_factor,8);
  _profit_red := round(_gross*(1-_disc_ratio)*_f - _cogs, 8);
  _new_sub := GREATEST(round(COALESCE(_inv.subtotal,0)-_gross,8),0);
  IF COALESCE(_inv.subtotal,0) > 0 THEN
    _new_disc := round(COALESCE(_inv.discount,0)*_new_sub/_inv.subtotal,8);
    _new_tax := round(COALESCE(_inv.tax_amount,0)*_new_sub/_inv.subtotal,8);
  ELSE _new_disc := 0; _new_tax := 0; END IF;
  _new_total := GREATEST(round(COALESCE(_inv.total,0)-_refund,8),0);
  _new_profit := round(COALESCE(_inv.profit,0)-_profit_red,8);

  SELECT COALESCE(SUM(quantity),0) INTO _remaining_units FROM public.invoice_items WHERE invoice_id=_inv.id;
  _full := _remaining_units <= 0;
  IF _full THEN _new_total := 0; _new_profit := 0; _new_sub := 0; _new_disc := 0; _new_tax := 0; END IF;

  IF _full THEN
    _profit_ratio := 1.0;
  ELSIF COALESCE(_inv.profit, 0) <> 0 THEN
    _profit_ratio := LEAST(GREATEST(_profit_red / _inv.profit, 0.0), 1.0);
  ELSE
    _profit_ratio := LEAST(GREATEST(_refund / GREATEST(COALESCE(_inv.total, 0.0001), 0.0001), 0.0), 1.0);
  END IF;

  IF _inv.payment_type='debt' THEN
    _debt_red := LEAST(_refund, GREATEST(COALESCE(_inv.debt_remaining,0),0));
    _paid_red := round(_refund-_debt_red,8);
  ELSE
    _debt_red := 0;
    _paid_red := 0;
  END IF;

  IF COALESCE(_inv.payment_method, 'cash') = 'digital' THEN
    _cash := 0;
    _digital_to_refund := CASE WHEN _inv.payment_type='debt' THEN _paid_red ELSE _refund END;
  ELSIF _inv.payment_type='debt' THEN
    _cash := _paid_red;
    _digital_to_refund := 0;
  ELSE
    _cash := _refund;
    _digital_to_refund := 0;
  END IF;

  _new_debt := CASE WHEN _inv.payment_type='debt' THEN GREATEST(round(COALESCE(_inv.debt_remaining,0)-_debt_red,8),0) ELSE COALESCE(_inv.debt_remaining,0) END;

  -- Drawer shift guard & atomic cash drawer refund when _cash > 0
  IF _cash > 0 AND COALESCE(_inv.payment_method, 'cash') = 'cash' AND _norm_settlement_mode <> 'external_cash' THEN
    IF _shift_id IS NULL THEN
      RAISE EXCEPTION 'يجب فتح وردية صندوق نشطة لتنفيذ الاسترداد النقدي أو اختيار التسوية النقدية الخارجية';
    END IF;

    PERFORM 1 FROM public.cash_shifts
    WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
    END IF;

    _ccy := upper(COALESCE(NULLIF(trim(_currency), ''), NULLIF(trim(_inv.currency), ''), 'USD'));
    IF _ccy = 'USD' THEN
      _rate := 1.0;
      _ccy_amt := round(_cash, 2);
    ELSE
      _rate := COALESCE(_exchange_rate, NULLIF(_inv.exchange_rate, 0), 0);
      IF _rate <= 0 THEN
        RAISE EXCEPTION 'سعر الصرف غير صالح';
      END IF;
      _ccy_amt := round(COALESCE(_currency_amount, _cash * _rate), 2);
      IF _ccy_amt <= 0 THEN
        RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
      END IF;
      IF _currency_amount IS NOT NULL AND _currency_amount > 0 THEN
        IF abs(_ccy_amt - round(_cash * _rate, 2)) > GREATEST(0.05, _ccy_amt * 0.01) THEN
          RAISE EXCEPTION 'تعارض في تحويل العملة: المبلغ الأصلي (%) لا يطابق المبلغ بالدولار (%) × سعر الصرف (%)',
            _ccy_amt, round(_cash, 2), _rate;
        END IF;
      END IF;
    END IF;

    _shift_ref := COALESCE(NULLIF(trim(_operation_id), ''), _inv.invoice_number || ':' || gen_random_uuid()::text);
    INSERT INTO public.shift_transactions (
      shift_id, user_id, type, amount, currency_amount, currency, exchange_rate, notes, reference_id
    ) VALUES (
      _shift_id, _owner, 'refund', round(_cash, 8), _ccy_amt, _ccy, _rate,
      'استرداد جزئي للفاتورة ' || _inv.invoice_number,
      _shift_ref
    )
    ON CONFLICT (shift_id, type, reference_id) DO NOTHING;

    GET DIAGNOSTICS _inserted = ROW_COUNT;
    IF _inserted > 0 THEN
      UPDATE public.cash_shifts
      SET expected_balance = round(COALESCE(expected_balance, 0) - _cash, 8),
          updated_at = now()
      WHERE id = _shift_id;
      _drawer_tx_recorded := true;
      _drawer_refund_usd := round(_cash, 8);
    END IF;
  END IF;

  IF _full THEN PERFORM set_config('app.refund_context','allowed',true); END IF;
  UPDATE public.invoices SET subtotal=_new_sub, discount=_new_disc, tax_amount=_new_tax, total=_new_total, profit=_new_profit,
    debt_remaining=_new_debt, debt_paid=CASE WHEN payment_type='debt' THEN GREATEST(round(COALESCE(debt_paid,0)-_paid_red,8),0) ELSE debt_paid END,
    status=CASE WHEN _full THEN 'refunded' WHEN payment_type='debt' AND _new_debt<=0 THEN 'paid' ELSE status END,
    notes=concat_ws(E'\n',NULLIF(notes,''),'Partial refund '||_refund::text||' at '||now()::text),
    updated_at=now()
  WHERE id=_inv.id;

  IF _profit_ratio > 0 OR (_category_profits IS NOT NULL AND _category_profits <> '{}'::jsonb) THEN
    PERFORM public.revert_invoice_partner_profits_atomic(
      _inv.id,
      _profit_ratio,
      CASE WHEN _full THEN NULL ELSE NULLIF(_category_profits, '{}'::jsonb) END
    );
  END IF;
  IF _inv.payment_type='debt' AND NOT _full AND _new_debt<=0 THEN
    PERFORM public.release_pending_partner_profits_for_invoice(_inv.id);
  END IF;

  -- Record profit_records reversal atomically (no physical delete)
  IF _full THEN
    UPDATE public.profit_records
       SET is_reversed = true,
           reversed_at = now()
     WHERE user_id = _owner
       AND invoice_id IN (_inv.invoice_number, _inv.id::text)
       AND is_reversed = false;
  ELSIF _profit_red > 0 THEN
    INSERT INTO public.profit_records (
      user_id, invoice_id, gross_profit, cogs, revenue, currency, recorded_at, is_reversed
    ) VALUES (
      _owner,
      _inv.invoice_number,
      -round(_profit_red, 8),
      -round(_cogs, 8),
      -round(_refund, 8),
      COALESCE(_inv.currency, 'USD'),
      now(),
      false
    );
  END IF;

  IF _inv.payment_type='debt' THEN
    IF _full THEN
      UPDATE public.debts SET status='cancelled', remaining_debt=0, notes=concat_ws(E'\n',NULLIF(notes,''),'ملغى بسبب مرتجع كامل '||now()::text), updated_at=now() WHERE user_id=_owner AND (invoice_id=_inv.invoice_number OR invoice_id=_inv.id::text);
    ELSIF _debt_red > 0 OR _paid_red > 0 THEN
      UPDATE public.debts SET total_debt=GREATEST(round(COALESCE(total_debt,0)-_refund,8),0), total_paid=GREATEST(round(COALESCE(total_paid,0)-_paid_red,8),0),
        remaining_debt=GREATEST(round(COALESCE(remaining_debt,0)-_debt_red,8),0),
        status=CASE WHEN GREATEST(round(COALESCE(remaining_debt,0)-_debt_red,8),0)<=0 THEN 'fully_paid' ELSE status END,
        updated_at=now()
      WHERE user_id=_owner AND (invoice_id=_inv.invoice_number OR invoice_id=_inv.id::text);
    END IF;
  END IF;

  IF _inv.customer_id IS NOT NULL THEN
    UPDATE public.customers c SET total_purchases=s.tp,total_debt=s.td,invoice_count=s.ic,updated_at=now()
    FROM (SELECT COALESCE(SUM(i.total) FILTER (WHERE i.status NOT IN ('refunded','cancelled')),0)::numeric tp,
      COALESCE(SUM(i.debt_remaining) FILTER (WHERE i.status NOT IN ('refunded','cancelled','paid') AND i.payment_type='debt'),0)::numeric td,
      COUNT(*) FILTER (WHERE i.status NOT IN ('refunded','cancelled'))::int ic
      FROM public.invoices i WHERE i.user_id=_owner AND i.customer_id=_inv.customer_id) s
    WHERE c.id=_inv.customer_id AND c.user_id=_owner;
    PERFORM public.recalc_customer_open_debt(_owner, _inv.customer_id);
  END IF;

  INSERT INTO public.activity_log(user_id, actor_id, actor_name, actor_role, action_type, entity_type, entity_id, entity_name, description, metadata)
  SELECT _owner, auth.uid(), COALESCE(p.full_name, 'مستخدم'), ur.role::text,
    'partial_refund', 'invoice', _inv.id::text, _inv.invoice_number,
    'استرداد جزئي للفاتورة ' || _inv.invoice_number,
    jsonb_build_object(
      'operation_id', _operation_id,
      'invoice_number', _inv.invoice_number,
      'refund_amount', _refund,
      'profit_reduction', _profit_red,
      'cash_to_refund', _cash,
      'drawer_tx_recorded', _drawer_tx_recorded,
      'drawer_refund_usd', _drawer_refund_usd,
      'digital_to_refund', _digital_to_refund,
      'settlement_mode', _norm_settlement_mode,
      'debt_reduced', _debt_red,
      'restored_units', _restored
    )
  FROM (SELECT 1) seed
  LEFT JOIN public.profiles p ON p.user_id = auth.uid()
  LEFT JOIN public.user_roles ur ON ur.user_id = auth.uid()
  LIMIT 1;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', _inv.id,
    'invoice_number', _inv.invoice_number,
    'refund_amount', _refund,
    'restored_units', _restored,
    'new_total', _new_total,
    'new_profit', _new_profit,
    'new_debt_remaining', _new_debt,
    'cash_to_refund', _cash,
    'debt_reduced', _debt_red,
    'is_fully_refunded', _full,
    'drawer_tx_recorded', _drawer_tx_recorded,
    'drawer_refund_usd', _drawer_refund_usd,
    'digital_to_refund', _digital_to_refund
  );
END;
$function$
;

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
      _sale_original := round(_sale_settled * _sale_rate, 8);
    END IF;
    _receipts := _receipts || jsonb_build_object('key', 'sale', 'method', _sale_method,
      'ccy', _sale_currency, 'rate', _sale_rate, 'settled', _sale_settled,
      'usd', CASE WHEN _sale_matches = 1 THEN _sale_shift.amount ELSE round(_sale_settled, 8) END,
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
         -- the sale-time down payment (operation id '<sale op>:down', migration 20261125170000) is the sale receipt,
         -- already counted through invoices.paid_at_sale and its 'sale' drawer movement
         AND p.operation_id NOT LIKE '%:down'
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
$function$
;

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
  v_amt numeric := round(COALESCE(_amount, 0)::numeric, 8);
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
    v_amt := round(_original_amount / v_cap_rate, 8);
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

    IF v_amt > round(v_avail_profit + v_avail_capital, 8) THEN
      RAISE EXCEPTION 'الرصيد الإجمالي للشريك لا يكفي (أرباح متاحة: %، رأس مال متاح: %)',
        v_avail_profit, v_avail_capital;
    END IF;

    v_profit_part := round(LEAST(v_amt, v_avail_profit), 8);
    v_capital_part := round(v_amt - v_profit_part, 8);
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

  v_new_balance := round(COALESCE(v_partner.current_balance, 0) - v_profit_part, 8);
  v_new_capital := round(COALESCE(v_partner.current_capital, 0) - v_capital_part, 8);

  UPDATE public.partners
     SET current_balance = v_new_balance,
         current_capital = v_new_capital,
         total_withdrawn = round(COALESCE(total_withdrawn, 0) + v_amt, 8),
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
$function$
;
