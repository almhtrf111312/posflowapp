-- Fixes from the re-audit of v1.5.272 (2026-11-24), all confirmed by local reproduction:
--  N1  a repeated edit of a paid purchase lost the supplier credit: the amount carried forward was amount_paid only.
--      It now carries amount_paid + supplier_credit (the whole amount paid to the supplier).
--  N2  a cash sale's drawer movement was rounded to 2 decimals; it now keeps 8 (F-02). The cached drawer balance too.
--  N3  a received currency amount that does not match the sale value was accepted; it is now refused.
-- Written by the implementing agent. The owner pastes it into the SQL editor.

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
        round(_prod_qty * _prod_cost, 4),
        CASE
          WHEN jsonb_typeof(_line->'serials') = 'array' THEN
            ARRAY(SELECT trim(x) FROM jsonb_array_elements_text(_line->'serials') x WHERE trim(x) <> '')
          ELSE NULL
        END
      );

      _items_count := _items_count + 1;
      _total_qty := _total_qty + _prod_qty;
      _grand_total := _grand_total + round(_prod_qty * _prod_cost, 4);
    END LOOP;

    UPDATE public.purchase_invoices
       SET actual_items_count = _items_count,
           actual_total_quantity = _total_qty,
           actual_grand_total = round(_grand_total, 4),
           expected_items_count = _items_count,
           expected_total_quantity = _total_qty,
           expected_grand_total = round(_grand_total, 4),
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

        v_variance := round((_new_stock * _new_cost) - _rem_val, 4);
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
        round(_prod_qty * _prod_cost, 4),
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
      _grand_total := _grand_total + round(_prod_qty * _prod_cost, 4);
    END IF;
  END LOOP;

  UPDATE public.purchase_invoices
     SET actual_items_count = _items_count,
         actual_total_quantity = _total_qty,
         actual_grand_total = round(_grand_total, 4),
         expected_items_count = _items_count,
         expected_total_quantity = _total_qty,
         expected_grand_total = round(_grand_total, 4),
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
    VALUES (_owner, _orig_inv.supplier_id, 'purchase', round(_grand_total, 4), 'purchase_invoice', _new_invoice_id::text, 'فاتورة معدّلة ', _caller);

    IF COALESCE(_orig_inv.amount_paid, 0) + COALESCE(_orig_inv.supplier_credit, 0) > 0 THEN
      INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, created_by)
      VALUES (_owner, _orig_inv.supplier_id, 'payment', -round(COALESCE(_orig_inv.amount_paid, 0) + COALESCE(_orig_inv.supplier_credit, 0), 4), 'purchase_invoice', _new_invoice_id::text, 'دفعة منقولة من الفاتورة الأصلية', _caller);
    END IF;

    UPDATE public.purchase_invoices
       SET supplier_id = _orig_inv.supplier_id,
           amount_paid = LEAST(COALESCE(_orig_inv.amount_paid, 0) + COALESCE(_orig_inv.supplier_credit, 0), round(_grand_total, 4))
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
         supplier_credit = GREATEST(COALESCE(_orig_inv.amount_paid, 0) + COALESCE(_orig_inv.supplier_credit, 0) - round(_grand_total, 4), 0)
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
$function$;

CREATE OR REPLACE FUNCTION public.process_pos_sale_with_drawer_atomic(
  _operation_id text,
  _payment_type text,
  _customer_name text,
  _customer_phone text,
  _subtotal numeric,
  _discount numeric,
  _discount_percentage numeric,
  _tax_rate numeric,
  _tax_amount numeric,
  _total numeric,
  _profit numeric,
  _currency text,
  _warehouse_id uuid,
  _items jsonb,
  _down_payment numeric DEFAULT 0,
  _exchange_rate numeric DEFAULT NULL::numeric,
  _tax_mode text DEFAULT NULL::text,
  _shift_id uuid DEFAULT NULL::uuid,
  _currency_amount numeric DEFAULT NULL::numeric,
  _sale_at timestamptz DEFAULT NULL::timestamptz
)
RETURNS TABLE(
  success boolean,
  already_processed boolean,
  invoice_id uuid,
  invoice_number text,
  subtotal numeric,
  discount numeric,
  tax_amount numeric,
  total numeric,
  cogs numeric,
  profit numeric,
  debt_paid numeric,
  debt_remaining numeric,
  stock_shortage boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_owner uuid := public.get_owner_id(auth.uid());
  v_ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  v_rate numeric;
  v_amt numeric;
  v_orig numeric;
  v_inserted integer := 0;
  v_sale_ts timestamptz;
  v_expected numeric;
  v_tol numeric;
BEGIN
  SELECT * INTO r
  FROM public.process_pos_sale_atomic(
    _operation_id, _payment_type, _customer_name, _customer_phone, _subtotal, _discount,
    _discount_percentage, _tax_rate, _tax_amount, _total, _profit, _currency, _warehouse_id,
    _items, _down_payment, _exchange_rate, _tax_mode, _sale_at
  );

  IF NOT COALESCE(r.already_processed, false) AND _payment_type = 'cash' AND _shift_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.cash_shifts cs
       WHERE cs.id = _shift_id AND cs.user_id = v_owner AND cs.closed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'الوردية مغلقة أو غير موجودة: لا يمكن ترحيل بيع نقدي إليها';
    END IF;

    v_rate := CASE WHEN v_ccy = 'USD' THEN 1 ELSE _exchange_rate END;
    v_amt := round(r.total, 8);
    v_expected := round(v_amt * COALESCE(v_rate, 1), 8);
    -- N3: a received amount that does not match the sale value (at the sale rate) is refused
    v_tol := CASE WHEN v_ccy = 'USD' THEN 0.01 ELSE GREATEST(1, abs(v_expected) * 0.001) END;
    IF _currency_amount IS NOT NULL AND abs(_currency_amount - v_expected) > v_tol THEN
      RAISE EXCEPTION 'مبلغ العملة المستلمة لا يطابق قيمة البيع بسعر الصرف المحدد';
    END IF;
    v_orig := COALESCE(_currency_amount, v_expected);

    -- The movement takes the sale's time (the invoice's created_at), so an offline sale lands on its own day.
    SELECT i.created_at INTO v_sale_ts FROM public.invoices i WHERE i.id = r.invoice_id;

    INSERT INTO public.shift_transactions (
      shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, notes, reference_id, created_at
    ) VALUES (
      _shift_id, v_owner, 'sale', v_amt, v_ccy, v_orig, COALESCE(v_rate, 1), 'مبيعات نقدية', _operation_id, COALESCE(v_sale_ts, now())
    )
    ON CONFLICT (shift_id, type, reference_id) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF v_inserted = 1 THEN
      UPDATE public.cash_shifts
         SET expected_balance = round(COALESCE(expected_balance, 0) + v_amt, 8),
             updated_at = now()
       WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL;
    END IF;
  END IF;

  RETURN QUERY SELECT r.success, r.already_processed, r.invoice_id, r.invoice_number, r.subtotal,
    r.discount, r.tax_amount, r.total, r.cogs, r.profit, r.debt_paid, r.debt_remaining, r.stock_shortage;
END;
$function$;
