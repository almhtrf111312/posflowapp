-- ============================================================================
-- Migration: 20261123040000_pkg4_periods_partners_and_locks.sql
-- Package 4: Historical Period Closing, Partner Share Validation, Lock Order,
--            Category Snapshot & Atomic Auto Partner Withdrawal
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Add category_snapshot to public.invoice_items & backfill from products
-- ----------------------------------------------------------------------------
ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS category_snapshot text;

UPDATE public.invoice_items ii
   SET category_snapshot = NULLIF(trim(p.category), '')
  FROM public.products p
 WHERE ii.product_id = p.id
   AND ii.category_snapshot IS NULL
   AND NULLIF(trim(p.category), '') IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. Update public.process_pos_sale_atomic
--    Snapshot product category onto invoice_items at sale time.
--    Preserves exact signature and all accounting formulas.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_pos_sale_atomic(
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
  _tax_mode text DEFAULT NULL::text
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
  _caller uuid := auth.uid();
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
    NOT (COALESCE(s.store_type, 'general') IN ('bakery', 'repair')),
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

  _next := public.get_next_invoice_number(_owner);
  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'إنشاء فاتورة بيع');
  _number := to_char(CURRENT_DATE, 'YYYYMMDD') || '-' || lpad(_next::text, 5, '0');

  INSERT INTO public.invoices(
    user_id, invoice_number, invoice_sequence, operation_id, invoice_type,
    date, time, cashier_id, cashier_name, customer_id, customer_name, customer_phone,
    subtotal, discount, discount_percentage, tax_rate, tax_amount, total, profit,
    currency, exchange_rate, payment_type, status, debt_paid, debt_remaining, warehouse_id,
    tax_inclusive, settlement_kind, settlement_diff_usd
  )
  SELECT
    _owner, _number, _next, trim(_operation_id), 'sale',
    CURRENT_DATE, CURRENT_TIME, _caller::text, p.full_name, _cust, _cname, NULLIF(trim(_customer_phone), ''),
    _sub, _disc, COALESCE(_discount_percentage, 0), _applied_tax_rate, _tax, _tot, 0,
    _clean_currency, _clean_exchange_rate, _payment_type,
    CASE WHEN _remaining > 0 THEN 'pending' ELSE 'paid' END,
    CASE WHEN _payment_type = 'debt' THEN _dp ELSE 0 END,
    _remaining, _warehouse_id,
    _inclusive, _kind, _diff
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
      total_purchases = round(COALESCE(c.total_purchases, 0) + _tot, 2),
      total_debt = round(COALESCE(c.total_debt, 0) + _remaining, 2),
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
-- 3. Update public.close_accounting_period_atomic
--    - Include expenses reversed AFTER _period_end
--    - Include i.paid_at_sale in inv CTE and credit_paid so down payments are
--      not lost when debt_payments exist
-- ----------------------------------------------------------------------------
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

  SELECT COALESCE(SUM(amount), 0) INTO _exp
    FROM public.expenses
   WHERE user_id = _owner
     AND (
       COALESCE(is_reversed, false) = false
       OR (reversed_at AT TIME ZONE _tz)::date > _period_end
     )
     AND date BETWEEN _period_start AND _period_end;

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

-- ----------------------------------------------------------------------------
-- 4. Update public.validate_partner_shares
--    Include expense_share_percentage in skip guard & validation
--    (reject negatives and ensure store-wide sum of
--    COALESCE(expense_share_percentage, share_percentage, 0) <= 100)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_partner_shares()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _total_pct numeric := 0;
  _other_pct numeric := 0;
  _total_exp_pct numeric := 0;
  _new_exp_pct numeric := 0;
  _cat record;
