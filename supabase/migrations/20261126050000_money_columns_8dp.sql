-- F-02: money is stored with 8 decimals. These columns still had 4, so every stored value was cut to 4 decimals
-- (e.g. a debt payment of 5,000 LBP = 0.05586592 USD was settled as 0.0559 while debts.total_paid kept 0.05586592).
-- Widening numeric(18,4) -> numeric(20,8) is lossless. Views that read these columns are dropped and recreated with the same
-- definition (security_invoker), except supplier_balances which now rounds the balance to 8 decimals instead of 4.
-- Approved by the owner on 2026-11-26 ("اصلح الباقي").

DROP VIEW IF EXISTS public.supplier_balances;
DROP VIEW IF EXISTS public.partner_ledger_reconciliation;
DROP VIEW IF EXISTS public.customer_credit_balances;

ALTER TABLE public.debt_payments
  ALTER COLUMN settled_amount TYPE numeric(20,8),
  ALTER COLUMN fx_difference_usd TYPE numeric(20,8),
  ALTER COLUMN rounding_adjustment TYPE numeric(20,8);
ALTER TABLE public.supplier_ledger_entries ALTER COLUMN amount TYPE numeric(20,8);
ALTER TABLE public.purchase_invoices
  ALTER COLUMN amount_paid TYPE numeric(20,8),
  ALTER COLUMN paid_currency_amount TYPE numeric(20,8);
ALTER TABLE public.partner_ledger_entries
  ALTER COLUMN d_confirmed_profit TYPE numeric(20,8),
  ALTER COLUMN d_current_balance TYPE numeric(20,8),
  ALTER COLUMN d_current_capital TYPE numeric(20,8),
  ALTER COLUMN d_pending_profit TYPE numeric(20,8),
  ALTER COLUMN d_total_profit_earned TYPE numeric(20,8),
  ALTER COLUMN d_total_withdrawn TYPE numeric(20,8);
ALTER TABLE public.purchase_returns ALTER COLUMN total_amount TYPE numeric(20,8);
ALTER TABLE public.purchase_return_items
  ALTER COLUMN unit_cost TYPE numeric(20,8),
  ALTER COLUMN total_cost TYPE numeric(20,8);
ALTER TABLE public.customers ALTER COLUMN credit_limit TYPE numeric(20,8);

CREATE VIEW public.supplier_balances WITH (security_invoker = true) AS
 SELECT s.id, s.user_id, s.name, s.company, s.phone, s.is_active,
    round(COALESCE(sum(l.amount), 0::numeric), 8) AS balance_due
   FROM public.suppliers s
     LEFT JOIN public.supplier_ledger_entries l ON l.supplier_id = s.id
  GROUP BY s.id;

CREATE VIEW public.partner_ledger_reconciliation WITH (security_invoker = true) AS
 SELECT p.id AS partner_id, p.user_id, p.name,
    p.current_balance, COALESCE(sum(l.d_current_balance), 0::numeric) AS ledger_balance,
    p.pending_profit, COALESCE(sum(l.d_pending_profit), 0::numeric) AS ledger_pending,
    p.confirmed_profit, COALESCE(sum(l.d_confirmed_profit), 0::numeric) AS ledger_confirmed,
    p.total_withdrawn, COALESCE(sum(l.d_total_withdrawn), 0::numeric) AS ledger_withdrawn,
    abs(COALESCE(p.current_balance, 0::numeric) - COALESCE(sum(l.d_current_balance), 0::numeric)) > 0.01
      OR abs(COALESCE(p.pending_profit, 0::numeric) - COALESCE(sum(l.d_pending_profit), 0::numeric)) > 0.01
      OR abs(COALESCE(p.confirmed_profit, 0::numeric) - COALESCE(sum(l.d_confirmed_profit), 0::numeric)) > 0.01
      OR abs(COALESCE(p.total_withdrawn, 0::numeric) - COALESCE(sum(l.d_total_withdrawn), 0::numeric)) > 0.01 AS mismatch
   FROM public.partners p
     LEFT JOIN public.partner_ledger_entries l ON l.partner_id = p.id
  GROUP BY p.id;

CREATE VIEW public.customer_credit_balances WITH (security_invoker = true) AS
 SELECT c.id AS customer_id, c.user_id, c.name, c.credit_limit, c.total_debt,
    round(COALESCE(sum(l.amount), 0::numeric), 8) AS store_credit
   FROM public.customers c
     LEFT JOIN public.customer_credit_ledger l ON l.customer_id = c.id
  GROUP BY c.id;

GRANT SELECT ON public.supplier_balances, public.partner_ledger_reconciliation, public.customer_credit_balances TO authenticated;

-- record_debt_payment_atomic still rounded the payment, the settled amount, the new total paid, the remaining debt, the FX difference and
-- the confirmed partner profit to 4 decimals (F-02 requires 8). Only the precision changes; the body is the latest definition from
-- 20261125090000, and the replay comparison of an existing payment's currency amount keeps its original 4-decimal form so that payments
-- recorded before this migration still replay as the same operation.
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

  IF v_credit > v_prev_remaining + 0.005 THEN
    RAISE EXCEPTION 'المبلغ المدخل (%) أكبر من المتبقي (%)', v_credit, v_prev_remaining;
  END IF;

  -- Separate cash tendered (2 decimals) from debt settlement (snapping within 0.005 USD)
  IF abs(v_prev_remaining - v_credit) <= 0.005 THEN
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
$function$;
