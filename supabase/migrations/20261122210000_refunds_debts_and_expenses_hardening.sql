-- ============================================================================
-- Migration: 20261122210000_refunds_debts_and_expenses_hardening
-- ============================================================================

-- 1. public.refund_invoice_atomic
DROP FUNCTION IF EXISTS public.refund_invoice_atomic(text, text);

CREATE OR REPLACE FUNCTION public.refund_invoice_atomic(
  _invoice_number text,
  _source text DEFAULT 'online'::text,
  _shift_id uuid DEFAULT NULL::uuid,
  _currency text DEFAULT NULL::text,
  _currency_amount numeric DEFAULT NULL::numeric,
  _exchange_rate numeric DEFAULT NULL::numeric
)
RETURNS TABLE(
  success boolean,
  already_refunded boolean,
  invoice_id uuid,
  invoice_number text,
  invoice_total numeric,
  invoice_currency text,
  restored_item_count integer,
  restored_unit_count numeric,
  deleted_debt_amount numeric,
  customer_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _invoice public.invoices%ROWTYPE;
  _restored_items integer := 0;
  _restored_units numeric := 0;
  _deleted_debt numeric := 0;
  _has_refund boolean := false;
  _track_inventory boolean := true;
  _store_type text;
  _row record;
  _main constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  _cash_refund_amount numeric := 0;
  _tx_currency text := 'USD';
  _tx_currency_amount numeric := 0;
  _tx_exchange_rate numeric := 1;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _owner := public.get_owner_id(_caller);

  IF NOT public.can_refund_invoices(auth.uid()) THEN
    RAISE EXCEPTION 'ليست لديك صلاحية الاسترداد. اطلبها من مالك المتجر' USING ERRCODE = '42501';
  END IF;

  SELECT i.* INTO _invoice
  FROM public.invoices i
  WHERE i.invoice_number = _invoice_number AND i.user_id = _owner
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, NULL::uuid, _invoice_number, 0::numeric, NULL::text, 0, 0::numeric, 0::numeric, NULL::text;
    RETURN;
  END IF;

  IF COALESCE(_invoice.status, '') IN ('cancelled', 'written_off') THEN
    RAISE EXCEPTION 'لا يمكن استرداد فاتورة ملغاة أو مشطوبة';
  END IF;

  _cash_refund_amount := GREATEST(round(
    CASE
      WHEN COALESCE(_invoice.payment_type, 'cash') = 'debt'
        THEN LEAST(COALESCE(_invoice.total, 0), GREATEST(COALESCE(_invoice.debt_paid, 0), COALESCE(_invoice.paid_at_sale, 0)))
      ELSE COALESCE(_invoice.total, 0)
    END, 2), 0);

  IF _shift_id IS NOT NULL AND COALESCE(_invoice.payment_method, 'cash') = 'cash' AND _cash_refund_amount > 0 THEN
    _tx_currency := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
    IF _tx_currency <> 'USD' AND COALESCE(_currency_amount, 0) > 0 THEN
      IF COALESCE(_exchange_rate, 0) <= 0 THEN
        RAISE EXCEPTION 'سعر الصرف غير صالح للعملة %', _tx_currency;
      END IF;
      IF abs((_currency_amount / _exchange_rate) - _cash_refund_amount) > GREATEST(0.05, _cash_refund_amount * 0.02) THEN
        RAISE EXCEPTION 'عدم تطابق مبلغ الاسترداد بالعملة (%) مع سعر الصرف (%) والمبلغ بالدولار (%)', _currency_amount, _exchange_rate, _cash_refund_amount;
      END IF;
      _tx_currency_amount := round(_currency_amount, 4);
      _tx_exchange_rate := _exchange_rate;
    ELSIF _tx_currency <> 'USD' AND COALESCE(_exchange_rate, 0) > 0 THEN
      _tx_currency_amount := round(_cash_refund_amount * _exchange_rate, 4);
      _tx_exchange_rate := _exchange_rate;
    ELSE
      _tx_currency := 'USD';
      _tx_currency_amount := _cash_refund_amount;
      _tx_exchange_rate := 1;
    END IF;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.stock_movements sm
    WHERE sm.user_id = _owner AND sm.invoice_id = _invoice.id AND sm.movement_type = 'refund'
  ) INTO _has_refund;

  IF _invoice.status = 'refunded' OR _has_refund THEN
    IF _shift_id IS NOT NULL AND COALESCE(_invoice.payment_method, 'cash') = 'cash' AND _cash_refund_amount > 0 THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.shift_transactions st
        WHERE st.user_id = _owner
          AND st.type = 'refund'
          AND st.reference_id = _invoice.invoice_number
      ) THEN
        PERFORM 1 FROM public.cash_shifts
        WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL
        FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
        END IF;

        INSERT INTO public.shift_transactions(
          shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes
        ) VALUES (
          _shift_id, _owner, 'refund', _cash_refund_amount,
          _tx_currency, _tx_currency_amount, _tx_exchange_rate,
          _invoice.invoice_number,
          'استرداد فاتورة ' || _invoice.invoice_number
        )
        ON CONFLICT (shift_id, type, reference_id) DO NOTHING;

        IF FOUND THEN
          UPDATE public.cash_shifts
             SET expected_balance = round(COALESCE(expected_balance, 0) - _cash_refund_amount, 2),
                 updated_at = now()
           WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL;
        END IF;
      END IF;
    END IF;

    RETURN QUERY SELECT false, true, _invoice.id, _invoice.invoice_number, COALESCE(_invoice.total, 0)::numeric, _invoice.currency::text, 0, 0::numeric, 0::numeric, _invoice.customer_name::text;
    RETURN;
  END IF;

  PERFORM public.assert_period_open(_owner, _invoice.date, 'استرداد الفاتورة');

  IF _shift_id IS NOT NULL AND COALESCE(_invoice.payment_method, 'cash') = 'cash' AND _cash_refund_amount > 0 THEN
    PERFORM 1 FROM public.cash_shifts
    WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
    END IF;
  END IF;

  SELECT s.store_type INTO _store_type FROM public.stores s WHERE s.user_id = _owner ORDER BY s.created_at LIMIT 1;
  _track_inventory := NOT (COALESCE(_store_type, 'general') IN ('bakery', 'repair'));

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.refund_items(
    product_id uuid NOT NULL,
    warehouse_key uuid NOT NULL,
    quantity numeric(14,3) NOT NULL,
    PRIMARY KEY(product_id, warehouse_key)
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.refund_items;

  INSERT INTO pg_temp.refund_items(product_id, warehouse_key, quantity)
  SELECT
    ii.product_id,
    COALESCE(ii.stock_warehouse_id, _main),
    SUM(GREATEST(COALESCE(ii.quantity, 0), 0) * (CASE WHEN ii.unit = 'bulk' THEN GREATEST(COALESCE(ii.conversion_factor, 1), 1) ELSE 1 END))
  FROM public.invoice_items ii
  WHERE ii.invoice_id = _invoice.id AND ii.product_id IS NOT NULL
  GROUP BY ii.product_id, COALESCE(ii.stock_warehouse_id, _main)
  ON CONFLICT(product_id, warehouse_key) DO UPDATE SET quantity = pg_temp.refund_items.quantity + EXCLUDED.quantity;

  PERFORM set_config('app.stock_movement_type', 'refund', true);
  PERFORM set_config('app.stock_invoice_id', _invoice.id::text, true);
  PERFORM set_config('app.stock_invoice_number', _invoice.invoice_number, true);
  PERFORM set_config('app.stock_actor_id', _caller::text, true);
  PERFORM set_config('app.stock_source', CASE WHEN _source = 'offline-sync' THEN 'offline-sync' ELSE 'online' END, true);
  PERFORM set_config('app.refund_context', 'allowed', true);

  IF _track_inventory THEN
    FOR _row IN SELECT * FROM pg_temp.refund_items WHERE quantity > 0 LOOP
      IF _row.warehouse_key = _main THEN
        UPDATE public.products SET quantity = COALESCE(quantity, 0) + _row.quantity WHERE id = _row.product_id AND user_id = _owner;
      ELSE
        UPDATE public.warehouse_stock ws SET quantity = COALESCE(ws.quantity, 0) + _row.quantity, last_updated = now()
        WHERE ws.warehouse_id = _row.warehouse_key AND ws.product_id = _row.product_id;
        IF NOT FOUND THEN
          UPDATE public.products SET quantity = COALESCE(quantity, 0) + _row.quantity WHERE id = _row.product_id AND user_id = _owner;
        END IF;
      END IF;
    END LOOP;
    SELECT COUNT(*)::integer, COALESCE(SUM(quantity), 0)::numeric INTO _restored_items, _restored_units FROM pg_temp.refund_items WHERE quantity > 0;
  END IF;

  SELECT COALESCE(SUM(d.remaining_debt), 0)::numeric INTO _deleted_debt FROM public.debts d WHERE d.user_id = _owner AND (d.invoice_id = _invoice.invoice_number OR d.invoice_id = _invoice.id::text);

  UPDATE public.debts d SET status = 'cancelled', remaining_debt = 0, notes = concat_ws(E'\n', NULLIF(d.notes,''), 'ملغى بسبب مرتجع الفاتورة '||now()::text), updated_at = now() WHERE d.user_id = _owner AND (d.invoice_id = _invoice.invoice_number OR d.invoice_id = _invoice.id::text);

  IF _invoice.customer_id IS NOT NULL THEN
    UPDATE public.customers c SET total_purchases = s.total_purchases, total_debt = s.total_debt, invoice_count = s.invoice_count
    FROM (
      SELECT
        COALESCE(SUM(i.total) FILTER(WHERE i.id <> _invoice.id AND COALESCE(i.status, '') NOT IN ('refunded', 'cancelled')), 0)::numeric AS total_purchases,
        COALESCE(SUM(i.debt_remaining) FILTER(WHERE i.id <> _invoice.id AND COALESCE(i.status, '') NOT IN ('refunded', 'cancelled', 'paid') AND i.payment_type = 'debt'), 0)::numeric AS total_debt,
        COUNT(*) FILTER(WHERE i.id <> _invoice.id AND COALESCE(i.status, '') NOT IN ('refunded', 'cancelled'))::integer AS invoice_count
      FROM public.invoices i
      WHERE i.user_id = _owner AND i.customer_id = _invoice.customer_id
    ) s
    WHERE c.id = _invoice.customer_id AND c.user_id = _owner;
    PERFORM public.recalc_customer_open_debt(_owner, _invoice.customer_id);
  END IF;

  UPDATE public.invoice_items ii SET profit = 0 WHERE ii.invoice_id = _invoice.id;

  UPDATE public.invoices
  SET status = 'refunded',
      profit = 0,
      debt_remaining = 0,
      notes = concat_ws(E'\n', NULLIF(_invoice.notes, ''), 'Refunded at ' || now()::text),
      updated_at = now()
  WHERE id = _invoice.id;

  PERFORM public.revert_invoice_partner_profits_atomic(_invoice.id, 1.0);

  IF _shift_id IS NOT NULL AND COALESCE(_invoice.payment_method, 'cash') = 'cash' AND _cash_refund_amount > 0 THEN
    INSERT INTO public.shift_transactions(
      shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes
    ) VALUES (
      _shift_id, _owner, 'refund', _cash_refund_amount,
      _tx_currency, _tx_currency_amount, _tx_exchange_rate,
      _invoice.invoice_number,
      'استرداد فاتورة ' || _invoice.invoice_number
    )
    ON CONFLICT (shift_id, type, reference_id) DO NOTHING;

    IF FOUND THEN
      UPDATE public.cash_shifts
         SET expected_balance = round(COALESCE(expected_balance, 0) - _cash_refund_amount, 2),
             updated_at = now()
       WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL;
    END IF;
  END IF;

  INSERT INTO public.activity_log(user_id, actor_id, actor_name, actor_role, action_type, entity_type, entity_id, entity_name, description, metadata)
  SELECT
    _owner, _caller, COALESCE(p.full_name, _invoice.cashier_name, 'مستخدم'), ur.role::text,
    'invoice_refunded', 'invoice', _invoice.id::text, _invoice.invoice_number,
    'تم استرداد الفاتورة ' || _invoice.invoice_number,
    jsonb_build_object(
      'invoice_number', _invoice.invoice_number,
      'invoice_total', COALESCE(_invoice.total, 0),
      'invoice_currency', _invoice.currency,
      'cash_refund_amount', _cash_refund_amount,
      'shift_id', _shift_id,
      'restored_items', _restored_items,
      'restored_units', _restored_units,
      'deleted_debt_amount', _deleted_debt,
      'source', CASE WHEN _source = 'offline-sync' THEN 'offline-sync' ELSE 'online' END
    )
  FROM (SELECT 1) seed
  LEFT JOIN public.profiles p ON p.user_id = _caller
  LEFT JOIN public.user_roles ur ON ur.user_id = _caller
  LIMIT 1;

  RETURN QUERY SELECT true, false, _invoice.id, _invoice.invoice_number, COALESCE(_invoice.total, 0)::numeric, _invoice.currency::text, _restored_items, _restored_units, _deleted_debt, _invoice.customer_name::text;
END;
$function$;

-- 2. public.record_debt_payment_atomic
DROP FUNCTION IF EXISTS public.record_debt_payment_atomic(uuid, numeric, text, uuid);

CREATE OR REPLACE FUNCTION public.record_debt_payment_atomic(
  _debt_id uuid,
  _amount numeric,
  _operation_id text,
  _shift_id uuid DEFAULT NULL::uuid,
  _currency text DEFAULT NULL::text,
  _currency_amount numeric DEFAULT NULL::numeric,
  _exchange_rate numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid := public.get_owner_id(auth.uid());
  v_debt public.debts%ROWTYPE;
  v_amount numeric := round(COALESCE(_amount, 0)::numeric, 4);
  v_cash_amount numeric := round(COALESCE(_amount, 0)::numeric, 2);
  v_settlement numeric;
  v_prev_remaining numeric;
  v_new_remaining numeric;
  v_new_total_paid numeric;
  v_rounding_note text := '';
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

  PERFORM public.assert_period_open(v_owner, CURRENT_DATE, 'تسديد دين');

  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'أدخل مبلغًا صحيحًا أكبر من الصفر';
  END IF;

  v_prev_remaining := round(COALESCE(v_debt.remaining_debt, v_debt.total_debt - COALESCE(v_debt.total_paid, 0))::numeric, 4);

  IF v_amount > v_prev_remaining + 0.005 THEN
    RAISE EXCEPTION 'المبلغ المدخل (%) أكبر من المتبقي (%)', v_amount, v_prev_remaining;
  END IF;

  IF abs(v_prev_remaining - v_amount) <= 0.005 THEN
    v_settlement := v_prev_remaining;
    v_new_remaining := 0;
    v_new_total_paid := v_debt.total_debt;
    IF abs(v_prev_remaining - v_cash_amount) > 0 THEN
      v_rounding_note := ' (تعديل تقريب: ' || round(v_prev_remaining - v_cash_amount, 4)::text || ' USD)';
    END IF;
  ELSE
    v_settlement := v_amount;
    v_new_remaining := GREATEST(round(v_prev_remaining - v_amount, 4), 0);
    v_new_total_paid := round(COALESCE(v_debt.total_paid, 0) + v_amount, 4);
  END IF;

  IF _shift_id IS NOT NULL THEN
    PERFORM 1 FROM public.cash_shifts
     WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL
       FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
    END IF;

    v_tx_currency := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
    IF v_tx_currency <> 'USD' AND COALESCE(_currency_amount, 0) > 0 THEN
      IF COALESCE(_exchange_rate, 0) <= 0 THEN
        RAISE EXCEPTION 'سعر الصرف غير صالح للعملة %', v_tx_currency;
      END IF;
      IF abs((_currency_amount / _exchange_rate) - v_cash_amount) > GREATEST(0.05, v_cash_amount * 0.02) THEN
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
  END IF;

  UPDATE public.debts
     SET total_paid = v_new_total_paid,
         remaining_debt = v_new_remaining,
         status = CASE WHEN v_new_remaining <= 0 THEN 'fully_paid' ELSE 'partially_paid' END,
         notes = CASE WHEN v_rounding_note <> '' THEN concat_ws(E'\n', NULLIF(notes, ''), 'تسديد دين' || v_rounding_note) ELSE notes END,
         updated_at = now()
   WHERE id = _debt_id
  RETURNING * INTO v_debt;

  INSERT INTO public.debt_payments(user_id, debt_id, operation_id, amount, paid_by, shift_id)
  VALUES (v_owner, _debt_id, _operation_id, v_cash_amount, auth.uid(), _shift_id);

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
      SELECT id INTO v_resolved_customer_id
        FROM public.customers
       WHERE user_id = v_owner
         AND name = v_debt.customer_name
       ORDER BY created_at ASC
       LIMIT 1;
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
    'confirmed_profit', _total_confirmed
  );
END;
$function$;

-- 3. public.writeoff_debt_atomic
CREATE OR REPLACE FUNCTION public.writeoff_debt_atomic(
  _debt_id uuid,
  _reason text,
  _operation_id text
)
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
            _part := round(_cat_loss * (_cat_share->>'percentage')::numeric / 100.0, 4);
            IF _part > 0 THEN
              _remaining_loss := _remaining_loss - _part;
              _partners_total := _partners_total + _part;

              UPDATE public.partners SET
                confirmed_profit = round(COALESCE(confirmed_profit, 0) - _part, 4),
                current_balance = round(COALESCE(current_balance, 0) - _part, 4),
                total_profit_earned = round(COALESCE(total_profit_earned, 0) - _part, 4),
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
          _part := round(_remaining_loss * _partner.share_percentage / 100.0, 4);
          IF _part > 0 THEN
            _partners_total := _partners_total + _part;

            UPDATE public.partners SET
              confirmed_profit = round(COALESCE(confirmed_profit, 0) - _part, 4),
              current_balance = round(COALESCE(current_balance, 0) - _part, 4),
              total_profit_earned = round(COALESCE(total_profit_earned, 0) - _part, 4),
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
$function$;

-- 4. public.cancel_debt_atomic
CREATE OR REPLACE FUNCTION public.cancel_debt_atomic(
  _debt_id uuid,
  _reason text DEFAULT 'إلغاء الدين'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_owner uuid := public.get_owner_id(auth.uid());
  v_debt public.debts%ROWTYPE;
  v_resolved_customer_id uuid;
BEGIN
  IF v_caller IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(v_caller) THEN
    RAISE EXCEPTION 'إلغاء الدين مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_debt FROM public.debts WHERE id = _debt_id FOR UPDATE;
  IF NOT FOUND OR v_debt.user_id <> v_owner THEN
    RAISE EXCEPTION 'الدين غير موجود';
  END IF;

  IF v_debt.status IN ('cancelled', 'written_off') THEN
    RETURN jsonb_build_object('success', true, 'already_closed', true, 'debt_id', _debt_id);
  END IF;

  IF v_debt.status = 'fully_paid' OR COALESCE(v_debt.total_paid, 0) > 0 THEN
    RAISE EXCEPTION 'لا يمكن إلغاء دين تم تسديده كلياً أو جزئياً';
  END IF;

  PERFORM public.assert_period_open(v_owner, CURRENT_DATE, 'إلغاء دين');

  IF v_debt.invoice_id IS NOT NULL AND NOT COALESCE(v_debt.is_cash_debt, false)
     AND EXISTS (SELECT 1 FROM public.invoices i
                  WHERE i.user_id = v_owner
                    AND (i.invoice_number = v_debt.invoice_id OR i.id::text = v_debt.invoice_id)
                    AND COALESCE(i.status, '') NOT IN ('refunded', 'cancelled')) THEN
    RAISE EXCEPTION 'هذا الدين مرتبط بالفاتورة %: استخدم «تسديد» إذا دفع العميل، أو «استرداد الفاتورة» إذا أُلغي البيع، أو «شطب الدين» إذا تعذر التحصيل', v_debt.invoice_id;
  END IF;

  UPDATE public.debts
     SET status = 'cancelled',
         notes = concat_ws(E'\n', notes, '[ملغى] ' || COALESCE(_reason, 'إلغاء الدين')),
         updated_at = now()
   WHERE id = _debt_id;

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
      SELECT id INTO v_resolved_customer_id
        FROM public.customers
       WHERE user_id = v_owner
         AND name = v_debt.customer_name
       ORDER BY created_at ASC
       LIMIT 1;
    END IF;
  END IF;

  IF v_resolved_customer_id IS NOT NULL THEN
    PERFORM public.recalc_customer_open_debt(v_owner, v_resolved_customer_id);
  END IF;

  RETURN jsonb_build_object('success', true, 'debt_id', _debt_id, 'cancelled_amount', COALESCE(v_debt.remaining_debt, 0));
END;
$function$;

-- 5. public.add_expense_atomic
CREATE OR REPLACE FUNCTION public.add_expense_atomic(
  _operation_id text,
  _expense_type text,
  _amount numeric,
  _description text DEFAULT NULL::text,
  _date date DEFAULT CURRENT_DATE,
  _notes text DEFAULT NULL::text
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
    _op_uuid := md5(_owner::text || ':expense:' || trim(_operation_id))::uuid;
  END;

  IF EXISTS (SELECT 1 FROM public.expenses WHERE id = _op_uuid) THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'id', _op_uuid);
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
    id, user_id, expense_type, amount, description, date, notes, distributions, cashier_id
  ) VALUES (
    _op_uuid, _owner, _expense_type, _amt, _description, coalesce(_date, CURRENT_DATE), _notes, _dist, _uid
  );

  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'id', _op_uuid,
    'distributions', _dist
  );
