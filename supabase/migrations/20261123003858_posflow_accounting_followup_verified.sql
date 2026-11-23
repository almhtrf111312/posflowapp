-- PosFlow accounting follow-up. Preserve existing RPC signatures.

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

CREATE OR REPLACE FUNCTION public.cancel_purchase_invoice_atomic(
  _invoice_id uuid,
  _reason text DEFAULT 'إلغاء فاتورة شراء'::text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _orig_inv record;
  _old_item record;
  _no_inventory boolean := false;
  _cur_stock numeric;
  _cur_cost numeric;
  _new_stock numeric;
  _new_cost numeric;
  _calc_cost numeric;
  _rem_val numeric;
  v_variance numeric := 0;
  _has_subsequent_sale boolean := false;
  _has_newer_purchase boolean := false;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'إلغاء فاتورة الشراء مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _orig_inv
    FROM public.purchase_invoices
   WHERE id = _invoice_id AND user_id = _owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'فاتورة المشتريات غير موجودة';
  END IF;

  IF _orig_inv.status = 'cancelled' OR _orig_inv.payment_status = 'cancelled' THEN
    RETURN true;
  END IF;

  PERFORM public.assert_period_open(_owner, _orig_inv.invoice_date, 'إلغاء فاتورة الشراء');

  -- Draft / reconciled invoices never modified stock, WAC, serials, or supplier ledger
  IF COALESCE(_orig_inv.status, 'draft') IN ('draft', 'reconciled') THEN
    UPDATE public.purchase_invoices
       SET status = 'cancelled',
           payment_status = 'cancelled',
           notes = concat_ws(E'\n', notes, '[ملغاة] ' || COALESCE(_reason, 'إلغاء الفاتورة')),
           updated_at = now()
     WHERE id = _invoice_id;
    RETURN true;
  END IF;

  IF EXISTS (SELECT 1 FROM public.purchase_returns WHERE invoice_id = _invoice_id) THEN
    RAISE EXCEPTION 'لا يمكن إلغاء فاتورة لها مرتجعات';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.product_serials
     WHERE purchase_invoice_id = _invoice_id
       AND user_id = _owner
       AND status <> 'in_stock'
  ) THEN
    RAISE EXCEPTION 'لا يمكن إلغاء الفاتورة: بعض أرقامها التسلسلية بيعت أو أُخرجت';
  END IF;

  SELECT COALESCE(s.store_type, 'general') IN ('bakery', 'repair')
    INTO _no_inventory
    FROM public.stores s
   WHERE s.user_id = _owner
   LIMIT 1;
  _no_inventory := COALESCE(_no_inventory, false);

  FOR _old_item IN
    SELECT * FROM public.purchase_invoice_items
     WHERE invoice_id = _invoice_id
  LOOP
    IF _old_item.product_id IS NOT NULL THEN
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
            RAISE EXCEPTION 'لا يمكن إلغاء الفاتورة: جزء من كمية "%" بيع أو أُخرج من المخزون', _old_item.product_name;
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
            -- Perpetual moving average (IAS 2): keep current WAC when intervening sales expensed COGS
            _new_cost := COALESCE(_cur_cost, 0);
          ELSIF _new_stock > 0 AND _rem_val > 0 THEN
            _calc_cost := round(_rem_val / _new_stock, 8);
            IF _calc_cost > GREATEST(COALESCE(_cur_cost, 0), COALESCE(_old_item.cost_price_before, COALESCE(_cur_cost, 0)))
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

          v_variance := round((_new_stock * _new_cost) - _rem_val, 4);
          IF v_variance <> 0 THEN
            INSERT INTO public.inventory_valuation_adjustments(
              user_id, source_type, source_id, product_id, variance_usd, notes
            ) VALUES (
              _owner,
              'purchase_cancel',
              _invoice_id,
              _old_item.product_id,
              v_variance,
              'فرق تقييم مخزون عند إلغاء فاتورة الشراء ' || COALESCE(_orig_inv.invoice_number, '')
            );
          END IF;

          PERFORM set_config('app.stock_movement_type', 'purchase_reversal', true);
          PERFORM set_config('app.stock_source', 'cancel_purchase_invoice', true);
          UPDATE public.products
             SET quantity = _new_stock,
                 cost_price = _new_cost,
                 updated_at = now()
           WHERE id = _old_item.product_id;
        END IF;
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, created_by)
  SELECT user_id, supplier_id, 'adjustment', -amount, 'purchase_cancel', reference_id, 'عكس بسبب إلغاء الفاتورة', _caller
    FROM public.supplier_ledger_entries
   WHERE reference_type = 'purchase_invoice'
     AND reference_id = _invoice_id::text
     AND entry_type IN ('purchase', 'payment');

  IF COALESCE(_orig_inv.amount_paid, 0) > 0 AND _orig_inv.paid_from = 'drawer' THEN
    DECLARE
      _t record;
      _open_shift_id uuid;
    BEGIN
      IF _orig_inv.paid_shift_id IS NOT NULL THEN
        SELECT id INTO _open_shift_id
          FROM public.cash_shifts
         WHERE id = _orig_inv.paid_shift_id
           AND user_id = _owner
           AND closed_at IS NULL
           FOR UPDATE;
      END IF;

      IF _open_shift_id IS NULL THEN
        RAISE EXCEPTION 'يجب تسوية دفعة المورد بشكل مستقل إذا كانت ورديتها الأصلية مفقودة أو مغلقة';
      END IF;

      SELECT currency, currency_amount, exchange_rate INTO _t
        FROM public.shift_transactions
       WHERE user_id = _owner AND shift_id = _open_shift_id
         AND reference_id = 'purchase:' || _invoice_id::text
         AND type = 'supplier_payment'
       LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'حركة الدفعة الأصلية للمورد غير موجودة';
      END IF;

      PERFORM public._supplier_drawer_tx(
        _owner,
        _open_shift_id,
        'supplier_refund',
        _orig_inv.amount_paid,
        COALESCE(_t.currency, _orig_inv.paid_currency),
        COALESCE(_t.currency_amount, _orig_inv.paid_currency_amount),
        COALESCE(_t.exchange_rate, _orig_inv.paid_rate),
        'purchase_cancel:' || _invoice_id::text,
        'إلغاء فاتورة شراء ' || COALESCE(_orig_inv.invoice_number, '')
      );
    END;
  END IF;

  UPDATE public.product_serials
     SET status = 'returned_to_supplier', updated_at = now()
   WHERE purchase_invoice_id = _invoice_id AND user_id = _owner AND status = 'in_stock';

  UPDATE public.purchase_invoices
     SET status = 'cancelled',
         payment_status = 'cancelled',
         notes = concat_ws(E'\n', notes, '[ملغاة] ' || COALESCE(_reason, 'إلغاء الفاتورة')),
         updated_at = now()
   WHERE id = _invoice_id;

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.close_accounting_period_atomic(
  _period_start date,
  _period_end date,
  _timezone text DEFAULT 'UTC'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _tz text := COALESCE(NULLIF(trim(_timezone), ''), 'UTC');
  _rev numeric := 0;
  _cogs numeric := 0;
  _exp numeric := 0;
  _gross numeric := 0;
  _realized numeric := 0;
  _pending numeric := 0;
  _bad_debt numeric := 0;
  _net numeric := 0;
  _partner_summary jsonb := '[]'::jsonb;
  _closure_id uuid;
  p record;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'إقفال الفترة مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  BEGIN
    PERFORM now() AT TIME ZONE _tz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'المنطقة الزمنية غير صحيحة: %', _tz;
  END;

  IF _period_start IS NULL OR _period_end IS NULL OR _period_start > _period_end THEN
    RAISE EXCEPTION 'تواريخ الفترة غير صحيحة';
  END IF;
  IF _period_end >= (now() AT TIME ZONE _tz)::date THEN
    RAISE EXCEPTION 'لا يمكن إقفال فترة لم تنتهِ بعد';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('close_accounting_period:' || _owner::text));

  IF EXISTS (
    SELECT 1 FROM public.accounting_period_closures c
    WHERE c.user_id = _owner
      AND c.period_start <= _period_end
      AND c.period_end >= _period_start
  ) THEN
    RAISE EXCEPTION 'هذه الفترة تتداخل مع فترة مقفلة سابقاً';
  END IF;

  WITH inv AS (
    SELECT i.id, i.invoice_number,
           (i.created_at AT TIME ZONE _tz)::date AS sale_day,
           COALESCE(i.total, 0) AS total,
           COALESCE(i.tax_amount, 0) AS tax,
           COALESCE(i.profit, 0) AS profit,
           GREATEST(COALESCE(i.paid_at_sale, 0), 0) AS paid_at_sale,
           i.payment_type, i.status,
           CASE WHEN i.status = 'paid' THEN COALESCE(i.total, 0)
                ELSE LEAST(GREATEST(COALESCE(i.debt_paid, 0), 0), COALESCE(i.total, 0)) END AS paid_by_invoice
      FROM public.invoices i
     WHERE i.user_id = _owner
       AND i.status NOT IN ('refunded', 'cancelled')
       AND COALESCE(i.invoice_type, 'sale') IN ('sale', 'maintenance')
  ),
  credit AS (
    SELECT * FROM inv WHERE payment_type = 'debt' AND total > 0
  ),
  pay_exists AS (
    SELECT DISTINCT c.id AS invoice_id
      FROM credit c
      JOIN public.debts d
        ON d.user_id = _owner
       AND NOT COALESCE(d.is_cash_debt, false)
       AND (d.invoice_id = c.invoice_number OR d.invoice_id = c.id::text)
      JOIN public.debt_payments dp ON dp.debt_id = d.id
     WHERE COALESCE(dp.amount, 0) > 0
  ),
  pay AS (
    SELECT c.id AS invoice_id,
           dp.amount,
           (dp.created_at AT TIME ZONE _tz)::date AS pay_day,
           SUM(dp.amount) OVER (PARTITION BY c.id ORDER BY dp.created_at, dp.id) - dp.amount AS paid_before
      FROM credit c
      JOIN public.debts d
        ON d.user_id = _owner
       AND NOT COALESCE(d.is_cash_debt, false)
       AND (d.invoice_id = c.invoice_number OR d.invoice_id = c.id::text)
      JOIN public.debt_payments dp ON dp.debt_id = d.id
     WHERE COALESCE(dp.amount, 0) > 0
       AND (dp.created_at AT TIME ZONE _tz)::date <= _period_end
  ),
  credit_paid AS (
    SELECT c.*,
           CASE
             WHEN pe.invoice_id IS NOT NULL THEN LEAST(c.total, COALESCE(c.paid_at_sale, 0) + COALESCE(ds.dated_sum, 0))
             ELSE c.paid_by_invoice
           END AS paid_total,
           COALESCE(ds.dated_sum, 0) AS dated_sum,
           EXISTS (
              SELECT 1 FROM public.debt_writeoffs w
               LEFT JOIN public.debts wd ON wd.id = w.debt_id
              WHERE w.user_id = _owner
                AND (w.written_off_at AT TIME ZONE _tz)::date <= _period_end
                AND COALESCE(wd.invoice_id, w.notes) IN (c.invoice_number, c.id::text)
                AND NOT COALESCE(wd.is_cash_debt, false)
           ) AS is_written_off
      FROM credit c
      LEFT JOIN (SELECT invoice_id, SUM(amount) AS dated_sum FROM pay GROUP BY invoice_id) ds
        ON ds.invoice_id = c.id
      LEFT JOIN pay_exists pe
        ON pe.invoice_id = c.id
  ),
  alloc AS (
    SELECT pm.pay_day,
           GREATEST(0, LEAST(pm.amount, cp.paid_total - pm.paid_before)) AS amount,
           cp.profit, cp.total
      FROM pay pm
      JOIN credit_paid cp ON cp.id = pm.invoice_id
  )
  SELECT
    COALESCE((SELECT SUM(total - tax) FROM inv
               WHERE sale_day BETWEEN _period_start AND _period_end), 0),
    COALESCE((SELECT SUM(profit) FROM inv
               WHERE NOT (payment_type IS NOT DISTINCT FROM 'debt' AND total > 0)
                 AND sale_day BETWEEN _period_start AND _period_end), 0)
    + COALESCE((SELECT SUM(profit * (paid_total - LEAST(dated_sum, paid_total)) / total) FROM credit_paid
                 WHERE sale_day BETWEEN _period_start AND _period_end), 0)
    + COALESCE((SELECT SUM(profit * amount / total) FROM alloc
                 WHERE pay_day BETWEEN _period_start AND _period_end), 0),
    COALESCE((SELECT SUM(profit * (total - paid_total) / total) FROM credit_paid
               WHERE NOT is_written_off AND sale_day <= _period_end), 0)
    INTO _rev, _realized, _pending;

  SELECT
    COALESCE(SUM(COALESCE(ii.cost_price, 0) * COALESCE(ii.quantity, 0)), 0)
    INTO _cogs
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE i.user_id = _owner
     AND i.status NOT IN ('refunded', 'cancelled')
     AND COALESCE(i.invoice_type, 'sale') IN ('sale', 'maintenance')
     AND (i.created_at AT TIME ZONE _tz)::date BETWEEN _period_start AND _period_end;

  SELECT COALESCE(SUM(
    CASE WHEN e.date BETWEEN _period_start AND _period_end THEN e.amount ELSE 0 END
    - CASE WHEN e.is_reversed AND (e.reversed_at AT TIME ZONE _tz)::date
                     BETWEEN _period_start AND _period_end THEN e.amount ELSE 0 END
  ), 0)
    INTO _exp
    FROM public.expenses e
   WHERE e.user_id = _owner
     AND (e.date BETWEEN _period_start AND _period_end
          OR (e.is_reversed AND (e.reversed_at AT TIME ZONE _tz)::date
                    BETWEEN _period_start AND _period_end))
     AND (NOT COALESCE(e.is_reversed, false) OR e.reversed_at IS NOT NULL);


  SELECT COALESCE(SUM(
           COALESCE(
             w.loss_amount,
             CASE WHEN x.total > 0
                  THEN COALESCE(w.amount, 0) - x.profit * LEAST(COALESCE(w.amount, 0), x.total) / x.total
                  ELSE COALESCE(w.amount, 0) END
           )), 0)
    INTO _bad_debt
    FROM public.debt_writeoffs w
    LEFT JOIN public.debts d ON d.id = w.debt_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(i.total, 0) AS total, COALESCE(i.profit, 0) AS profit, i.status
        FROM public.invoices i
       WHERE i.user_id = _owner
         AND NOT COALESCE(d.is_cash_debt, false)
         AND COALESCE(d.invoice_id, w.notes) IS NOT NULL
         AND (i.invoice_number = COALESCE(d.invoice_id, w.notes) OR i.id::text = COALESCE(d.invoice_id, w.notes))
       ORDER BY i.created_at
       LIMIT 1
    ) x ON true
   WHERE w.user_id = _owner
     AND (w.written_off_at AT TIME ZONE _tz)::date BETWEEN _period_start AND _period_end
     AND COALESCE(x.status, '') NOT IN ('refunded', 'cancelled');

  _rev := round(_rev, 8);
  _cogs := round(_cogs, 8);
  _exp := round(_exp, 8);
  _gross := round(_rev - _cogs, 8);
  _realized := round(_realized, 8);
  _pending := round(_pending, 8);
  _bad_debt := round(_bad_debt, 8);
  _net := round(_realized - _exp - _bad_debt, 8);

  FOR p IN
    SELECT
      pr.id,
      pr.name,
      round(COALESCE(pr.current_balance, 0) - COALESCE(post.d_current_balance, 0), 8) AS current_balance,
      round(COALESCE(pr.confirmed_profit, 0) - COALESCE(post.d_confirmed_profit, 0), 8) AS confirmed_profit,
      round(COALESCE(pr.total_profit_earned, 0) - COALESCE(post.d_total_profit_earned, 0), 8) AS total_profit_earned
    FROM public.partners pr
    LEFT JOIN LATERAL (
      SELECT
        SUM(ple.d_current_balance) AS d_current_balance,
        SUM(ple.d_confirmed_profit) AS d_confirmed_profit,
        SUM(ple.d_total_profit_earned) AS d_total_profit_earned
      FROM public.partner_ledger_entries ple
      WHERE ple.user_id = _owner
        AND ple.partner_id = pr.id
        AND ple.created_at >= ((_period_end + 1)::timestamp AT TIME ZONE _tz)
    ) post ON true
    WHERE pr.user_id = _owner
  LOOP
    _partner_summary := _partner_summary || jsonb_build_object(
      'partner_id', p.id,
      'partner_name', p.name,
      'current_balance', p.current_balance,
      'confirmed_profit', p.confirmed_profit,
      'total_earned', p.total_profit_earned
    );
  END LOOP;

  INSERT INTO public.accounting_period_closures (
    user_id, period_start, period_end, total_revenue, total_cogs,
    gross_profit, total_expenses, net_profit, partner_distributions, closed_by,
    realized_profit, pending_profit, bad_debt_loss, closing_timezone
  ) VALUES (
    _owner, _period_start, _period_end, _rev, _cogs,
    _gross, _exp, _net, _partner_summary, _caller,
    _realized, _pending, _bad_debt, _tz
  ) RETURNING id INTO _closure_id;

  RETURN jsonb_build_object(
    'success', true,
    'closure_id', _closure_id,
    'period_start', _period_start,
    'period_end', _period_end,
    'timezone', _tz,
    'revenue', _rev,
    'cogs', _cogs,
    'gross_profit', _gross,
    'realized_profit', _realized,
    'pending_profit', _pending,
    'expenses', _exp,
    'bad_debt_loss', _bad_debt,
    'net_profit', _net,
    'partners', _partner_summary
  );