BEGIN
  -- Skip validation on updates that do not touch share configuration or owner
  IF TG_OP = 'UPDATE'
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.access_all IS NOT DISTINCT FROM OLD.access_all
     AND NEW.share_percentage IS NOT DISTINCT FROM OLD.share_percentage
     AND NEW.expense_share_percentage IS NOT DISTINCT FROM OLD.expense_share_percentage
     AND NEW.category_shares IS NOT DISTINCT FROM OLD.category_shares THEN
    RETURN NEW;
  END IF;

  -- Serialize concurrent share edits for the same store owner
  PERFORM pg_advisory_xact_lock(hashtext('partner_shares:' || NEW.user_id::text));

  -- Validate expense_share_percentage (non-negative and store-wide sum <= 100)
  IF NEW.expense_share_percentage IS NOT NULL AND NEW.expense_share_percentage < 0 THEN
    RAISE EXCEPTION 'نسبة مشاركة المصاريف للشريك لا يمكن أن تكون سالبة'
      USING ERRCODE = '22023';
  END IF;

  _new_exp_pct := COALESCE(NEW.expense_share_percentage, NEW.share_percentage, 0);
  IF _new_exp_pct < 0 THEN
    RAISE EXCEPTION 'نسبة مشاركة المصاريف للشريك لا يمكن أن تكون سالبة'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(SUM(COALESCE(expense_share_percentage, share_percentage, 0)), 0)
    INTO _total_exp_pct
  FROM public.partners
  WHERE user_id = NEW.user_id
    AND (TG_OP = 'INSERT' OR id <> OLD.id);

  IF round(_total_exp_pct + _new_exp_pct, 4) > 100 THEN
    RAISE EXCEPTION 'إجمالي نسب مشاركة المصاريف للشركاء يتجاوز 100%% (الإجمالي: %%%)',
      round(_total_exp_pct + _new_exp_pct, 2)
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE(NEW.access_all, false) = true THEN
    IF COALESCE(NEW.share_percentage, 0) < 0 THEN
      RAISE EXCEPTION 'نسبة الشريك لا يمكن أن تكون سالبة'
        USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(SUM(COALESCE(share_percentage, 0)), 0)
      INTO _total_pct
    FROM public.partners
    WHERE user_id = NEW.user_id
      AND COALESCE(access_all, false) = true
      AND (TG_OP = 'INSERT' OR id <> OLD.id);

    IF round(_total_pct + COALESCE(NEW.share_percentage, 0), 4) > 100 THEN
      RAISE EXCEPTION 'إجمالي نسب الشركاء العامين يتجاوز 100%% (الإجمالي: %%%)',
        round(_total_pct + COALESCE(NEW.share_percentage, 0), 2)
        USING ERRCODE = '22023';
    END IF;
  ELSIF NEW.category_shares IS NOT NULL AND jsonb_typeof(NEW.category_shares) = 'array' THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.category_shares) cs
      WHERE COALESCE((cs->>'enabled')::boolean, false) = true
        AND COALESCE((cs->>'percentage')::numeric, 0) < 0
    ) THEN
      RAISE EXCEPTION 'نسبة الشريك في الفئة لا يمكن أن تكون سالبة'
        USING ERRCODE = '22023';
    END IF;

    FOR _cat IN
      SELECT
        trim(cs->>'categoryName') AS category_name,
        SUM(COALESCE((cs->>'percentage')::numeric, 0)) AS new_pct
      FROM jsonb_array_elements(NEW.category_shares) cs
      WHERE COALESCE((cs->>'enabled')::boolean, false) = true
        AND NULLIF(trim(COALESCE(cs->>'categoryName', '')), '') IS NOT NULL
        AND COALESCE((cs->>'percentage')::numeric, 0) > 0
      GROUP BY trim(cs->>'categoryName')
    LOOP
      SELECT COALESCE(SUM(COALESCE((cs->>'percentage')::numeric, 0)), 0)
        INTO _other_pct
      FROM public.partners p,
           jsonb_array_elements(
             CASE
               WHEN p.category_shares IS NOT NULL AND jsonb_typeof(p.category_shares) = 'array'
               THEN p.category_shares
               ELSE '[]'::jsonb
             END
           ) cs
      WHERE p.user_id = NEW.user_id
        AND COALESCE(p.access_all, false) = false
        AND (TG_OP = 'INSERT' OR p.id <> OLD.id)
        AND COALESCE((cs->>'enabled')::boolean, false) = true
        AND trim(COALESCE(cs->>'categoryName', '')) = _cat.category_name
        AND COALESCE((cs->>'percentage')::numeric, 0) > 0;

      IF round(_other_pct + _cat.new_pct, 4) > 100 THEN
        RAISE EXCEPTION 'إجمالي نسب الشركاء للفئة "%" يتجاوز 100%% (الإجمالي: %%%)',
          _cat.category_name,
          round(_other_pct + _cat.new_pct, 2)
          USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 5. Update public.distribute_invoice_partner_profits_atomic
--    - Fix AB/BA deadlock: lock invoices row FOR UPDATE BEFORE advisory lock
--    - Use COALESCE(NULLIF(trim(ii.category_snapshot), ''), NULLIF(trim(p.category), ''), 'عام')
-- ----------------------------------------------------------------------------
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
        _partner_share := round((_cat_profit.total_category_profit * _eff_pct / 100.0), 4);

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
              pending_profit = round(COALESCE(pending_profit, 0) + _partner_share, 4),
              pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || _pending_detail,
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          ELSE
            UPDATE public.partners SET
              confirmed_profit = round(COALESCE(confirmed_profit, 0) + _partner_share, 4),
              current_balance = round(COALESCE(current_balance, 0) + _partner_share, 4),
              total_profit_earned = round(COALESCE(total_profit_earned, 0) + _partner_share, 4),
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
        _partner_share := round((_remaining_profit * _eff_pct / 100.0), 4);

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
              pending_profit = round(COALESCE(pending_profit, 0) + _partner_share, 4),
              pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || _pending_detail,
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          ELSE
            UPDATE public.partners SET
              confirmed_profit = round(COALESCE(confirmed_profit, 0) + _partner_share, 4),
              current_balance = round(COALESCE(current_balance, 0) + _partner_share, 4),
              total_profit_earned = round(COALESCE(total_profit_earned, 0) + _partner_share, 4),
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
$function$;