END;
$function$;

-- 6. public.delete_expense_atomic
CREATE OR REPLACE FUNCTION public.delete_expense_atomic(
  _expense_id uuid,
  _reason text DEFAULT 'إلغاء مصروف'::text
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
BEGIN
  PERFORM set_config('app.partner_source', 'delete_expense_atomic', true);
  IF _caller IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  SELECT * INTO _exp FROM public.expenses WHERE id = _expense_id AND user_id = _owner FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'المصروف غير موجود');
  END IF;

  IF COALESCE(_exp.is_reversed, false) = true THEN
    RETURN jsonb_build_object('success', true, 'already_reversed', true);
  END IF;

  PERFORM public.assert_period_open(_owner, _exp.date, 'حذف المصروف');

  SELECT st.amount, st.currency, st.currency_amount, st.exchange_rate
    INTO _orig_tx
    FROM public.shift_transactions st
   WHERE st.user_id = _owner
     AND st.type = 'expense'
     AND st.reference_id = _expense_id::text
   ORDER BY st.created_at DESC
   LIMIT 1;

  IF FOUND THEN
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

  UPDATE public.expenses SET
    is_reversed = true,
    reversed_at = now(),
    reversed_by = _caller,
    reversed_reason = _reason
  WHERE id = _expense_id;

  RETURN jsonb_build_object('success', true, 'expense_id', _expense_id, 'amount', _exp.amount, 'expense_type', _exp.expense_type);
END;
$function$;

REVOKE ALL ON FUNCTION public.refund_invoice_atomic(text, text, uuid, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refund_invoice_atomic(text, text, uuid, text, numeric, numeric) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.record_debt_payment_atomic(uuid, numeric, text, uuid, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_debt_payment_atomic(uuid, numeric, text, uuid, text, numeric, numeric) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.writeoff_debt_atomic(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.writeoff_debt_atomic(uuid, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.cancel_debt_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_debt_atomic(uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.add_expense_atomic(text, text, numeric, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_expense_atomic(text, text, numeric, text, date, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.delete_expense_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_expense_atomic(uuid, text) TO authenticated, service_role;