END;
$function$;

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

  IF _orig_amt <= 0 OR _orig_amt::text IN ('NaN','Infinity','-Infinity')
     OR _orig_rate::text IN ('NaN','Infinity','-Infinity')
     OR abs(_orig_amt / _orig_rate - _amt) > 0.05 THEN
    RAISE EXCEPTION 'مبلغ المصروف الأصلي لا يطابق القيمة الدفترية وسعر الصرف';
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

CREATE OR REPLACE FUNCTION public.refund_invoice_partial_atomic(
  _invoice_number text,
  _items jsonb,
  _operation_id text,
  _shift_id uuid DEFAULT NULL::uuid,
  _currency text DEFAULT NULL::text,
  _currency_amount numeric DEFAULT NULL::numeric,
  _exchange_rate numeric DEFAULT NULL::numeric,
  _settlement_mode text DEFAULT 'drawer'::text
)
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
  _track_inventory := NOT (COALESCE(_store_type, 'general') IN ('bakery', 'repair'));

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

  -- Without allocation to original receipts, a mixed tender cannot be reversed safely.
  IF _inv.payment_type = 'debt' AND _paid_red > 0 AND EXISTS (
    SELECT 1
    FROM public.debt_payments dp
    JOIN public.debts d ON d.id = dp.debt_id AND d.user_id = _owner
    WHERE dp.user_id = _owner
      AND d.invoice_id IN (_inv.invoice_number, _inv.id::text)
      AND NOT COALESCE(d.is_cash_debt, false)
      AND (dp.settled_amount IS NULL
           OR (dp.payment_method = 'cash' AND dp.shift_id IS NULL)
           OR COALESCE(dp.payment_method, '') IS DISTINCT FROM
              CASE WHEN _inv.payment_method = 'digital' THEN 'transfer' ELSE 'cash' END
           OR upper(COALESCE(dp.currency, 'USD')) IS DISTINCT FROM upper(COALESCE(_inv.currency, 'USD'))
           OR COALESCE(dp.exchange_rate, 1) IS DISTINCT FROM COALESCE(_inv.exchange_rate, 1))
  ) THEN
    RAISE EXCEPTION 'يتطلب هذا المرتجع مطابقة الدفعات الأصلية ووسائل القبض قبل رد المبلغ';
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
      _shift_id, _owner, 'refund', round(_cash, 4), _ccy_amt, _ccy, _rate,
      'استرداد جزئي للفاتورة ' || _inv.invoice_number,
      _shift_ref
    )
    ON CONFLICT (shift_id, type, reference_id) DO NOTHING;

    GET DIAGNOSTICS _inserted = ROW_COUNT;
    IF _inserted > 0 THEN
      UPDATE public.cash_shifts
      SET expected_balance = round(COALESCE(expected_balance, 0) - _cash, 4),
          updated_at = now()
      WHERE id = _shift_id;
      _drawer_tx_recorded := true;
      _drawer_refund_usd := round(_cash, 4);
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
      -round(_profit_red, 4),
      -round(_cogs, 4),
      -round(_refund, 4),
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
$function$;


