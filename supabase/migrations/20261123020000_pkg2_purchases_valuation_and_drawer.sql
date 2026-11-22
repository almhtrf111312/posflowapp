-- ============================================================================
-- Migration: 20261123020000_pkg2_purchases_valuation_and_drawer.sql
-- Package 2: Purchases, Inventory Valuation Adjustments & Supplier Drawer Helper
-- Target DB: PosFlow (bwlqfxfvchjvehnbvwaz)
-- Idempotent & Surgical SQL Migration
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Add finalized_at to public.purchase_invoices and backfill existing records
-- ----------------------------------------------------------------------------
ALTER TABLE public.purchase_invoices
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz;

UPDATE public.purchase_invoices
   SET finalized_at = COALESCE(updated_at, created_at)
 WHERE finalized_at IS NULL
   AND status IN ('finalized', 'completed');

CREATE INDEX IF NOT EXISTS idx_purchase_invoices_user_finalized_at
  ON public.purchase_invoices (user_id, finalized_at DESC)
  WHERE finalized_at IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. Create public.inventory_valuation_adjustments with RLS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inventory_valuation_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  product_id uuid NOT NULL,
  variance_usd numeric NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_val_adj_user_created
  ON public.inventory_valuation_adjustments (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inv_val_adj_source
  ON public.inventory_valuation_adjustments (source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_inv_val_adj_product
  ON public.inventory_valuation_adjustments (user_id, product_id);

ALTER TABLE public.inventory_valuation_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inv_val_adj_select_owner" ON public.inventory_valuation_adjustments;
CREATE POLICY "inv_val_adj_select_owner"
  ON public.inventory_valuation_adjustments
  FOR SELECT
  TO authenticated
  USING (user_id = public.get_owner_id((SELECT auth.uid())));

DROP POLICY IF EXISTS "inv_val_adj_insert_owner" ON public.inventory_valuation_adjustments;
CREATE POLICY "inv_val_adj_insert_owner"
  ON public.inventory_valuation_adjustments
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = public.get_owner_id((SELECT auth.uid())));

REVOKE ALL ON TABLE public.inventory_valuation_adjustments FROM anon;
GRANT SELECT, INSERT ON TABLE public.inventory_valuation_adjustments TO authenticated;
GRANT ALL ON TABLE public.inventory_valuation_adjustments TO service_role;

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
       SET expected_balance = round(COALESCE(expected_balance, 0) + _delta, 2),
           updated_at = now()
     WHERE id = _shift AND user_id = _owner AND closed_at IS NULL;
  END IF;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 4. Fix public.edit_purchase_invoice_atomic
--    - Early purchase_returns guard
--    - Immediate split by status: draft/reconciled vs finalized/completed
--    - Respects _no_inventory, finalized_at subsequent-sale check, and logs variance
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.edit_purchase_invoice_atomic(
  _invoice_id uuid,
  _new_lines jsonb,
  _op_id text,
  _reason text DEFAULT 'Purchase invoice edit'::text
)
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

    IF COALESCE(_orig_inv.amount_paid, 0) > 0 THEN
      INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, created_by)
      VALUES (_owner, _orig_inv.supplier_id, 'payment', -round(_orig_inv.amount_paid, 4), 'purchase_invoice', _new_invoice_id::text, 'دفعة منقولة من الفاتورة الأصلية', _caller);
    END IF;

    UPDATE public.purchase_invoices
       SET supplier_id = _orig_inv.supplier_id,
           amount_paid = LEAST(COALESCE(_orig_inv.amount_paid, 0), round(_grand_total, 4))
     WHERE id = _new_invoice_id;
  END IF;

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

