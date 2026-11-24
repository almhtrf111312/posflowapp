-- Restaurant = no inventory (2026-11-24, owner decision option A + cost of goods counted in profit).
-- A restaurant sale never refuses for stock and never deducts stock (menu items are not stock).
-- Its raw materials are expenses, so do not record the same cost twice.
-- Bakery and repair behave exactly as before. The three functions below are their latest definitions
-- with only the store-type list changed: ('bakery','repair') -> ('bakery','repair','restaurant').
-- Written by the implementing agent; NOT applied. The owner pastes it into the SQL editor.

CREATE OR REPLACE FUNCTION public.process_pos_sale_atomic(_operation_id text, _payment_type text, _customer_name text, _customer_phone text, _subtotal numeric, _discount numeric, _discount_percentage numeric, _tax_rate numeric, _tax_amount numeric, _total numeric, _profit numeric, _currency text, _warehouse_id uuid, _items jsonb, _down_payment numeric DEFAULT 0, _exchange_rate numeric DEFAULT NULL::numeric, _tax_mode text DEFAULT NULL::text, _sale_at timestamptz DEFAULT NULL::timestamptz)
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

CREATE OR REPLACE FUNCTION public.refund_invoice_atomic(_invoice_number text, _source text DEFAULT 'online'::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT NULL::text, _currency_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT NULL::numeric, _settlement_mode text DEFAULT 'drawer'::text)
 RETURNS TABLE(success boolean, already_refunded boolean, invoice_id uuid, invoice_number text, invoice_total numeric, invoice_currency text, restored_item_count integer, restored_unit_count numeric, deleted_debt_amount numeric, customer_name text)
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
  _track_inventory := NOT (COALESCE(_store_type, 'general') IN ('bakery', 'repair', 'restaurant'));

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
     AND profit_records.invoice_id IN (_invoice.invoice_number, _invoice.id::text)
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