-- Review draft. Apply after 20261123060000 in an isolated database first.

-- Signed purchase valuation variances belong to the journal posting date.
-- NULL identifies previously closed snapshots that did not contain this total.
ALTER TABLE public.accounting_period_closures
  ADD COLUMN IF NOT EXISTS inventory_valuation_adjustment numeric(24, 8);

DROP POLICY IF EXISTS inv_val_adj_insert_owner ON public.inventory_valuation_adjustments;
REVOKE ALL ON TABLE public.inventory_valuation_adjustments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.inventory_valuation_adjustments TO authenticated;

ALTER TABLE public.inventory_valuation_adjustments ALTER COLUMN created_at SET DEFAULT clock_timestamp();

CREATE OR REPLACE FUNCTION public._guard_inventory_valuation_posting()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.variance_usd::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'فرق تقييم المخزون غير صالح';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtext('close_accounting_period:' || NEW.user_id::text));
  IF EXISTS (
    SELECT 1 FROM public.accounting_period_closures p
     WHERE p.user_id = NEW.user_id
       AND (NEW.created_at AT TIME ZONE COALESCE(p.closing_timezone, 'UTC'))::date
           BETWEEN p.period_start AND p.period_end
  ) THEN
    RAISE EXCEPTION 'فرق تقييم المخزون يقع في فترة محاسبية مغلقة';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public._guard_inventory_valuation_posting() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_inventory_valuation_posting ON public.inventory_valuation_adjustments;
CREATE TRIGGER trg_guard_inventory_valuation_posting
BEFORE INSERT ON public.inventory_valuation_adjustments
FOR EACH ROW EXECUTE FUNCTION public._guard_inventory_valuation_posting();

CREATE OR REPLACE FUNCTION public._inventory_valuation_for_period(
  _owner uuid, _period_start date, _period_end date, _timezone text
)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT round(COALESCE(SUM(a.variance_usd), 0), 8)
    FROM public.inventory_valuation_adjustments a
   WHERE a.user_id = _owner
     AND a.source_type IN ('purchase_return', 'purchase_cancel', 'purchase_edit')
     AND a.created_at >= (_period_start::timestamp AT TIME ZONE _timezone)
     AND a.created_at < ((_period_end + 1)::timestamp AT TIME ZONE _timezone);
$function$;
REVOKE ALL ON FUNCTION public._inventory_valuation_for_period(uuid, date, date, text) FROM PUBLIC, anon, authenticated;

-- A finalized replacement can carry a payment made against an earlier invoice.
-- Resolve the actual drawer entry from owned invoice ancestry and reject ambiguity.
CREATE OR REPLACE FUNCTION public._purchase_drawer_payment_for_cancellation(
  _owner uuid, _invoice_id uuid, _paid_amount numeric
)
RETURNS SETOF public.shift_transactions
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  _invoice_ids text[];
  _requires_drawer boolean;
  _payments public.shift_transactions[];
  _payment public.shift_transactions%ROWTYPE;
  _currency text;
BEGIN
  WITH RECURSIVE invoice_family AS (
    SELECT id, paid_from, amount_paid FROM public.purchase_invoices
     WHERE user_id = _owner AND id = _invoice_id
    UNION
    SELECT p.id, p.paid_from, p.amount_paid
      FROM public.purchase_invoices p JOIN invoice_family f ON p.replaced_by = f.id
     WHERE p.user_id = _owner
  )
  SELECT array_agg('purchase:' || id::text), bool_or(paid_from = 'drawer' AND amount_paid > 0)
    INTO _invoice_ids, _requires_drawer
    FROM invoice_family;

  SELECT array_agg(t ORDER BY t.id) INTO _payments
    FROM public.shift_transactions t
   WHERE t.user_id = _owner AND t.type = 'supplier_payment' AND t.reference_id = ANY(_invoice_ids);

  IF COALESCE(cardinality(_payments), 0) = 0 AND _requires_drawer IS NOT TRUE THEN RETURN; END IF;
  IF COALESCE(cardinality(_payments), 0) <> 1 THEN
    RAISE EXCEPTION 'حركة دفعة المورد الأصلية مفقودة أو ملتبسة. يجب تسويتها قبل الإلغاء';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shift_transactions t
     WHERE t.user_id = _owner AND t.type = 'supplier_refund'
       AND t.reference_id IN (SELECT replace(ref, 'purchase:', 'purchase_cancel:') FROM unnest(_invoice_ids) ref)
  ) THEN
    RAISE EXCEPTION 'دفعة الشراء لها قيد استرداد سابق. يجب مطابقته قبل الإلغاء';
  END IF;
  _payment := _payments[1];
  IF _payment.shift_id IS NULL OR _payment.amount <= 0
     OR _payment.amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR _payment.amount IS DISTINCT FROM COALESCE(_paid_amount, 0) THEN
    RAISE EXCEPTION 'مبلغ أو مرجع دفعة المورد الأصلية لا يطابق الفاتورة';
  END IF;

  _currency := upper(COALESCE(NULLIF(trim(_payment.currency), ''), 'USD'));
  IF _currency = 'USD' THEN
    IF _payment.currency_amount IS NOT NULL AND _payment.currency_amount <> _payment.amount THEN
      RAISE EXCEPTION 'مبلغ العملة في دفعة المورد الأصلية غير متسق';
    END IF;
    _payment.currency_amount := _payment.amount;
    _payment.exchange_rate := 1;
  ELSIF _payment.currency_amount IS NULL OR _payment.currency_amount <= 0
      OR _payment.exchange_rate IS NULL OR _payment.exchange_rate <= 0
      OR _payment.currency_amount::text IN ('NaN', 'Infinity', '-Infinity')
      OR _payment.exchange_rate::text IN ('NaN', 'Infinity', '-Infinity')
      OR abs(_payment.currency_amount / _payment.exchange_rate - _payment.amount) > 0.005 THEN
    RAISE EXCEPTION 'بيانات الصرف في دفعة المورد الأصلية تحتاج إلى تسوية';
  END IF;
  _payment.currency := _currency;
  RETURN NEXT _payment;