-- ----------------------------------------------------------------------------
-- 5. Fix public.finalize_purchase_invoice_atomic
--    - Set finalized_at = now()
--    - Sync actual_grand_total, actual_total_quantity, actual_items_count from items
-- ----------------------------------------------------------------------------
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
        round(_inv.paid_currency_amount, 4),
        round(_inv.amount_paid * _inv.paid_rate, 4);
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
         actual_grand_total = round(_grand_total, 4),
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
      _tot numeric := round(_grand_total, 4);
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
          -round(_paid, 4),
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
    'actual_grand_total', round(_grand_total, 4)
  );
END;
$function$;

-- ----------------------------------------------------------------------------
-- 6. Fix public.link_purchase_to_supplier_atomic
--    - Compute/confirm supplier total from finalized invoice items and sync header
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.link_purchase_to_supplier_atomic(
  _invoice_id uuid,
  _supplier_id uuid,
  _paid_amount numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _o uuid := public._supplier_owner();
  _inv record;
  _items_count int := 0;
  _total_qty numeric := 0;
  _items_total numeric := 0;
  _total numeric;
  _paid numeric := GREATEST(COALESCE(_paid_amount, 0), 0);
BEGIN
  SELECT * INTO _inv
    FROM public.purchase_invoices
   WHERE id = _invoice_id AND user_id = _o
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'فاتورة الشراء غير موجودة';
  END IF;

  PERFORM 1
    FROM public.suppliers
   WHERE id = _supplier_id AND user_id = _o AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'المورد غير موجود أو غير فعّال';
  END IF;

  IF _inv.supplier_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'already_linked', true);
  END IF;

  IF COALESCE(_inv.payment_status, '') = 'cancelled' OR COALESCE(_inv.status, '') = 'cancelled' THEN
    RAISE EXCEPTION 'الفاتورة ملغاة';
  END IF;

  IF COALESCE(_inv.status, 'draft') NOT IN ('finalized', 'completed') THEN
    RAISE EXCEPTION 'يجب اعتماد فاتورة الشراء قبل ربطها بمورد';
  END IF;

  PERFORM public.assert_period_open(_o, _inv.invoice_date::date, 'ربط فاتورة شراء بمورد');

  SELECT COUNT(*)::int,
         COALESCE(SUM(quantity), 0),
         COALESCE(SUM(quantity * COALESCE(cost_price, 0)), 0)
    INTO _items_count, _total_qty, _items_total
    FROM public.purchase_invoice_items
   WHERE invoice_id = _invoice_id;

  _total := CASE
    WHEN _items_count > 0 THEN round(_items_total, 4)
    ELSE round(COALESCE(_inv.actual_grand_total, _inv.expected_grand_total, 0), 4)
  END;

  IF _total <= 0 THEN
    RAISE EXCEPTION 'إجمالي الفاتورة صفر';
  END IF;

  IF _paid > _total + 0.0001 THEN
    RAISE EXCEPTION 'المدفوع أكبر من إجمالي الفاتورة';
  END IF;

  INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, created_by)
  VALUES (_o, _supplier_id, 'purchase', _total, 'purchase_invoice', _invoice_id::text, 'فاتورة شراء ' || _inv.invoice_number, auth.uid());

  IF _paid > 0 THEN
    INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, payment_method, note, created_by)
    VALUES (_o, _supplier_id, 'payment', -round(_paid, 4), 'purchase_invoice', _invoice_id::text, _inv.payment_method, 'دفعة عند الشراء ' || _inv.invoice_number, auth.uid());
  END IF;

  UPDATE public.purchase_invoices
     SET supplier_id = _supplier_id,
         amount_paid = _paid,
         actual_items_count = CASE WHEN _items_count > 0 THEN _items_count ELSE actual_items_count END,
         actual_total_quantity = CASE WHEN _items_count > 0 THEN _total_qty ELSE actual_total_quantity END,
         actual_grand_total = CASE WHEN _items_count > 0 THEN _total ELSE actual_grand_total END,
         updated_at = now()
   WHERE id = _invoice_id;

  RETURN jsonb_build_object('success', true, 'total', _total, 'paid', _paid, 'due', _total - _paid);