-- ----------------------------------------------------------------------------
-- 6. Update public.partner_withdrawal_atomic
--    - Support _withdrawal_type = 'auto' (profit first, remainder from capital,
--      in one transaction and one cashbox/shift_transactions entry)
--    - Add optional _operation_id text DEFAULT NULL at the end for idempotency
--    - Tighten FX validation (USD rate/amount checks & strict non-USD checks)
--    - Drop 8-arg overload first to avoid PostgREST PGRST203 ambiguity
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.partner_withdrawal_atomic(
  uuid, numeric, text, text, uuid, text, numeric, numeric
);

CREATE OR REPLACE FUNCTION public.partner_withdrawal_atomic(
  _partner_id uuid,
  _amount numeric,
  _withdrawal_type text,
  _notes text DEFAULT NULL::text,
  _shift_id uuid DEFAULT NULL::uuid,
  _currency text DEFAULT 'USD'::text,
  _original_amount numeric DEFAULT NULL::numeric,
  _exchange_rate numeric DEFAULT 1.0,
  _operation_id text DEFAULT NULL::text
)
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

  IF _withdrawal_type NOT IN ('profit', 'capital', 'auto') THEN
    RAISE EXCEPTION 'نوع السحب غير صالح: %', COALESCE(_withdrawal_type, 'NULL');
  END IF;

  IF v_amt <= 0 THEN
    RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر';
  END IF;

  IF v_op_id IS NOT NULL AND length(v_op_id) > 128 THEN
    RAISE EXCEPTION 'معرّف العملية غير صالح';
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
      IF abs(v_orig_amt - round(v_amt, 2)) > 0.05 THEN
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
      IF abs(v_orig_amt - round(v_amt * v_rate, 2)) > GREATEST(0.05, v_orig_amt * 0.01) THEN
        RAISE EXCEPTION 'تعارض في تحويل العملة: المبلغ الأصلي (%) لا يطابق المبلغ بالدولار (%) × سعر الصرف (%)',
          v_orig_amt, v_amt, v_rate;
      END IF;
    END IF;
  END IF;

  PERFORM public.assert_period_open(v_owner, CURRENT_DATE, 'سحب شريك');

  -- Lock partner row first (consistent lock order)
  SELECT * INTO v_partner FROM public.partners WHERE id = _partner_id FOR UPDATE;
  IF NOT FOUND OR v_partner.user_id <> v_owner THEN
    RAISE EXCEPTION 'الشريك غير موجود أو غير تابع للمتجر';
  END IF;

  -- Idempotency check when _operation_id is supplied
  IF v_op_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('partner_withdraw_op:' || v_owner::text || ':' || v_op_id));

    IF EXISTS (
      SELECT 1
        FROM public.partner_ledger_entries ple
       WHERE ple.user_id = v_owner
         AND ple.partner_id = _partner_id
         AND ple.source = 'partner_withdrawal_atomic'
         AND ple.reference = v_op_id
    ) OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_partner.withdrawal_history, '[]'::jsonb)) wh
       WHERE wh->>'operationId' = v_op_id
    ) THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_processed', true,
        'partner_id', _partner_id,
        'operation_id', v_op_id,
        'amount', v_amt,
        'currency', v_ccy,
        'original_amount', v_orig_amt,
        'withdrawal_type', _withdrawal_type,
        'profit_deducted', 0,
        'capital_deducted', 0,
        'new_balance', v_partner.current_balance,
        'new_capital', v_partner.current_capital
      );
    END IF;
  END IF;

  IF _shift_id IS NOT NULL THEN
    PERFORM 1 FROM public.cash_shifts
    WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
    END IF;
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

    IF v_profit_part > 0 THEN
      v_withdrawals := v_withdrawals || jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'id', gen_random_uuid()::text,
          'operationId', v_op_id,
          'amount', v_profit_part,
          'currency', v_ccy,
          'originalAmount', round(v_profit_part * v_rate, 2),
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
          'originalAmount', round(v_capital_part * v_rate, 2),
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
          'originalAmount', round(v_capital_part * v_rate, 2),
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

  RETURN jsonb_build_object(
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
END;
$function$;

REVOKE ALL ON FUNCTION public.partner_withdrawal_atomic(
  uuid, numeric, text, text, uuid, text, numeric, numeric, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_withdrawal_atomic(
  uuid, numeric, text, text, uuid, text, numeric, numeric, text
) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. Update public.refund_invoice_partial_atomic to use invoice_items.category_snapshot
--    (Applied here in pkg4 after category_snapshot column creation & backfill;
--     preserves exact 8-arg signature from pkg1 — zero overload)
-- ----------------------------------------------------------------------------
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

REVOKE ALL ON FUNCTION public.refund_invoice_partial_atomic(text, jsonb, text, uuid, text, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refund_invoice_partial_atomic(text, jsonb, text, uuid, text, numeric, numeric, text) TO authenticated;