END;
$function$;
REVOKE ALL ON FUNCTION public._purchase_drawer_payment_for_cancellation(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.cancel_purchase_invoice_atomic(_invoice_id uuid, _reason text, _settlement_shift_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _orig_inv record;
  _old_item record;
  _no_inventory boolean := false;
  _cur_stock numeric;
  _cur_cost numeric;
  _new_stock numeric;
  _new_cost numeric;
  _calc_cost numeric;
  _rem_val numeric;
  v_variance numeric := 0;
  _has_subsequent_sale boolean := false;
  _has_newer_purchase boolean := false;
  _original_payment public.shift_transactions%ROWTYPE;
  _target_shift_id uuid;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'إلغاء فاتورة الشراء مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _orig_inv
    FROM public.purchase_invoices
   WHERE id = _invoice_id AND user_id = _owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'فاتورة المشتريات غير موجودة';
  END IF;

  IF _orig_inv.status = 'cancelled' OR _orig_inv.payment_status = 'cancelled' THEN
    RETURN true;
  END IF;

  PERFORM public.assert_period_open(_owner, _orig_inv.invoice_date, 'إلغاء فاتورة الشراء');

  -- Draft / reconciled invoices never modified stock, WAC, serials, or supplier ledger
  IF COALESCE(_orig_inv.status, 'draft') IN ('draft', 'reconciled') THEN
    UPDATE public.purchase_invoices
       SET status = 'cancelled',
           payment_status = 'cancelled',
           notes = concat_ws(E'\n', notes, '[ملغاة] ' || COALESCE(_reason, 'إلغاء الفاتورة')),
           updated_at = now()
     WHERE id = _invoice_id;
    RETURN true;
  END IF;

  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'ترحيل إلغاء فاتورة شراء');
  IF EXISTS (SELECT 1 FROM public.purchase_returns WHERE invoice_id = _invoice_id AND user_id = _owner) THEN
    RAISE EXCEPTION 'لا يمكن إلغاء فاتورة لها مرتجعات';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.product_serials
     WHERE purchase_invoice_id = _invoice_id
       AND user_id = _owner
       AND status <> 'in_stock'
  ) THEN
    RAISE EXCEPTION 'لا يمكن إلغاء الفاتورة: بعض أرقامها التسلسلية بيعت أو أُخرجت';
  END IF;

  SELECT COALESCE(s.store_type, 'general') IN ('bakery', 'repair')
    INTO _no_inventory
    FROM public.stores s
   WHERE s.user_id = _owner
   LIMIT 1;
  _no_inventory := COALESCE(_no_inventory, false);

  FOR _old_item IN
    SELECT * FROM public.purchase_invoice_items
     WHERE invoice_id = _invoice_id
     ORDER BY created_at DESC, id DESC
  LOOP
    IF _old_item.product_id IS NOT NULL THEN
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
            RAISE EXCEPTION 'لا يمكن إلغاء الفاتورة: جزء من كمية "%" بيع أو أُخرج من المخزون', _old_item.product_name;
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
            -- Perpetual moving average (IAS 2): keep current WAC when intervening sales expensed COGS
            _new_cost := COALESCE(_cur_cost, 0);
          ELSIF _new_stock > 0 AND _rem_val > 0 THEN
            _calc_cost := round(_rem_val / _new_stock, 8);
            IF _calc_cost > GREATEST(COALESCE(_cur_cost, 0), COALESCE(_old_item.cost_price_before, COALESCE(_cur_cost, 0)))
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

          v_variance := round((_new_stock * _new_cost) - _rem_val, 4);
          IF v_variance <> 0 THEN
            INSERT INTO public.inventory_valuation_adjustments(
              user_id, source_type, source_id, product_id, variance_usd, notes
            ) VALUES (
              _owner,
              'purchase_cancel',
              _invoice_id,
              _old_item.product_id,
              v_variance,
              'فرق تقييم مخزون عند إلغاء فاتورة الشراء ' || COALESCE(_orig_inv.invoice_number, '')
            );
          END IF;

          PERFORM set_config('app.stock_movement_type', 'purchase_reversal', true);
          PERFORM set_config('app.stock_source', 'cancel_purchase_invoice', true);
          UPDATE public.products
             SET quantity = _new_stock,
                 cost_price = _new_cost,
                 updated_at = now()
           WHERE id = _old_item.product_id;
        END IF;
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, created_by)
  SELECT user_id, supplier_id, 'adjustment', -amount, 'purchase_cancel', reference_id, 'عكس بسبب إلغاء الفاتورة', _caller
    FROM public.supplier_ledger_entries
   WHERE user_id = _owner
     AND reference_type = 'purchase_invoice'
     AND reference_id = _invoice_id::text
     AND entry_type IN ('purchase', 'payment');

  SELECT * INTO _original_payment
    FROM public._purchase_drawer_payment_for_cancellation(_owner, _invoice_id, _orig_inv.amount_paid);
  IF FOUND THEN
    _target_shift_id := COALESCE(_settlement_shift_id, _original_payment.shift_id);
    IF _target_shift_id IS DISTINCT FROM _original_payment.shift_id
       AND (NULLIF(trim(_reason), '') IS NULL OR trim(_reason) = 'إلغاء فاتورة شراء') THEN
      RAISE EXCEPTION 'يجب تسجيل سبب التسوية في وردية أخرى';
    END IF;

    PERFORM 1 FROM public.cash_shifts
     WHERE id = _target_shift_id AND user_id = _owner AND closed_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'حدد وردية تسوية مفتوحة بعد إغلاق وردية دفعة المورد الأصلية';
    END IF;

    PERFORM public._supplier_drawer_tx(
      _owner, _target_shift_id, 'supplier_refund', _original_payment.amount, _original_payment.currency,
      _original_payment.currency_amount, _original_payment.exchange_rate, 'purchase_cancel:' || _invoice_id::text,
      concat_ws(' | ', 'إلغاء فاتورة شراء ' || COALESCE(_orig_inv.invoice_number, ''),
        'حركة المورد الأصلية ' || _original_payment.id::text, 'الوردية الأصلية ' || _original_payment.shift_id::text,
        NULLIF(trim(_reason), ''))
    );
  END IF;

  UPDATE public.product_serials
     SET status = 'returned_to_supplier', updated_at = now()
   WHERE purchase_invoice_id = _invoice_id AND user_id = _owner AND status = 'in_stock';

  UPDATE public.purchase_invoices
     SET status = 'cancelled',
         payment_status = 'cancelled',
         notes = concat_ws(E'\n', notes, '[ملغاة] ' || COALESCE(_reason, 'إلغاء الفاتورة')),
         updated_at = now()
   WHERE id = _invoice_id;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_purchase_invoice_atomic(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_invoice_atomic(uuid, text, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cancel_purchase_invoice_atomic(
  _invoice_id uuid, _reason text DEFAULT 'إلغاء فاتورة شراء'::text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.cancel_purchase_invoice_atomic(_invoice_id, _reason, NULL::uuid);
$function$;


-- Dated financial snapshots of invoices and subsequent changes.
-- Seed rows are opening balances at installation, with zero posting deltas.
LOCK TABLE public.invoices, public.invoice_items IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.invoice_accounting_cutover (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.invoice_accounting_cutover DEFAULT VALUES;

CREATE TABLE public.invoice_accounting_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  txid bigint NOT NULL,
  posted_at timestamptz NOT NULL,
  is_opening boolean NOT NULL DEFAULT false,
  net_revenue numeric NOT NULL,
  cogs numeric NOT NULL,
  realized_profit numeric NOT NULL,
  pending_profit numeric NOT NULL,
  revenue_delta numeric NOT NULL,
  cogs_delta numeric NOT NULL,
  realized_delta numeric NOT NULL,
  UNIQUE (invoice_id, txid)
);
CREATE INDEX invoice_accounting_events_account_period ON public.invoice_accounting_events(user_id, posted_at);
CREATE INDEX invoice_accounting_events_latest_invoice ON public.invoice_accounting_events(invoice_id, id DESC);
ALTER TABLE public.invoice_accounting_cutover ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_accounting_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.invoice_accounting_cutover, public.invoice_accounting_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.invoice_accounting_events_id_seq FROM PUBLIC, anon, authenticated;

CREATE VIEW public._invoice_accounting_state AS
SELECT i.id AS invoice_id, i.user_id,
       CASE WHEN s.active_invoice THEN COALESCE(i.total, 0) - COALESCE(i.tax_amount, 0) ELSE 0 END AS net_revenue,
       CASE WHEN s.active_invoice THEN COALESCE(cost.cogs, 0) ELSE 0 END AS cogs,
       CASE
         WHEN NOT s.active_invoice THEN 0
         WHEN s.is_credit THEN round(COALESCE(i.profit, 0) * s.collected / i.total, 8)
         ELSE COALESCE(i.profit, 0)
       END AS realized_profit,
       CASE
         WHEN s.active_invoice AND s.is_credit AND i.status IS DISTINCT FROM 'written_off'
           THEN round(COALESCE(i.profit, 0) * (i.total - s.collected) / i.total, 8)
         ELSE 0
       END AS pending_profit
  FROM public.invoices i
 CROSS JOIN LATERAL (
   SELECT COALESCE(i.status, '') NOT IN ('cancelled', 'refunded')
              AND COALESCE(i.invoice_type, 'sale') IN ('sale', 'maintenance') AS active_invoice,
          i.payment_type IS NOT DISTINCT FROM 'debt' AND COALESCE(i.total, 0) > 0 AS is_credit,
          LEAST(GREATEST(COALESCE(i.debt_paid, i.paid_at_sale, 0), 0),
                GREATEST(COALESCE(i.total, 0), 0)) AS collected
 ) s
 LEFT JOIN LATERAL (
   SELECT SUM(COALESCE(ii.cost_price, 0) * COALESCE(ii.quantity, 0)) AS cogs
     FROM public.invoice_items ii
    WHERE ii.invoice_id = i.id AND s.active_invoice
 ) cost ON true;
REVOKE ALL ON TABLE public._invoice_accounting_state FROM PUBLIC, anon, authenticated;

INSERT INTO public.invoice_accounting_events (
  user_id, invoice_id, txid, posted_at, is_opening, net_revenue, cogs, realized_profit, pending_profit,
  revenue_delta, cogs_delta, realized_delta
)
SELECT s.user_id, s.invoice_id, txid_current(), c.installed_at, true,
       s.net_revenue, s.cogs, s.realized_profit, s.pending_profit, 0, 0, 0
  FROM public._invoice_accounting_state s
 CROSS JOIN public.invoice_accounting_cutover c;

CREATE FUNCTION public._capture_invoice_accounting_state(_invoice_id uuid, _owner_hint uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _previous public.invoice_accounting_events%ROWTYPE;
  _state record;
  _owner uuid;
  _txid bigint := txid_current();
  _revenue numeric;
  _cogs numeric;
  _realized numeric;
  _pending numeric;
BEGIN
  SELECT * INTO _state FROM public._invoice_accounting_state WHERE invoice_id = _invoice_id;
  IF FOUND THEN
    _owner := _state.user_id;
    _revenue := _state.net_revenue;
    _cogs := _state.cogs;
    _realized := _state.realized_profit;
    _pending := _state.pending_profit;
  ELSE
    _owner := _owner_hint;
    _revenue := 0;
    _cogs := 0;
    _realized := 0;
    _pending := 0;
  END IF;

  SELECT * INTO _previous
    FROM public.invoice_accounting_events
   WHERE invoice_id = _invoice_id AND txid <> _txid
   ORDER BY id DESC
   LIMIT 1;

  _owner := COALESCE(_owner, _previous.user_id);
  IF _owner IS NULL THEN RETURN; END IF;
  IF _previous.user_id IS NOT NULL AND _previous.user_id <> _owner THEN
    RAISE EXCEPTION 'لا يمكن نقل فاتورة مرحّلة بين حسابات المتاجر';
  END IF;

  IF ROW(_revenue, _cogs, _realized, _pending) IS NOT DISTINCT FROM
     ROW(COALESCE(_previous.net_revenue, 0), COALESCE(_previous.cogs, 0),
         COALESCE(_previous.realized_profit, 0), COALESCE(_previous.pending_profit, 0)) THEN
    DELETE FROM public.invoice_accounting_events WHERE invoice_id = _invoice_id AND txid = _txid;
    RETURN;
  END IF;

  INSERT INTO public.invoice_accounting_events(
    user_id, invoice_id, txid, posted_at, net_revenue, cogs, realized_profit, pending_profit,
    revenue_delta, cogs_delta, realized_delta
  ) VALUES (
    _owner, _invoice_id, _txid, clock_timestamp(), _revenue, _cogs, _realized, _pending,
    _revenue - COALESCE(_previous.net_revenue, 0), _cogs - COALESCE(_previous.cogs, 0),
    _realized - COALESCE(_previous.realized_profit, 0)
  )
  ON CONFLICT (invoice_id, txid) DO UPDATE SET
    net_revenue = EXCLUDED.net_revenue,
    cogs = EXCLUDED.cogs,
    realized_profit = EXCLUDED.realized_profit,
    pending_profit = EXCLUDED.pending_profit,
    revenue_delta = EXCLUDED.revenue_delta,
    cogs_delta = EXCLUDED.cogs_delta,
    realized_delta = EXCLUDED.realized_delta;
END;
$function$;

CREATE FUNCTION public._hold_invoice_accounting_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _invoice_id uuid;
  _owner uuid;
BEGIN
  IF TG_TABLE_NAME = 'invoices' THEN
    IF TG_OP = 'DELETE' THEN _owner := OLD.user_id;
    ELSE _owner := NEW.user_id; END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND OLD.invoice_id IS DISTINCT FROM NEW.invoice_id THEN
      RAISE EXCEPTION 'لا يمكن نقل بند مرحّل من فاتورة إلى أخرى';
    END IF;
    IF TG_OP = 'DELETE' THEN _invoice_id := OLD.invoice_id;
    ELSE _invoice_id := NEW.invoice_id; END IF;
    SELECT user_id INTO _owner FROM public.invoices WHERE id = _invoice_id FOR NO KEY UPDATE;
  END IF;
  IF _owner IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock_shared(hashtext('close_accounting_period:' || _owner::text));
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public._journal_invoice_accounting_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'invoices' THEN
    IF TG_OP = 'DELETE' THEN PERFORM public._capture_invoice_accounting_state(OLD.id, OLD.user_id);
    ELSE PERFORM public._capture_invoice_accounting_state(NEW.id, NEW.user_id); END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      PERFORM public._capture_invoice_accounting_state(OLD.invoice_id, NULL);
    ELSE
      PERFORM public._capture_invoice_accounting_state(NEW.invoice_id, NULL);
      IF TG_OP = 'UPDATE' AND OLD.invoice_id IS DISTINCT FROM NEW.invoice_id THEN
        PERFORM public._capture_invoice_accounting_state(OLD.invoice_id, NULL);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public._capture_invoice_accounting_state(uuid, uuid),
  public._hold_invoice_accounting_lock(), public._journal_invoice_accounting_change()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER aa_invoice_accounting_lock BEFORE INSERT OR UPDATE OR DELETE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public._hold_invoice_accounting_lock();
CREATE TRIGGER aa_invoice_item_accounting_lock BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_items
FOR EACH ROW EXECUTE FUNCTION public._hold_invoice_accounting_lock();
CREATE CONSTRAINT TRIGGER zz_invoice_accounting_journal
AFTER INSERT OR UPDATE OR DELETE ON public.invoices DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (current_setting('app.purge_context', true) IS DISTINCT FROM 'owner_purge')
EXECUTE FUNCTION public._journal_invoice_accounting_change();
CREATE CONSTRAINT TRIGGER zz_invoice_item_accounting_journal
AFTER INSERT OR UPDATE OR DELETE ON public.invoice_items DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (current_setting('app.purge_context', true) IS DISTINCT FROM 'owner_purge')
EXECUTE FUNCTION public._journal_invoice_accounting_change();


CREATE OR REPLACE FUNCTION public.close_accounting_period_atomic(_period_start date, _period_end date, _timezone text DEFAULT 'UTC'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _tz text := COALESCE(NULLIF(trim(_timezone), ''), 'UTC');
  _rev numeric := 0;
  _cogs numeric := 0;
  _exp numeric := 0;
  _gross numeric := 0;
  _realized numeric := 0;
  _pending numeric := 0;
  _bad_debt numeric := 0;
  _net numeric := 0;
  _inventory_valuation numeric := 0;
  _range_start timestamptz;
  _range_end timestamptz;
  _installed_at timestamptz;
  _partner_summary jsonb := '[]'::jsonb;
  _closure_id uuid;
  p record;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'إقفال الفترة مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  BEGIN
    PERFORM now() AT TIME ZONE _tz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'المنطقة الزمنية غير صحيحة: %', _tz;
  END;

  IF _period_start IS NULL OR _period_end IS NULL OR _period_start > _period_end THEN
    RAISE EXCEPTION 'تواريخ الفترة غير صحيحة';
  END IF;
  IF _period_end >= (now() AT TIME ZONE _tz)::date THEN
    RAISE EXCEPTION 'لا يمكن إقفال فترة لم تنتهِ بعد';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('close_accounting_period:' || _owner::text));

  IF EXISTS (
    SELECT 1 FROM public.accounting_period_closures c
    WHERE c.user_id = _owner
      AND c.period_start <= _period_end
      AND c.period_end >= _period_start
  ) THEN
    RAISE EXCEPTION 'هذه الفترة تتداخل مع فترة مقفلة سابقاً';
  END IF;

  _range_start := _period_start::timestamp AT TIME ZONE _tz;
  _range_end := (_period_end + 1)::timestamp AT TIME ZONE _tz;
  SELECT installed_at INTO _installed_at FROM public.invoice_accounting_cutover;
  IF _range_start < _installed_at AND EXISTS (
    SELECT 1 FROM public.invoice_accounting_events
     WHERE user_id = _owner AND is_opening
  ) THEN
    RAISE EXCEPTION 'تحتاج الفترة إلى تسوية موثقة لأنها تبدأ قبل تفعيل سجل حركات الفواتير';
  END IF;

  SELECT COALESCE(SUM(revenue_delta), 0), COALESCE(SUM(cogs_delta), 0), COALESCE(SUM(realized_delta), 0)
    INTO _rev, _cogs, _realized
    FROM public.invoice_accounting_events
   WHERE user_id = _owner AND NOT is_opening
     AND posted_at >= _range_start AND posted_at < _range_end;

  SELECT COALESCE(SUM(e.pending_profit), 0) INTO _pending
    FROM (
      SELECT DISTINCT ON (invoice_id) pending_profit
        FROM public.invoice_accounting_events
       WHERE user_id = _owner AND posted_at < _range_end
       ORDER BY invoice_id, posted_at DESC, id DESC
    ) e;

  IF EXISTS (
    SELECT 1 FROM public.expenses
     WHERE user_id = _owner AND is_reversed AND reversed_at IS NULL
       AND date BETWEEN _period_start AND _period_end
  ) THEN
    RAISE EXCEPTION 'تحتاج مصاريف الفترة المعكوسة بدون تاريخ انعكاس إلى تسوية موثقة';
  END IF;
  SELECT COALESCE(SUM(
    CASE WHEN date BETWEEN _period_start AND _period_end THEN amount ELSE 0 END
    - CASE WHEN is_reversed AND reversed_at >= _range_start AND reversed_at < _range_end
           THEN amount ELSE 0 END
  ), 0) INTO _exp
    FROM public.expenses
   WHERE user_id = _owner
     AND (date BETWEEN _period_start AND _period_end
          OR (is_reversed AND reversed_at >= _range_start AND reversed_at < _range_end));

  IF EXISTS (
    SELECT 1 FROM public.debt_writeoffs
     WHERE user_id = _owner AND loss_amount IS NULL
       AND written_off_at >= _range_start AND written_off_at < _range_end
  ) THEN
    RAISE EXCEPTION 'تحتاج قيود الشطب بدون قيمة خسارة موثقة إلى تسوية قبل الإقفال';
  END IF;
  SELECT COALESCE(SUM(loss_amount), 0) INTO _bad_debt
    FROM public.debt_writeoffs
   WHERE user_id = _owner AND written_off_at >= _range_start AND written_off_at < _range_end;

  _inventory_valuation := public._inventory_valuation_for_period(_owner, _period_start, _period_end, _tz);

  _rev := round(_rev, 8);
  _cogs := round(_cogs, 8);
  _exp := round(_exp, 8);
  _gross := round(_rev - _cogs, 8);
  _realized := round(_realized, 8);
  _pending := round(_pending, 8);
  _bad_debt := round(_bad_debt, 8);
  _net := round(_realized - _exp - _bad_debt + _inventory_valuation, 8);

  FOR p IN
    SELECT balances.partner_id AS id, COALESCE(pr.name, '') AS name,
           round(balances.current_balance, 8) AS current_balance,
           round(balances.confirmed_profit, 8) AS confirmed_profit,
           round(balances.total_profit_earned, 8) AS total_profit_earned
      FROM (
        SELECT le.partner_id,
               SUM(le.d_current_balance) AS current_balance,
               SUM(le.d_confirmed_profit) AS confirmed_profit,
               SUM(le.d_total_profit_earned) AS total_profit_earned
          FROM public.partner_ledger_entries le
         WHERE le.user_id = _owner AND le.created_at < _range_end
         GROUP BY le.partner_id
        HAVING BOOL_OR(le.entry_type = 'opening')
      ) balances
      LEFT JOIN public.partners pr ON pr.id = balances.partner_id AND pr.user_id = _owner
     ORDER BY balances.partner_id
  LOOP
    _partner_summary := _partner_summary || jsonb_build_object(
      'partner_id', p.id,
      'partner_name', p.name,
      'current_balance', p.current_balance,
      'confirmed_profit', p.confirmed_profit,
      'total_earned', p.total_profit_earned
    );
  END LOOP;

  INSERT INTO public.accounting_period_closures (
    user_id, period_start, period_end, total_revenue, total_cogs,
    gross_profit, total_expenses, net_profit, partner_distributions, closed_by,
    realized_profit, pending_profit, bad_debt_loss, closing_timezone, inventory_valuation_adjustment
  ) VALUES (
    _owner, _period_start, _period_end, _rev, _cogs,
    _gross, _exp, _net, _partner_summary, _caller,
    _realized, _pending, _bad_debt, _tz, _inventory_valuation
  ) RETURNING id INTO _closure_id;

  RETURN jsonb_build_object(
    'success', true,
    'closure_id', _closure_id,
    'period_start', _period_start,
    'period_end', _period_end,
    'timezone', _tz,
    'revenue', _rev,
    'cogs', _cogs,
    'gross_profit', _gross,
    'realized_profit', _realized,
    'pending_profit', _pending,
    'expenses', _exp,
    'bad_debt_loss', _bad_debt,
    'inventory_valuation_adjustment', _inventory_valuation,
    'net_profit', _net,
    'partners', _partner_summary
  );
END;
$function$;
-- Durable partner withdrawal receipts and serialized expense entry points.
CREATE TABLE public.accounting_rpc_receipts (
  user_id uuid NOT NULL,
  kind text NOT NULL,
  operation_id text NOT NULL,
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, kind, operation_id)
);
ALTER TABLE public.accounting_rpc_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.accounting_rpc_receipts FROM PUBLIC, anon, authenticated;

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
    v_rate := COALESCE(_exchange_rate, 0);
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
       SET expected_balance = round(COALESCE(expected_balance, 0) - v_amt, 2),
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
    _orig_amt := round(_amt_usd, 2);
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
       SET expected_balance = round(COALESCE(expected_balance, 0) + _amt_usd, 2),
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

CREATE FUNCTION public._assert_accounting_posting_open(_owner uuid, _posted_at timestamptz, _label text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('close_accounting_period:' || _owner::text));
  IF EXISTS (
    SELECT 1 FROM public.accounting_period_closures c
     WHERE c.user_id = _owner
       AND (_posted_at AT TIME ZONE COALESCE(c.closing_timezone, 'UTC'))::date
           BETWEEN c.period_start AND c.period_end
  ) THEN
    RAISE EXCEPTION '% مرفوضة: وقت الترحيل ضمن فترة مقفلة', _label;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public._assert_accounting_posting_open(uuid,timestamptz,text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_expenses_assert_period_open()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.assert_period_open(OLD.user_id, OLD.date, 'تعديل المصروفات');
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF current_setting('app.internal_expense_reverse', true) = '1'
       AND NOT COALESCE(OLD.is_reversed, false) AND NEW.is_reversed
       AND (to_jsonb(OLD) - ARRAY['is_reversed','reversed_at','reversed_by','reversed_reason'])
         = (to_jsonb(NEW) - ARRAY['is_reversed','reversed_at','reversed_by','reversed_reason']) THEN
      PERFORM public._assert_accounting_posting_open(NEW.user_id, NEW.reversed_at, 'عكس مصروف');
      RETURN NEW;
    END IF;
    IF OLD.date IS DISTINCT FROM NEW.date THEN
      PERFORM public.assert_period_open(OLD.user_id, OLD.date, 'تعديل المصروفات');
    END IF;
  END IF;

  PERFORM public.assert_period_open(NEW.user_id, NEW.date, 'تعديل المصروفات');
  RETURN NEW;
END;
$function$;

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
  _amt numeric := round(coalesce(_amount, 0), 2);
  _orig_ccy text := upper(COALESCE(NULLIF(trim(_original_currency), ''), 'USD'));
  _orig_rate numeric;
  _orig_amt numeric;
  _target_shift_id uuid := NULL;
  _dist jsonb := '[]'::jsonb;
  p record;
  _pct numeric;
  _part numeric;
  _pct_before numeric := 0;
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
  IF (SELECT SUM(GREATEST(COALESCE(expense_share_percentage, share_percentage, 0), 0))
        FROM public.partners WHERE user_id = _owner) > 100 THEN
    RAISE EXCEPTION 'إجمالي حصص المصروف يتجاوز 100 بالمئة';
  END IF;

  FOR p IN
    SELECT * FROM public.partners
    WHERE user_id = _owner
    ORDER BY id
  LOOP
    _pct := coalesce(p.expense_share_percentage, p.share_percentage, 0);

    IF _pct > 0 THEN
      _part := round(_amt * (_pct_before + _pct) / 100, 4)
             - round(_amt * _pct_before / 100, 4);
      _pct_before := _pct_before + _pct;

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
    );

    IF FOUND THEN
      UPDATE public.cash_shifts
         SET expected_balance = round(COALESCE(expected_balance, 0) - _amt, 2),
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
         SET expected_balance = round(COALESCE(expected_balance, 0) + _refund_amt, 2),
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


-- Immutable sales settlements and source-receipt allocation.
ALTER TABLE public.debt_payments ADD COLUMN IF NOT EXISTS currency_amount numeric;

CREATE TABLE IF NOT EXISTS public.sales_settlement_replays (
  user_id uuid NOT NULL,
  kind text NOT NULL,
  operation_id text NOT NULL,
  request jsonb NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, operation_id)
);
CREATE TABLE IF NOT EXISTS public.sales_refund_allocations (
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  kind text NOT NULL,
  operation_id text NOT NULL,
  receipt_key text NOT NULL,
  method text NOT NULL CHECK (method IN ('cash', 'transfer')),
  currency text NOT NULL,
  exchange_rate numeric NOT NULL CHECK (exchange_rate > 0),
  settled_amount numeric NOT NULL CHECK (settled_amount > 0),
  tender_usd numeric NOT NULL CHECK (tender_usd >= 0),
  currency_amount numeric NOT NULL CHECK (currency_amount >= 0),
  shift_id uuid,
  settlement_mode text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, operation_id, receipt_key)
);
CREATE INDEX IF NOT EXISTS sales_refund_allocations_receipt_idx
  ON public.sales_refund_allocations (user_id, invoice_id, receipt_key);

ALTER TABLE public.sales_settlement_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_refund_allocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_settlement_replays, public.sales_refund_allocations FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._read_sales_settlement_replay(
  _owner uuid, _kind text, _operation text, _request jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE
  _saved public.sales_settlement_replays%ROWTYPE;
BEGIN
  IF _owner IS NULL OR NULLIF(trim(_operation), '') IS NULL THEN
    RAISE EXCEPTION 'معرّف العملية غير صالح';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_owner::text || ':' || _kind || ':' || _operation, 0));
  SELECT * INTO _saved FROM public.sales_settlement_replays
   WHERE user_id = _owner AND kind = _kind AND operation_id = _operation;
  IF FOUND AND _saved.request IS DISTINCT FROM _request THEN
    RAISE EXCEPTION 'معرّف العملية مستخدم مسبقاً لبيانات تسوية مختلفة' USING ERRCODE = '23505';
  END IF;
  RETURN _saved.response;
