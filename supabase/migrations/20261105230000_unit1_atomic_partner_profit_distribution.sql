-- =============================================================================
-- UNIT 1: محرك التوزيع الذري لأرباح الشركاء + دمجه في دالة البيع
-- distribute_invoice_partner_profits_atomic
-- + PERFORM داخل process_pos_sale_atomic
-- =============================================================================

-- 1.1 دالة التوزيع الذري الجديدة
CREATE OR REPLACE FUNCTION public.distribute_invoice_partner_profits_atomic(
  _invoice_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  _profit_record jsonb;
  _pending_detail jsonb;
  _total_distributed numeric := 0;
  _distributions jsonb := '[]'::jsonb;
BEGIN
  -- جلب الفاتورة والتحقق من وجودها
  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  _owner := _inv.user_id;
  _is_debt := (_inv.payment_type = 'debt' AND COALESCE(_inv.debt_remaining, 0) > 0);

  -- Idempotency: التحقق من عدم التوزيع المسبق
  IF EXISTS (
    SELECT 1 FROM public.partners p
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb)) ph
    WHERE p.user_id = _owner AND ph->>'invoiceId' = _inv.invoice_number
  ) THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'invoice_number', _inv.invoice_number);
  END IF;

  -- إذا لم يكن هناك شركاء، نعود فوراً
  IF NOT EXISTS (SELECT 1 FROM public.partners WHERE user_id = _owner) THEN
    RETURN jsonb_build_object('success', true, 'no_partners', true, 'total_distributed', 0);
  END IF;

  -- تجميع الأرباح الصافية لكل تصنيف مباشرة من بنود الفاتورة
  FOR _cat_profit IN
    SELECT
      COALESCE(NULLIF(trim(p.category), ''), 'عام') AS category_name,
      round(SUM(COALESCE(ii.profit, 0)), 8) AS total_category_profit
    FROM public.invoice_items ii
    LEFT JOIN public.products p ON p.id = ii.product_id AND p.user_id = _owner
    WHERE ii.invoice_id = _invoice_id
    GROUP BY COALESCE(NULLIF(trim(p.category), ''), 'عام')
    HAVING SUM(COALESCE(ii.profit, 0)) > 0
  LOOP
    _remaining_profit := _cat_profit.total_category_profit;

    -- === المرحلة أ: الشركاء المتخصصون بتصنيف بعينه ===
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
        AND cs->>'categoryName' = _cat_profit.category_name
      LIMIT 1;

      IF _cat_share IS NOT NULL AND COALESCE((_cat_share->>'percentage')::numeric, 0) > 0 THEN
        _pct := (_cat_share->>'percentage')::numeric;
        _partner_share := round((_cat_profit.total_category_profit * _pct / 100.0), 4);

        IF _partner_share > 0 THEN
          _remaining_profit := _remaining_profit - _partner_share;
          _total_distributed := _total_distributed + _partner_share;

          _profit_record := jsonb_build_object(
            'id', extract(epoch from now())::text || '-' || _partner.id::text || '-' || _cat_profit.category_name,
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
              pending_profit        = round(COALESCE(pending_profit, 0) + _partner_share, 4),
              pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || _pending_detail,
              profit_history        = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at            = now()
            WHERE id = _partner.id;
          ELSE
            UPDATE public.partners SET
              confirmed_profit    = round(COALESCE(confirmed_profit, 0) + _partner_share, 4),
              current_balance     = round(COALESCE(current_balance, 0) + _partner_share, 4),
              total_profit_earned = round(COALESCE(total_profit_earned, 0) + _partner_share, 4),
              profit_history      = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at          = now()
            WHERE id = _partner.id;
          END IF;

          _distributions := _distributions || jsonb_build_object(
            'partnerId',   _partner.id,
            'partnerName', _partner.name,
            'amount',      _partner_share,
            'category',    _cat_profit.category_name
          );
        END IF;
      END IF;
    END LOOP;

    -- === المرحلة ب: الشركاء العامون على ما تبقى من ربح التصنيف ===
    IF _remaining_profit > 0 THEN
      FOR _partner IN
        SELECT * FROM public.partners
        WHERE user_id = _owner
          AND COALESCE(access_all, false) = true
          AND COALESCE(share_percentage, 0) > 0
        FOR UPDATE
      LOOP
        _partner_share := round((_remaining_profit * _partner.share_percentage / 100.0), 4);

        IF _partner_share > 0 THEN
          _total_distributed := _total_distributed + _partner_share;

          _profit_record := jsonb_build_object(
            'id', extract(epoch from now())::text || '-' || _partner.id::text || '-' || _cat_profit.category_name,
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
              pending_profit        = round(COALESCE(pending_profit, 0) + _partner_share, 4),
              pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || _pending_detail,
              profit_history        = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at            = now()
            WHERE id = _partner.id;
          ELSE
            UPDATE public.partners SET
              confirmed_profit    = round(COALESCE(confirmed_profit, 0) + _partner_share, 4),
              current_balance     = round(COALESCE(current_balance, 0) + _partner_share, 4),
              total_profit_earned = round(COALESCE(total_profit_earned, 0) + _partner_share, 4),
              profit_history      = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at          = now()
            WHERE id = _partner.id;
          END IF;

          _distributions := _distributions || jsonb_build_object(
            'partnerId',   _partner.id,
            'partnerName', _partner.name,
            'amount',      _partner_share,
            'category',    _cat_profit.category_name
          );
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success',           true,
    'invoice_id',        _invoice_id,
    'total_distributed', _total_distributed,
    'distributions',     _distributions
  );
END;
$$;

REVOKE ALL ON FUNCTION public.distribute_invoice_partner_profits_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distribute_invoice_partner_profits_atomic(uuid) TO authenticated;

-- 1.2 تحديث process_pos_sale_atomic لاستدعاء التوزيع الذري مباشرة بعد recalc
-- يُضاف سطر PERFORM مباشرة بعد PERFORM public.recalc_pos_invoice_profit
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
      quantity = pg_temp.pos_sale_items.quantity + EXCLUDED.quantity,
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
      SELECT ws.warehouse_id, ws.quantity INTO _src, _available
      FROM public.warehouse_stock ws
      INNER JOIN public.warehouses w ON w.id = ws.warehouse_id
      WHERE ws.product_id = _product_id AND w.user_id = _owner AND COALESCE(w.is_active, true)
        AND ws.quantity > 0
      ORDER BY ws.quantity DESC
      LIMIT 1 FOR UPDATE;
    END IF;

    IF _src IS NULL THEN
      SELECT p.quantity INTO _available
      FROM public.products p
      WHERE p.id = _product_id AND p.user_id = _owner FOR UPDATE;
    END IF;

    _need := CASE WHEN _unit = 'bulk' THEN _quantity * GREATEST(COALESCE(_conv, 1), 1) ELSE _quantity END;

    IF COALESCE(_available, 0) < _need THEN
      _shortage := true;
    END IF;

    UPDATE pg_temp.pos_sale_items SET source_warehouse_id = _src WHERE product_id = _product_id;
  END LOOP;

  -- بناء الفاتورة
  SELECT COALESCE(NULLIF(c.id::text, ''), NULL)::uuid INTO _cust
  FROM public.customers c
  WHERE c.user_id = _owner AND COALESCE(NULLIF(trim(_customer_name), ''), '') <> ''
    AND (c.name = trim(_customer_name) OR (NULLIF(trim(_customer_phone), '') IS NOT NULL AND c.phone = trim(_customer_phone)))
  LIMIT 1;

  _cname := NULLIF(trim(_customer_name), '');

  _sub  := round(COALESCE(_subtotal, 0), 2);
  _disc := round(LEAST(COALESCE(_discount, 0), _sub), 2);

  IF _tax_mode IS NOT NULL AND _tax_mode = 'inclusive' THEN
    _inclusive := true;
    _kind := 'inclusive';
  END IF;

  IF _tax_enabled AND COALESCE(_tax_rate, _store_tax_rate, 0) > 0 THEN
    _applied_tax_rate := COALESCE(_tax_rate, _store_tax_rate);
    IF _inclusive THEN
      _tax := round((_sub - _disc) * (_applied_tax_rate / (100 + _applied_tax_rate)), 2);
    ELSE
      _tax := round((_sub - _disc) * _applied_tax_rate / 100, 2);
    END IF;
  ELSE
    _applied_tax_rate := 0;
    _tax := 0;
  END IF;

  IF _inclusive THEN
    _tot := round(_sub - _disc, 2);
  ELSE
    _tot := round(_sub - _disc + _tax, 2);
  END IF;

  _dp := LEAST(round(COALESCE(_down_payment, 0), 2), _tot);
  _remaining := GREATEST(round(_tot - _dp, 2), 0);

  SELECT COALESCE(MAX(seq), 0) + 1 INTO _next FROM public.invoice_sequences WHERE user_id = _owner FOR UPDATE;
  INSERT INTO public.invoice_sequences(user_id, seq) VALUES (_owner, _next)
  ON CONFLICT(user_id) DO UPDATE SET seq = EXCLUDED.seq;
  _number := 'INV-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(_next::text, 5, '0');

  INSERT INTO public.invoices(
    user_id, operation_id, invoice_number, customer_name, customer_phone, customer_id,
    subtotal, discount, discount_percentage, tax_rate, tax_amount, total,
    profit, payment_type, status, currency, exchange_rate, tax_mode,
    debt_paid, debt_remaining, cashier_id, warehouse_id, warehouse_name
  ) VALUES (
    _owner, trim(_operation_id), _number, _cname, NULLIF(trim(_customer_phone), ''), _cust,
    _sub, _disc, COALESCE(_discount_percentage, 0), _applied_tax_rate, _tax, _tot,
    0, _payment_type,
    CASE WHEN _payment_type = 'cash' THEN 'paid' WHEN _dp >= _tot THEN 'paid' ELSE 'pending' END,
    _clean_currency, _clean_exchange_rate, _kind,
    _dp, _remaining, _caller, _warehouse_id, _warehouse_name
  )
  RETURNING * INTO _new_invoice;

  INSERT INTO public.invoice_items(
    invoice_id, product_id, product_name, quantity, unit_price,
    cost_price, currency, amount_original, amount_usd, profit, unit, conversion_factor,
    stock_warehouse_id
  )
  SELECT
    _new_invoice.id, psi.product_id, psi.product_name, psi.quantity, psi.unit_price,
    0, _clean_currency, psi.amount_original, psi.amount_usd, 0, psi.unit, psi.conversion_factor,
    CASE WHEN _track_inventory THEN psi.source_warehouse_id ELSE NULL END
  FROM pg_temp.pos_sale_items psi;

  -- حساب الأرباح آلياً بدقة 8 منازل واستبعاد الضريبة
  PERFORM public.recalc_pos_invoice_profit(_new_invoice.id);

  -- ✅ توزيع أرباح الشركاء ذرياً في نفس العملية وحماية الأرصدة من Race Condition
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

  IF _remaining > 0 THEN
    INSERT INTO public.debts(
      user_id, invoice_id, customer_name, customer_phone, total_debt,
      total_paid, remaining_debt, due_date, status, is_cash_debt, cashier_id
    )
    VALUES(
      _owner, _new_invoice.invoice_number, COALESCE(_cname, 'عميل بيع مؤجل'),
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

REVOKE ALL ON FUNCTION public.process_pos_sale_atomic(text, text, text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, text, uuid, jsonb, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_pos_sale_atomic(text, text, text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, text, uuid, jsonb, numeric, numeric, text) TO authenticated;