END;
$function$;

-- ----------------------------------------------------------------------------
-- 7. Fix public.cancel_purchase_invoice_atomic
--    - Use COALESCE(_orig_inv.finalized_at, _orig_inv.created_at) for subsequent sales
--    - For _no_inventory: do not restore cost_price_before if a newer finalized purchase exists
--    - Compute & log v_variance in public.inventory_valuation_adjustments when <> 0
-- ----------------------------------------------------------------------------
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
        SELECT id INTO _open_shift_id
          FROM public.cash_shifts
         WHERE user_id = _owner
           AND closed_at IS NULL
         ORDER BY opened_at DESC
         LIMIT 1
           FOR UPDATE;
      END IF;

      IF _open_shift_id IS NULL THEN
        RAISE EXCEPTION 'لا توجد وردية مفتوحة لتسجيل استرداد دفعة المورد إلى الصندوق عند إلغاء الفاتورة';
      END IF;

      SELECT currency, currency_amount, exchange_rate INTO _t
        FROM public.shift_transactions
       WHERE reference_id = 'purchase:' || _invoice_id::text
         AND type = 'supplier_payment'
       LIMIT 1;

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

-- ----------------------------------------------------------------------------
-- 8. Fix public.purchase_return_atomic
--    - Unify _qty := round(..., 3) before stock deduction or financial math
--    - Use COALESCE(_inv.finalized_at, _inv.created_at) for subsequent sales
--    - Compute & log v_variance in public.inventory_valuation_adjustments when <> 0
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purchase_return_atomic(
  _invoice_id uuid,
  _lines jsonb,
  _reason text,
  _operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _o uuid := public._supplier_owner();
  _inv record;
  _rid uuid;
  _l jsonb;
  _it record;
  _qty numeric;
  _returned numeric;
  _stock numeric;
  _cur_cost numeric;
  _new_stock numeric;
  _new_cost numeric;
  _calc_cost numeric;
  _rem_val numeric;
  v_variance numeric := 0;
  _no_inventory boolean := false;
  _has_subsequent_sale boolean := false;
  _total numeric := 0;
  _num text;
BEGIN
  IF COALESCE(_operation_id, '') = '' THEN
    RAISE EXCEPTION 'معرّف العملية مطلوب';
  END IF;

  SELECT id INTO _rid
    FROM public.purchase_returns
   WHERE user_id = _o AND operation_id = _operation_id;
  IF _rid IS NOT NULL THEN
    RETURN _rid;
  END IF;

  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'لا توجد بنود للمرتجع';
  END IF;

  SELECT * INTO _inv
    FROM public.purchase_invoices
   WHERE id = _invoice_id AND user_id = _o
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'فاتورة الشراء غير موجودة';
  END IF;

  IF COALESCE(_inv.payment_status, '') = 'cancelled' OR COALESCE(_inv.status, '') = 'cancelled' THEN
    RAISE EXCEPTION 'الفاتورة ملغاة';
  END IF;

  IF COALESCE(_inv.status, 'draft') NOT IN ('finalized', 'completed') THEN
    RAISE EXCEPTION 'لا يمكن عمل مرتجع لفاتورة شراء غير معتمدة';
  END IF;

  IF _inv.replaced_by IS NOT NULL THEN
    RAISE EXCEPTION 'الفاتورة استُبدلت بفاتورة معدّلة';
  END IF;

  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'مرتجع مشتريات');

  SELECT COALESCE(s.store_type, 'general') IN ('bakery', 'repair')
    INTO _no_inventory
    FROM public.stores s
   WHERE s.user_id = _o
   LIMIT 1;
  _no_inventory := COALESCE(_no_inventory, false);

  _num := 'PR-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6);
  INSERT INTO public.purchase_returns(user_id, invoice_id, supplier_id, return_number, total_amount, reason, operation_id, created_by)
  VALUES (_o, _invoice_id, _inv.supplier_id, _num, 0, _reason, _operation_id, auth.uid())
  RETURNING id INTO _rid;

  PERFORM set_config('app.stock_movement_type', 'purchase_return', true);
  PERFORM set_config('app.stock_actor_id', auth.uid()::text, true);
  PERFORM set_config('app.stock_source', 'purchase_return_atomic', true);

  FOR _l IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _qty := round((_l->>'quantity')::numeric, 3);
    IF _qty IS NULL OR _qty <= 0 THEN
      RAISE EXCEPTION 'كمية غير صالحة';
    END IF;

    SELECT * INTO _it
      FROM public.purchase_invoice_items
     WHERE id = (_l->>'item_id')::uuid AND invoice_id = _invoice_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'بند غير تابع للفاتورة';
    END IF;

    SELECT COALESCE(SUM(quantity), 0) INTO _returned
      FROM public.purchase_return_items
     WHERE invoice_item_id = _it.id;
    IF _returned + _qty > _it.quantity THEN
      RAISE EXCEPTION 'كمية المرتجع من "%" تتجاوز المشتراة (المتبقي %)', _it.product_name, _it.quantity - _returned;
    END IF;

    IF _it.product_id IS NOT NULL AND NOT _no_inventory THEN
      SELECT quantity, cost_price INTO _stock, _cur_cost
        FROM public.products
       WHERE id = _it.product_id AND user_id = _o
         FOR UPDATE;
      IF FOUND THEN
        IF COALESCE(_stock, 0) < _qty THEN
          RAISE EXCEPTION 'مخزون "%" أقل من كمية المرتجع (بيع جزء منه)', _it.product_name;
        END IF;

        _new_stock := round(COALESCE(_stock, 0) - _qty, 3);
        _rem_val := (COALESCE(_stock, 0) * COALESCE(_cur_cost, 0))
                  - (_qty * COALESCE(_it.cost_price, 0));

        SELECT EXISTS (
          SELECT 1
            FROM public.invoice_items ii
            JOIN public.invoices inv ON inv.id = ii.invoice_id
           WHERE ii.product_id = _it.product_id
             AND inv.user_id = _o
             AND COALESCE(inv.status, '') NOT IN ('cancelled', 'refunded', 'void', 'voided')
             AND inv.created_at > COALESCE(_inv.finalized_at, _inv.created_at)
        ) INTO _has_subsequent_sale;

        IF _has_subsequent_sale THEN
          -- Perpetual moving average (IAS 2): do not distort remaining inventory cost after intervening sales
          _new_cost := COALESCE(_cur_cost, 0);
        ELSIF _new_stock > 0 AND _rem_val > 0 THEN
          _calc_cost := round(_rem_val / _new_stock, 8);
          IF _calc_cost <= 0
             OR _calc_cost > GREATEST(COALESCE(_cur_cost, 0), COALESCE(_it.cost_price, 0), COALESCE(_it.cost_price_before, COALESCE(_cur_cost, 0)))
             OR _calc_cost < LEAST(COALESCE(_cur_cost, 0), COALESCE(_it.cost_price, 0), COALESCE(_it.cost_price_before, COALESCE(_cur_cost, 0))) THEN
            _new_cost := COALESCE(_cur_cost, 0);
          ELSE
            _new_cost := _calc_cost;
          END IF;
        ELSE
          _new_cost := COALESCE(_cur_cost, 0);
        END IF;

        v_variance := round((_new_stock * _new_cost) - _rem_val, 4);
        IF v_variance <> 0 THEN
          INSERT INTO public.inventory_valuation_adjustments(
            user_id, source_type, source_id, product_id, variance_usd, notes
          ) VALUES (
            _o,
            'purchase_return',
            _rid,
            _it.product_id,
            v_variance,
            'فرق تقييم مخزون عند مرتجع الشراء ' || _num || ' للفاتورة ' || COALESCE(_inv.invoice_number, '')
          );
        END IF;

        UPDATE public.products
           SET cost_price = _new_cost,
               quantity = _new_stock,
               updated_at = now()
         WHERE id = _it.product_id;
      END IF;
    END IF;

    IF _it.product_id IS NOT NULL AND (SELECT track_serials FROM public.products WHERE id = _it.product_id) THEN
      DECLARE
        _ser text[];
        _cnt int;
      BEGIN
        SELECT COALESCE(array_agg(x), '{}'::text[]) INTO _ser
          FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(_l->'serials') = 'array' THEN _l->'serials' ELSE '[]'::jsonb END
          ) x;

        IF cardinality(_ser) <> _qty THEN
          RAISE EXCEPTION 'المنتج "%" يتطلب تحديد % رقم تسلسلي للمرتجع', _it.product_name, _qty;
        END IF;

        UPDATE public.product_serials ps
           SET status = 'returned_to_supplier', updated_at = now()
         WHERE ps.user_id = _o
           AND ps.product_id = _it.product_id
           AND ps.status = 'in_stock'
           AND ps.purchase_invoice_id = _invoice_id
           AND lower(ps.serial) = ANY(SELECT lower(trim(y)) FROM unnest(_ser) y);
        GET DIAGNOSTICS _cnt = ROW_COUNT;
        IF _cnt <> cardinality(_ser) THEN
          RAISE EXCEPTION 'رقم تسلسلي غير متوفر في المخزون أو غير تابع لهذه الفاتورة للمنتج "%"', _it.product_name;
        END IF;

        INSERT INTO public.product_serial_events(user_id, serial_id, event, ref, actor)
        SELECT _o, ps.id, 'returned_to_supplier', _num, auth.uid()
          FROM public.product_serials ps
         WHERE ps.user_id = _o
           AND ps.product_id = _it.product_id
           AND ps.status = 'returned_to_supplier'
           AND ps.purchase_invoice_id = _invoice_id
           AND lower(ps.serial) = ANY(SELECT lower(trim(y)) FROM unnest(_ser) y);
      END;
    END IF;

    INSERT INTO public.purchase_return_items(return_id, invoice_item_id, product_id, product_name, quantity, unit_cost, total_cost)
    VALUES (_rid, _it.id, _it.product_id, _it.product_name, _qty, COALESCE(_it.cost_price, 0), round(_qty * COALESCE(_it.cost_price, 0), 4));

    _total := _total + round(_qty * COALESCE(_it.cost_price, 0), 4);
  END LOOP;

  UPDATE public.purchase_returns SET total_amount = _total WHERE id = _rid;

  IF _inv.supplier_id IS NOT NULL AND _total > 0 THEN
    INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, operation_id, created_by)
    VALUES (_o, _inv.supplier_id, 'purchase_return', -_total, 'purchase_return', _rid::text, 'مرتجع ' || _num || ' للفاتورة ' || _inv.invoice_number, _operation_id, auth.uid());
  END IF;

  RETURN _rid;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 9. Fix public.record_stock_damage_atomic