END;
$$;

-- Refunds consume the oldest documented receipts first. Gross settlement and actual tender differ when rounding occurred.
CREATE OR REPLACE FUNCTION public._allocate_sales_refund(
  _inv public.invoices, _kind text, _operation text, _wanted numeric, _shift uuid, _mode text
) RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public' AS $$
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
    _net_usd := round(_receipt.usd * (_previous + _take) / _receipt.settled, 2) - _previous_usd;
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
    UPDATE public.cash_shifts SET expected_balance = round(COALESCE(expected_balance, 0) - _drawer, 2), updated_at = now()
     WHERE id = _shift AND user_id = _inv.user_id AND closed_at IS NULL;
  END IF;

  RETURN jsonb_build_object('cash', _cash, 'digital', _digital, 'drawer', _drawer,
    'drawer_recorded', _drawer_recorded, 'allocations', _allocations);
END;
$$;

REVOKE ALL ON FUNCTION public._allocate_sales_refund(public.invoices,text,text,numeric,uuid,text),
  public._read_sales_settlement_replay(uuid,text,text,jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._assert_sales_refund_currency(
  _settlement jsonb, _currency text, _currency_amount numeric, _rate numeric
) RETURNS void LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE
  _original_amount numeric;
  _matches boolean;
BEGIN
  IF (_settlement->>'cash')::numeric <= 0 OR
      (_currency IS NULL AND _currency_amount IS NULL AND _rate IS NULL) THEN RETURN; END IF;
  SELECT COALESCE(bool_and((_currency IS NULL OR s.currency = upper(trim(_currency))) AND
      (_rate IS NULL OR s.exchange_rate = _rate)), false), sum(s.currency_amount)
    INTO _matches, _original_amount
    FROM jsonb_to_recordset(_settlement->'allocations')
      AS s(method text, currency text, exchange_rate numeric, currency_amount numeric)
   WHERE s.method = 'cash';
  IF NOT _matches OR (_currency_amount IS NOT NULL AND abs(_original_amount - _currency_amount) > 0.0001) THEN
    RAISE EXCEPTION 'بيانات العملة المرسلة لا تطابق إيصالات القبض. استخدم النسخة التي تعتمد تخصيص الإيصالات';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._assert_sales_refund_currency(jsonb,text,numeric,numeric) FROM PUBLIC, anon, authenticated;


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
  v_existing_payment public.debt_payments%ROWTYPE;
  v_request jsonb;
  v_response jsonb;
  v_legacy_currency_amount numeric;
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
       OR v_existing_payment.settled_amount IS DISTINCT FROM v_amount
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
    paid_by, shift_id
  ) VALUES (
    v_owner, _debt_id, _operation_id, v_cash_amount,
    v_settlement, v_rounding_adjustment,
    v_tx_currency, v_tx_currency_amount, v_tx_exchange_rate, v_payment_method,
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
    );

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

  v_response := jsonb_build_object(
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
  INSERT INTO public.sales_settlement_replays(user_id, kind, operation_id, request, response)
  VALUES (v_owner, 'debt_payment', _operation_id, v_request, v_response);
  RETURN v_response;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_invoice_atomic(
  _invoice_number text,
  _source text DEFAULT 'online'::text,
  _shift_id uuid DEFAULT NULL::uuid,
  _currency text DEFAULT NULL::text,
  _currency_amount numeric DEFAULT NULL::numeric,
  _exchange_rate numeric DEFAULT NULL::numeric,
  _settlement_mode text DEFAULT 'drawer'::text
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
  _settlement jsonb;
  _request jsonb;
  _response jsonb;
  _norm_settlement_mode text := lower(COALESCE(NULLIF(trim(_settlement_mode), ''), 'drawer'));

BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _owner := public.get_owner_id(_caller);

  IF public.can_refund_invoices(auth.uid()) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ليست لديك صلاحية الاسترداد. اطلبها من مالك المتجر' USING ERRCODE = '42501';
  END IF;

  IF _norm_settlement_mode NOT IN ('drawer', 'external_cash') THEN
    RAISE EXCEPTION 'وضع التسوية غير صالح: %', _settlement_mode;
  END IF;

  _request := jsonb_build_object('invoice_number', _invoice_number, 'shift_id', _shift_id,
    'currency', _currency, 'currency_amount', _currency_amount, 'exchange_rate', _exchange_rate, 'settlement_mode', _norm_settlement_mode);
  _response := public._read_sales_settlement_replay(_owner, 'full_refund', _invoice_number, _request);

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

  SELECT EXISTS(
    SELECT 1 FROM public.stock_movements sm
    WHERE sm.user_id = _owner AND sm.invoice_id = _invoice.id AND sm.movement_type = 'refund'
  ) INTO _has_refund;

  -- Idempotent retry: return previously recorded result only (never create a new drawer tx)
  IF _invoice.status = 'refunded' OR _has_refund THEN
    RETURN QUERY SELECT false, true, _invoice.id, _invoice.invoice_number, COALESCE(_invoice.total, 0)::numeric, _invoice.currency::text, 0, 0::numeric, 0::numeric, _invoice.customer_name::text;
    RETURN;
  END IF;

  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'استرداد الفاتورة');

  _settlement := public._allocate_sales_refund(_invoice, 'full_refund', _invoice_number,
    CASE WHEN _invoice.payment_type = 'debt' THEN _invoice.debt_paid ELSE _invoice.total END,
    _shift_id, _norm_settlement_mode);
  PERFORM public._assert_sales_refund_currency(_settlement, _currency, _currency_amount, _exchange_rate);

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

  -- Atomically reverse profit_records within the same transaction
  UPDATE public.profit_records
     SET is_reversed = true,
         reversed_at = now()
   WHERE user_id = _owner
     AND invoice_id IN (_invoice.invoice_number, _invoice.id::text)
     AND is_reversed = false;

  INSERT INTO public.activity_log(user_id, actor_id, actor_name, actor_role, action_type, entity_type, entity_id, entity_name, description, metadata)
  SELECT
    _owner, _caller, COALESCE(p.full_name, _invoice.cashier_name, 'مستخدم'), ur.role::text,
    'invoice_refunded', 'invoice', _invoice.id::text, _invoice.invoice_number,
    'تم استرداد الفاتورة ' || _invoice.invoice_number,
    jsonb_build_object(
      'invoice_number', _invoice.invoice_number,
      'invoice_total', COALESCE(_invoice.total, 0),
      'invoice_currency', _invoice.currency,
      'cash_refund_amount', (_settlement->>'cash')::numeric,
      'digital_to_refund', (_settlement->>'digital')::numeric,
      'receipt_allocation', true,
      'settlement_allocations', _settlement->'allocations',
      'shift_id', _shift_id,
      'settlement_mode', _norm_settlement_mode,
      'restored_items', _restored_items,
      'restored_units', _restored_units,
      'deleted_debt_amount', _deleted_debt,
      'source', CASE WHEN _source = 'offline-sync' THEN 'offline-sync' ELSE 'online' END
    )
  FROM (SELECT 1) seed
  LEFT JOIN public.profiles p ON p.user_id = _caller
  LEFT JOIN public.user_roles ur ON ur.user_id = _caller
  LIMIT 1;

  _response := _settlement || jsonb_build_object('invoice_id', _invoice.id, 'invoice_number', _invoice.invoice_number,
    'restored_item_count', _restored_items, 'restored_unit_count', _restored_units, 'deleted_debt_amount', _deleted_debt);
  INSERT INTO public.sales_settlement_replays(user_id, kind, operation_id, request, response)
  VALUES (_owner, 'full_refund', _invoice_number, _request, _response);

  RETURN QUERY SELECT true, false, _invoice.id, _invoice.invoice_number, COALESCE(_invoice.total, 0)::numeric, _invoice.currency::text, _restored_items, _restored_units, _deleted_debt, _invoice.customer_name::text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_invoice_partial_atomic(
  _invoice_number text,
  _items jsonb,
  _operation_id text,
  _shift_id uuid DEFAULT NULL::uuid,
  _currency text DEFAULT NULL::text,
  _currency_amount numeric DEFAULT NULL::numeric,
  _exchange_rate numeric DEFAULT NULL::numeric,
  _settlement_mode text DEFAULT 'drawer'::text
)
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
  _request jsonb;
  _response jsonb;
  _settlement jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _owner := public.get_owner_id(auth.uid());

  IF public.can_refund_invoices(auth.uid()) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ليست لديك صلاحية الاسترداد. اطلبها من مالك المتجر' USING ERRCODE = '42501';
  END IF;

  IF _norm_settlement_mode NOT IN ('drawer', 'external_cash') THEN
    RAISE EXCEPTION 'وضع التسوية غير صالح: %', _settlement_mode;
  END IF;

  _request := jsonb_build_object('invoice_number', _invoice_number, 'items', _items, 'shift_id', _shift_id,
    'currency', _currency, 'currency_amount', _currency_amount, 'exchange_rate', _exchange_rate, 'settlement_mode', _norm_settlement_mode);
  _response := public._read_sales_settlement_replay(_owner, 'partial_refund', _operation_id, _request);
  IF _response IS NOT NULL THEN RETURN _response || jsonb_build_object('already_processed', true); END IF;

  SELECT * INTO _inv FROM public.invoices WHERE invoice_number=_invoice_number AND user_id=_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','invoice_not_found'); END IF;
  IF COALESCE(_inv.status, '') IN ('cancelled', 'written_off') THEN
    RAISE EXCEPTION 'لا يمكن استرداد فاتورة ملغاة أو مشطوبة';
  END IF;
  IF EXISTS (SELECT 1 FROM public.activity_log l WHERE l.user_id = _owner
       AND l.action_type = 'partial_refund' AND l.metadata->>'operation_id' = _operation_id) THEN
    RAISE EXCEPTION 'سبق تسجيل معرّف المرتجع ولا توجد نسخة موثقة من الطلب الأصلي' USING ERRCODE = '23505';
  END IF;

  IF _inv.status = 'refunded' THEN
    RETURN jsonb_build_object('success', false, 'already_refunded', true, 'invoice_id', _inv.id,
      'invoice_number', _inv.invoice_number, 'cash_to_refund', 0, 'digital_to_refund', 0);
  END IF;

  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'الاسترداد الجزئي');

  SELECT s.store_type INTO _store_type FROM public.stores s WHERE s.user_id = _owner ORDER BY s.created_at LIMIT 1;
  _track_inventory := NOT (COALESCE(_store_type, 'general') IN ('bakery', 'repair'));

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

  _new_debt := CASE WHEN _inv.payment_type = 'debt'
    THEN GREATEST(round(COALESCE(_inv.debt_remaining, 0) - _debt_red, 8), 0)
    ELSE COALESCE(_inv.debt_remaining, 0) END;

  _settlement := public._allocate_sales_refund(_inv, 'partial_refund', _operation_id,
    CASE WHEN _inv.payment_type = 'debt' THEN _paid_red ELSE _refund END, _shift_id, _norm_settlement_mode);
  PERFORM public._assert_sales_refund_currency(_settlement, _currency, _currency_amount, _exchange_rate);
  _cash := (_settlement->>'cash')::numeric;
  _digital_to_refund := (_settlement->>'digital')::numeric;
  _drawer_refund_usd := (_settlement->>'drawer')::numeric;
  _drawer_tx_recorded := COALESCE((_settlement->>'drawer_recorded')::boolean, false);

  IF _full THEN PERFORM set_config('app.refund_context','allowed',true); END IF;
  UPDATE public.invoices SET subtotal=_new_sub, discount=_new_disc, tax_amount=_new_tax, total=_new_total, profit=_new_profit,
    total_in_currency = round(_new_total * COALESCE(NULLIF(_inv.exchange_rate, 0), 1), 8),
    debt_remaining=CASE WHEN _full THEN 0 ELSE _new_debt END, debt_paid=CASE WHEN payment_type='debt' THEN GREATEST(round(COALESCE(debt_paid,0)-_paid_red,8),0) ELSE debt_paid END,
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
  ELSIF _profit_red <> 0 OR _cogs <> 0 OR _refund <> 0 THEN
    INSERT INTO public.profit_records (
      user_id, invoice_id, gross_profit, cogs, revenue, currency, recorded_at, is_reversed
    ) VALUES (
      _owner,
      _inv.invoice_number,
      -round(_profit_red, 4),
      -round(_cogs, 4),
      -round(_refund, 4),
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
      'receipt_allocation', true,
      'settlement_allocations', _settlement->'allocations',
      'debt_reduced', _debt_red,
      'restored_units', _restored
    )
  FROM (SELECT 1) seed
  LEFT JOIN public.profiles p ON p.user_id = auth.uid()
  LEFT JOIN public.user_roles ur ON ur.user_id = auth.uid()
  LIMIT 1;

  _response := jsonb_build_object(
    'success', true,
    'invoice_id', _inv.id,
    'invoice_number', _inv.invoice_number,
    'refund_amount', _refund,
    'restored_units', _restored,
    'new_total', _new_total,
    'new_profit', _new_profit,
    'new_debt_remaining', _new_debt,
    'cash_to_refund', _cash,
    'profit_reduced', _profit_red,
    'cogs_reduced', _cogs,
    'debt_reduced', _debt_red,
    'is_fully_refunded', _full,
    'drawer_tx_recorded', _drawer_tx_recorded,
    'drawer_refund_usd', _drawer_refund_usd,
    'digital_to_refund', _digital_to_refund,
    'settlement_allocations', _settlement->'allocations'
  );
  INSERT INTO public.sales_settlement_replays(user_id, kind, operation_id, request, response)
  VALUES (_owner, 'partial_refund', _operation_id, _request, _response);
  RETURN _response;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_sales_full_refund_settlement(_invoice_number text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  _owner uuid := public.get_owner_id(auth.uid());
BEGIN
  IF _owner IS NULL OR public.can_refund_invoices(auth.uid()) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ليست لديك صلاحية قراءة تسوية المرتجع';
  END IF;
  RETURN (SELECT response FROM public.sales_settlement_replays WHERE user_id = _owner
    AND kind = 'full_refund' AND operation_id = _invoice_number);
END;
$$;
REVOKE ALL ON FUNCTION public.get_sales_full_refund_settlement(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sales_full_refund_settlement(text) TO authenticated;



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
     OR (NEW.exchange_rates IS DISTINCT FROM OLD.exchange_rates)
     OR (NEW.sync_settings->'primaryCurrency' IS DISTINCT FROM OLD.sync_settings->'primaryCurrency')
     OR (NEW.sync_settings->'enabledCurrencies' IS DISTINCT FROM OLD.sync_settings->'enabledCurrencies')
     OR (NEW.sync_settings->'slot1Code' IS DISTINCT FROM OLD.sync_settings->'slot1Code')
     OR (NEW.sync_settings->'slot2Code' IS DISTINCT FROM OLD.sync_settings->'slot2Code')
     OR (NEW.sync_settings->'exchangeRates' IS DISTINCT FROM OLD.sync_settings->'exchangeRates') THEN
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