--    - Unify _qty := round(COALESCE(_quantity, 0), 3) before stock & financial ops
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_stock_damage_atomic(
  _product_id uuid,
  _warehouse_id uuid,
  _quantity numeric,
  _unit_cost numeric DEFAULT NULL::numeric,
  _reason text DEFAULT NULL::text,
  _notes text DEFAULT NULL::text,
  _apply_to_stock boolean DEFAULT true,
  _source text DEFAULT 'manual'::text,
  _source_ref text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _p record;
  _qty numeric;
  _ws_qty numeric;
  _cost numeric;
  _id uuid;
  _name text;
  _ref_uuid uuid;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'owner not found';
  END IF;

  _qty := round(COALESCE(_quantity, 0), 3);
  IF _qty <= 0 THEN
    RAISE EXCEPTION 'الكمية يجب أن تكون أكبر من الصفر';
  END IF;

  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'تسجيل تالف');

  IF _warehouse_id IS NOT NULL THEN
    PERFORM 1 FROM public.warehouses WHERE id = _warehouse_id AND user_id = _owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'المستودع غير موجود أو لا يتبع لهذا المتجر';
    END IF;
  END IF;

  SELECT id, name, quantity, cost_price
    INTO _p
    FROM public.products
   WHERE id = _product_id AND user_id = _owner
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'المنتج غير موجود';
  END IF;

  _cost := COALESCE(_unit_cost, _p.cost_price, 0);
  IF _cost < 0 THEN
    RAISE EXCEPTION 'التكلفة غير صالحة';
  END IF;

  IF COALESCE(_apply_to_stock, true) THEN
    PERFORM set_config('app.stock_movement_type', 'damage', true);
    PERFORM set_config('app.stock_actor_id', _caller::text, true);
    PERFORM set_config('app.stock_source', 'record_stock_damage_atomic', true);

    IF _warehouse_id IS NOT NULL THEN
      SELECT quantity
        INTO _ws_qty
        FROM public.warehouse_stock
       WHERE warehouse_id = _warehouse_id AND product_id = _product_id
         FOR UPDATE;

      IF NOT FOUND OR COALESCE(_ws_qty, 0) < _qty THEN
        RAISE EXCEPTION 'الكمية التالفة (%) أكبر من المخزون المتاح في المستودع (%)', _qty, COALESCE(_ws_qty, 0);
      END IF;

      UPDATE public.warehouse_stock
         SET quantity = round(_ws_qty - _qty, 3),
             last_updated = now()
       WHERE warehouse_id = _warehouse_id AND product_id = _product_id;
    ELSE
      IF COALESCE(_p.quantity, 0) < _qty THEN
        RAISE EXCEPTION 'الكمية التالفة (%) أكبر من المخزون المتاح (%)', _qty, COALESCE(_p.quantity, 0);
      END IF;

      UPDATE public.products
         SET quantity = round(quantity - _qty, 3),
             updated_at = now()
       WHERE id = _product_id;
    END IF;
  END IF;

  SELECT COALESCE(full_name, 'مستخدم') INTO _name
    FROM public.profiles
   WHERE user_id = _caller;

  _ref_uuid := CASE
    WHEN _source_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN _source_ref::uuid
    ELSE NULL
  END;

  INSERT INTO public.stock_damages(
    user_id, product_id, product_name, warehouse_id, quantity, unit_cost, cost_value,
    reason, notes, damaged_at, recorded_by, recorded_by_name, source, source_ref
  ) VALUES (
    _owner, _product_id, _p.name, _warehouse_id, _qty, _cost, round(_qty * _cost, 8),
    _reason, _notes, now(), _caller, COALESCE(_name, 'مستخدم'), COALESCE(_source, 'manual'), _ref_uuid
  ) RETURNING id INTO _id;

  RETURN _id;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 10. Preserve exact function permissions (revoke anon/PUBLIC, grant authenticated)
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._supplier_drawer_tx(uuid, uuid, text, numeric, text, numeric, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._supplier_drawer_tx(uuid, uuid, text, numeric, text, numeric, numeric, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.edit_purchase_invoice_atomic(uuid, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_purchase_invoice_atomic(uuid, jsonb, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.finalize_purchase_invoice_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_purchase_invoice_atomic(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.link_purchase_to_supplier_atomic(uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_purchase_to_supplier_atomic(uuid, uuid, numeric) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.cancel_purchase_invoice_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_invoice_atomic(uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.purchase_return_atomic(uuid, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purchase_return_atomic(uuid, jsonb, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.record_stock_damage_atomic(uuid, uuid, numeric, numeric, text, text, boolean, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_stock_damage_atomic(uuid, uuid, numeric, numeric, text, text, boolean, text, text) TO authenticated, service_role;

COMMIT;
