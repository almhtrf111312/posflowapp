-- =============================================================================
-- Migration: 20261122160000_posflow_accounting_core_fixes_part1.sql
-- Scope: Sales, Refunds, Customer Debts, Store Credit, and anon Hardening
-- Applied live on bwlqfxfvchjvehnbvwaz (verified via Wave-1 + Wave-2 audit).
-- =============================================================================

-- 1) recalc_pos_invoice_profit: fix bulk cost when p.cost_price = 0 & p.bulk_cost_price > 0
CREATE OR REPLACE FUNCTION public.recalc_pos_invoice_profit(_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE;
  _cogs numeric;
  _sub numeric;
  _f numeric := 1;
BEGIN
  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF COALESCE(_inv.tax_inclusive, false) AND COALESCE(_inv.tax_rate, 0) > 0 THEN
    _f := 1 / (1 + _inv.tax_rate / 100);
  END IF;

  UPDATE public.invoice_items ii
     SET cost_price = CASE
           WHEN COALESCE(ii.cost_price, 0) <> 0 THEN ii.cost_price
           WHEN COALESCE(ii.unit, 'piece') = 'bulk' THEN
             CASE
               WHEN COALESCE(p.bulk_cost_price, 0) > 0 THEN round(p.bulk_cost_price, 8)
               ELSE round(COALESCE(p.cost_price, 0) * GREATEST(COALESCE(ii.conversion_factor, 1), 1), 8)
             END
           ELSE round(COALESCE(p.cost_price, 0), 8)
         END,
         warranty_until = COALESCE(
           ii.warranty_until,
           CASE WHEN p.warranty_months IS NOT NULL THEN (_inv.date + make_interval(months => p.warranty_months))::date ELSE NULL END
         )
    FROM public.products p
   WHERE ii.invoice_id = _invoice_id AND p.id = ii.product_id AND p.user_id = _inv.user_id;

  SELECT COALESCE(SUM(COALESCE(cost_price, 0) * COALESCE(quantity, 0)), 0),
         COALESCE(SUM(COALESCE(unit_price, 0) * COALESCE(quantity, 0)), 0)
    INTO _cogs, _sub FROM public.invoice_items WHERE invoice_id = _invoice_id;

  UPDATE public.invoice_items
     SET profit = round(((COALESCE(unit_price, 0) * COALESCE(quantity, 0))
                  - CASE WHEN _sub > 0 THEN COALESCE(_inv.discount, 0) * (COALESCE(unit_price, 0) * COALESCE(quantity, 0)) / _sub ELSE 0 END) * _f
                  - COALESCE(cost_price, 0) * COALESCE(quantity, 0), 8)
   WHERE invoice_id = _invoice_id;

  UPDATE public.invoices
     SET profit = round((COALESCE(subtotal, _sub) - COALESCE(discount, 0)) * _f - _cogs, 8)
   WHERE id = _invoice_id;
END;
$function$;

-- 2) mark_invoice_digital: enforce row lock, status guard, and closed-period check
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

  UPDATE public.invoices
     SET payment_method = 'digital',
         updated_at = now()
   WHERE id = _inv.id;

  RETURN true;
END $function$;

-- 3) refund_invoice_atomic: block cancelled/written_off, skip stock for bakery/repair, zero debt_remaining
CREATE OR REPLACE FUNCTION public.refund_invoice_atomic(_invoice_number text, _source text DEFAULT 'online'::text)
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

  SELECT EXISTS(
    SELECT 1 FROM public.stock_movements sm
    WHERE sm.user_id = _owner AND sm.invoice_id = _invoice.id AND sm.movement_type = 'refund'
  ) INTO _has_refund;

  IF _invoice.status = 'refunded' OR _has_refund THEN
    RETURN QUERY SELECT false, true, _invoice.id, _invoice.invoice_number, COALESCE(_invoice.total, 0)::numeric, _invoice.currency::text, 0, 0::numeric, 0::numeric, _invoice.customer_name::text;
    RETURN;
  END IF;

  PERFORM public.assert_period_open(_owner, _invoice.date, 'استرداد الفاتورة');

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

  INSERT INTO public.activity_log(user_id, actor_id, actor_name, actor_role, action_type, entity_type, entity_id, entity_name, description, metadata)
  SELECT
    _owner, _caller, COALESCE(p.full_name, _invoice.cashier_name, 'مستخدم'), ur.role::text,
    'invoice_refunded', 'invoice', _invoice.id::text, _invoice.invoice_number,
    'تم استرداد الفاتورة ' || _invoice.invoice_number,
    jsonb_build_object('invoice_number', _invoice.invoice_number, 'invoice_total', COALESCE(_invoice.total, 0), 'invoice_currency', _invoice.currency, 'restored_items', _restored_items, 'restored_units', _restored_units, 'deleted_debt_amount', _deleted_debt, 'source', CASE WHEN _source = 'offline-sync' THEN 'offline-sync' ELSE 'online' END)
  FROM (SELECT 1) seed
  LEFT JOIN public.profiles p ON p.user_id = _caller
  LEFT JOIN public.user_roles ur ON ur.user_id = _caller
  LIMIT 1;

  RETURN QUERY SELECT true, false, _invoice.id, _invoice.invoice_number, COALESCE(_invoice.total, 0)::numeric, _invoice.currency::text, _restored_items, _restored_units, _deleted_debt, _invoice.customer_name::text;
END;
$function$;

-- 4) refund_invoice_partial_atomic: move serial release BEFORE invoice UPDATE, fix amount_original, block cancelled/written_off, skip stock for bakery/repair
CREATE OR REPLACE FUNCTION public.refund_invoice_partial_atomic(_invoice_number text, _items jsonb, _operation_id text)
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
  _remaining_units numeric; _full boolean; _debt_red numeric := 0; _cash numeric := 0; _new_debt numeric;
  _profit_ratio numeric := 0;
  _f numeric := 1;
  _disc_ratio numeric := 0;
  _profit_red numeric := 0;
  _unit_factor numeric := 1;
  _track_inventory boolean := true;
  _store_type text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _owner := public.get_owner_id(auth.uid());

  IF NOT public.can_refund_invoices(auth.uid()) THEN
    RAISE EXCEPTION 'ليست لديك صلاحية الاسترداد. اطلبها من مالك المتجر' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO _inv FROM public.invoices WHERE invoice_number=_invoice_number AND user_id=_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','invoice_not_found'); END IF;
  IF COALESCE(_inv.status, '') IN ('cancelled', 'written_off') THEN
    RAISE EXCEPTION 'لا يمكن استرداد فاتورة ملغاة أو مشطوبة';
  END IF;
  IF _inv.status='refunded' THEN
    RETURN jsonb_build_object('success',true,'already_refunded',true,'invoice_id',_inv.id,'invoice_number',_inv.invoice_number,'new_total',_inv.total);
  END IF;
  IF _operation_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.activity_log WHERE user_id=_owner AND action_type='partial_refund' AND metadata->>'operation_id'=_operation_id) THEN
    RETURN jsonb_build_object('success',true,'already_processed',true,'invoice_id',_inv.id,'invoice_number',_inv.invoice_number,'new_total',_inv.total,'new_profit',_inv.profit,'new_debt_remaining',_inv.debt_remaining);
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

  IF COALESCE(_inv.profit, 0) <> 0 THEN
    _profit_ratio := LEAST(GREATEST(_profit_red / _inv.profit, 0.0), 1.0);
  ELSE
    _profit_ratio := CASE WHEN _full THEN 1.0 ELSE LEAST(GREATEST(_refund / GREATEST(COALESCE(_inv.total, 0.0001), 0.0001), 0.0), 1.0) END;
  END IF;

  IF _inv.payment_type='debt' THEN
    _debt_red := LEAST(_refund, GREATEST(COALESCE(_inv.debt_remaining,0),0));
    _cash := round(_refund-_debt_red,8);
  ELSE
    _cash := _refund;
  END IF;
  _new_debt := CASE WHEN _inv.payment_type='debt' THEN GREATEST(round(COALESCE(_inv.debt_remaining,0)-_debt_red,8),0) ELSE COALESCE(_inv.debt_remaining,0) END;

  IF _full THEN PERFORM set_config('app.refund_context','allowed',true); END IF;
  UPDATE public.invoices SET subtotal=_new_sub, discount=_new_disc, tax_amount=_new_tax, total=_new_total, profit=_new_profit,
    debt_remaining=_new_debt, debt_paid=CASE WHEN payment_type='debt' THEN GREATEST(round(COALESCE(debt_paid,0)-_cash,8),0) ELSE debt_paid END,
    status=CASE WHEN _full THEN 'refunded' WHEN payment_type='debt' AND _new_debt<=0 THEN 'paid' ELSE status END,
    notes=concat_ws(E'\n',NULLIF(notes,''),'Partial refund '||_refund::text||' at '||now()::text),
    updated_at=now()
  WHERE id=_inv.id;

  IF _profit_ratio > 0 THEN
    PERFORM public.revert_invoice_partner_profits_atomic(_inv.id, _profit_ratio);
  END IF;
  IF _inv.payment_type='debt' AND NOT _full AND _new_debt<=0 THEN
    PERFORM public.release_pending_partner_profits_for_invoice(_inv.id);
  END IF;

  IF _inv.payment_type='debt' THEN
    IF _full THEN
      UPDATE public.debts SET status='cancelled', remaining_debt=0, notes=concat_ws(E'\n',NULLIF(notes,''),'ملغى بسبب مرتجع كامل '||now()::text), updated_at=now() WHERE user_id=_owner AND (invoice_id=_inv.invoice_number OR invoice_id=_inv.id::text);
    ELSIF _debt_red > 0 OR _cash > 0 THEN
      UPDATE public.debts SET total_debt=GREATEST(round(COALESCE(total_debt,0)-_refund,8),0), total_paid=GREATEST(round(COALESCE(total_paid,0)-_cash,8),0),
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
    jsonb_build_object('operation_id', _operation_id, 'invoice_number', _inv.invoice_number, 'refund_amount', _refund,
                       'profit_reduction', _profit_red, 'cash_to_refund', _cash, 'debt_reduced', _debt_red, 'restored_units', _restored)
  FROM (SELECT 1) seed
  LEFT JOIN public.profiles p ON p.user_id = auth.uid()
  LEFT JOIN public.user_roles ur ON ur.user_id = auth.uid()
  LIMIT 1;

  RETURN jsonb_build_object('success',true,'invoice_id',_inv.id,'invoice_number',_inv.invoice_number,'refund_amount',_refund,'restored_units',_restored,'new_total',_new_total,'new_profit',_new_profit,'new_debt_remaining',_new_debt,'cash_to_refund',_cash,'debt_reduced',_debt_red,'is_fully_refunded',_full);
END;
$function$;

-- 5) record_debt_payment_atomic: validate & lock _shift_id, assert_period_open, fix sub-cent rounding & customer_id scoping
CREATE OR REPLACE FUNCTION public.record_debt_payment_atomic(_debt_id uuid, _amount numeric, _operation_id text, _shift_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid := public.get_owner_id(auth.uid());
  v_debt public.debts%ROWTYPE;
  v_amount numeric := round(COALESCE(_amount, 0)::numeric, 4);
  v_prev_remaining numeric;
  v_new_remaining numeric;
  v_new_total_paid numeric;
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
    v_amount := v_prev_remaining;
    v_new_remaining := 0;
    v_new_total_paid := v_debt.total_debt;
  ELSE
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
  END IF;

  UPDATE public.debts
     SET total_paid = v_new_total_paid,
         remaining_debt = v_new_remaining,
         status = CASE WHEN v_new_remaining <= 0 THEN 'fully_paid' ELSE 'partially_paid' END,
         updated_at = now()
   WHERE id = _debt_id
  RETURNING * INTO v_debt;

  INSERT INTO public.debt_payments(user_id, debt_id, operation_id, amount, paid_by, shift_id)
  VALUES (v_owner, _debt_id, _operation_id, v_amount, auth.uid(), _shift_id);

  IF _shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions(shift_id, user_id, type, amount, reference_id, notes)
    VALUES (_shift_id, v_owner, 'debt_payment', v_amount, _operation_id, 'تسديد دين للعميل: ' || COALESCE(v_debt.customer_name, ''))
    ON CONFLICT (shift_id, type, reference_id) DO NOTHING;

    UPDATE public.cash_shifts
       SET expected_balance = round(expected_balance + v_amount, 2),
           updated_at = now()
     WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL;
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
        v_installment_ratio := LEAST(1.0, round(v_amount / v_prev_remaining, 6));
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

  IF v_debt.customer_id IS NOT NULL THEN
    PERFORM public.recalc_customer_open_debt(v_owner, v_debt.customer_id);
  ELSIF v_debt.customer_name IS NOT NULL THEN
    UPDATE public.customers
       SET total_debt = GREATEST(round(COALESCE(total_debt, 0) - v_amount, 4), 0),
           updated_at = now()
     WHERE user_id = v_owner
       AND (name = v_debt.customer_name OR (NULLIF(trim(COALESCE(v_debt.customer_phone, '')), '') IS NOT NULL AND phone = v_debt.customer_phone));
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'total_debt', v_debt.total_debt,
    'total_paid', v_debt.total_paid,
    'remaining_debt', v_debt.remaining_debt,
    'status', v_debt.status,
    'amount', v_amount,
    'confirmed_profit', _total_confirmed
  );
END;
$function$;

-- 6) payout_store_credit_atomic: FOR UPDATE on shift, assert_period_open, multi-currency validation, expected_balance sync
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
     SET expected_balance = round(COALESCE(expected_balance, 0) - _amt, 2),
         updated_at = now()
   WHERE id = _shift_id AND user_id = _o AND closed_at IS NULL;

  INSERT INTO public.customer_credit_ledger(user_id,customer_id,entry_type,amount,shift_id,reason,operation_id,created_by)
  VALUES (_o,_customer_id,'payout',-_amt,_shift_id,'صرف رصيد نقداً',_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END $function$;

-- 7) writeoff_debt_atomic: reject cancelled/fully_paid, assert_period_open, exclude tax from partner loss, customer_id scoping
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
           notes = concat_ws(E'\n', notes, '[دين مشطوب]: ' || COALESCE(_reason, '')),
           updated_at = now()
     WHERE user_id = _owner
       AND (invoice_number = _debt.invoice_id OR id::text = _debt.invoice_id);
  END IF;

  IF _debt.customer_id IS NOT NULL THEN
    PERFORM public.recalc_customer_open_debt(_owner, _debt.customer_id);
  ELSIF _debt.customer_name IS NOT NULL THEN
    UPDATE public.customers
       SET total_debt = GREATEST(COALESCE(total_debt, 0) - COALESCE(_debt.remaining_debt, 0), 0),
           updated_at = now()
     WHERE user_id = _owner
       AND (name = _debt.customer_name OR (NULLIF(trim(COALESCE(_debt.customer_phone, '')), '') IS NOT NULL AND phone = _debt.customer_phone));
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

-- 8) cancel_debt_atomic: owner-only, block fully_paid/paid, assert_period_open, customer_id scoping
CREATE OR REPLACE FUNCTION public.cancel_debt_atomic(_debt_id uuid, _reason text DEFAULT 'إلغاء الدين'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_owner uuid := public.get_owner_id(auth.uid());
  v_debt public.debts%ROWTYPE;
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

  IF v_debt.customer_id IS NOT NULL THEN
    PERFORM public.recalc_customer_open_debt(v_owner, v_debt.customer_id);
  ELSIF COALESCE(v_debt.remaining_debt, 0) > 0 AND v_debt.customer_name IS NOT NULL THEN
    UPDATE public.customers
       SET total_debt = GREATEST(0, round(COALESCE(total_debt, 0) - COALESCE(v_debt.remaining_debt, 0), 8)),
           updated_at = now()
     WHERE user_id = v_owner
       AND (name = v_debt.customer_name OR (NULLIF(trim(COALESCE(v_debt.customer_phone, '')), '') IS NOT NULL AND phone = v_debt.customer_phone));
  END IF;

  RETURN jsonb_build_object('success', true, 'debt_id', _debt_id, 'cancelled_amount', COALESCE(v_debt.remaining_debt, 0));
END;
$function$;

-- 9) Guard direct INSERT with status='written_off' and direct DELETE on debts & debt_writeoffs
CREATE OR REPLACE FUNCTION public.guard_debt_writeoff_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'written_off'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'written_off')
     AND auth.uid() IS NOT NULL
     AND COALESCE(current_setting('app.debt_writeoff_internal', true), '') <> '1' THEN
    RAISE EXCEPTION 'شطب الدين يتم من شاشة الديون بصلاحية مالك المتجر فقط' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS b_guard_debt_writeoff_status ON public.debts;
CREATE TRIGGER b_guard_debt_writeoff_status
  BEFORE INSERT OR UPDATE OF status ON public.debts
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_debt_writeoff_status();

CREATE OR REPLACE FUNCTION public.prevent_direct_debt_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR current_setting('role', true) = 'service_role' THEN
    RETURN OLD;
  END IF;
  IF COALESCE(current_setting('app.purge_context', true), '') = 'owner_purge' AND public.is_boss(auth.uid()) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'الحذف المباشر لسجلات الديون والشطب ممنوع محاسبياً' USING ERRCODE = '42501';
END;
$function$;

DROP TRIGGER IF EXISTS z_block_direct_debt_delete ON public.debts;
CREATE TRIGGER z_block_direct_debt_delete
  BEFORE DELETE ON public.debts
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_direct_debt_delete();

DROP TRIGGER IF EXISTS z_block_direct_debt_writeoff_delete ON public.debt_writeoffs;
CREATE TRIGGER z_block_direct_debt_writeoff_delete
  BEFORE DELETE ON public.debt_writeoffs
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_direct_debt_delete();

-- 10) Revoke direct authenticated EXECUTE on legacy confirm_partner_debt_profit_atomic
REVOKE EXECUTE ON FUNCTION public.confirm_partner_debt_profit_atomic(text, numeric) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.confirm_partner_debt_profit_atomic(text, numeric) TO service_role;

-- 11) Harden complete_phone_transfer (FOR UPDATE + revoke dead anon/PUBLIC grant)
CREATE OR REPLACE FUNCTION public.complete_phone_transfer(_request_id uuid, _entered_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'extensions'
AS $function$
DECLARE _caller UUID := auth.uid(); _req RECORD;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'غير مصرح: يجب تسجيل الدخول'; END IF;
  SELECT * INTO _req FROM public.phone_transfer_requests WHERE id = _request_id AND target_user_id = _caller FOR UPDATE;
  IF _req.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'طلب التحقق غير موجود أو منتهي الصلاحية'); END IF;
  IF _req.expires_at < now() THEN
    DELETE FROM public.phone_transfer_requests WHERE id = _request_id;
    RETURN jsonb_build_object('ok', false, 'error', 'انتهت صلاحية رمز التحقق، يرجى طلب رمز جديد');
  END IF;
  IF _req.attempts >= 3 THEN
    DELETE FROM public.phone_transfer_requests WHERE id = _request_id;
    RETURN jsonb_build_object('ok', false, 'error', 'تم تجاوز الحد الأقصى للمحاولات الخاطئة. اطلب رمزاً جديداً');
  END IF;
  IF _req.code_hash <> encode(digest(trim(_entered_code), 'sha256'), 'hex') THEN
    UPDATE public.phone_transfer_requests SET attempts = attempts + 1 WHERE id = _request_id;
    RETURN jsonb_build_object('ok', false, 'error', 'رمز التحقق غير صحيح، المحاولات المتبقية: ' || (2 - _req.attempts));
  END IF;
  UPDATE public.profiles SET phone = NULL, updated_at = now() WHERE user_id = _req.source_user_id;
  UPDATE public.profiles SET phone = _req.phone, updated_at = now() WHERE user_id = _caller;
  UPDATE public.stores SET phone = _req.phone WHERE user_id = _caller;
  DELETE FROM public.phone_transfer_requests WHERE id = _request_id;
  RETURN jsonb_build_object('ok', true, 'status', 'transferred', 'normalized_phone', _req.phone, 'message', 'تم نقل الرقم وربطه بحسابك وبمتجرك بنجاح');
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.complete_phone_transfer(uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.complete_phone_transfer(uuid, text) TO authenticated, service_role;

-- 12) Remove cooldown-free revoke_user_sessions DoS on already_free/allow_multi_device branch
CREATE OR REPLACE FUNCTION public.request_device_reset_secure(_license_key text, _user_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _clean_key text := upper(replace(trim(_license_key), ' ', ''));
  _clean_email text := lower(trim(_user_email));
  _lic record;
  _since timestamptz;
  _available_at timestamptz;
  _left interval;
BEGIN
  IF _clean_key IS NULL OR _clean_key = '' OR _clean_email IS NULL OR _clean_email = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'يرجى تزويد مفتاح الترخيص والبريد الإلكتروني بشكل صحيح.'
    );
  END IF;

  SELECT l.id, l.user_id, l.activation_code_id, l.is_revoked, l.device_id,
         l.allow_multi_device, l.device_bound_at, l.last_device_reset_at,
         l.activated_at, l.created_at
    INTO _lic
    FROM public.app_licenses l
    LEFT JOIN auth.users u ON u.id = l.user_id
    LEFT JOIN public.activation_codes ac ON ac.id = l.activation_code_id
   WHERE (
     upper(replace(COALESCE(l.license_key, ''), ' ', '')) = _clean_key
     OR (ac.code IS NOT NULL AND upper(replace(ac.code, ' ', '')) = _clean_key)
   )
   AND (
     (u.email IS NOT NULL AND lower(trim(u.email)) = _clean_email)
     OR (ac.assigned_email IS NOT NULL AND lower(trim(ac.assigned_email)) = _clean_email)
   )
   ORDER BY l.created_at DESC
   LIMIT 1
   FOR UPDATE OF l;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'بيانات الترخيص أو البريد الإلكتروني غير صحيحة.'
    );
  END IF;

  IF COALESCE(_lic.is_revoked, false) THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'تم إلغاء ترخيص هذا الحساب، يرجى التواصل مع الإدارة.'
    );
  END IF;

  IF _lic.device_id IS NULL OR COALESCE(_lic.allow_multi_device, false) THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_free', true,
      'message', 'الحساب غير مرتبط بجهاز حالياً. يمكنك تسجيل الدخول مباشرة.'
    );
  END IF;

  _since := COALESCE(_lic.device_bound_at, _lic.last_device_reset_at, _lic.activated_at, _lic.created_at, now());
  _available_at := _since + interval '1 day';

  IF now() < _available_at THEN
    _left := _available_at - now();
    RETURN jsonb_build_object(
      'success', false,
      'cooldown', true,
      'available_at', _available_at,
      'message', format(
        'لا يمكن نقل الحساب ذاتياً قبل مرور يوم على ربط الجهاز الحالي (متبقٍ %s يوم و%s ساعة). لنقل الحساب الآن تواصل مع الدعم عبر بوت تيليجرام.',
        extract(day FROM _left)::int,
        extract(hour FROM _left)::int
      )
    );
  END IF;

  UPDATE public.app_licenses
     SET device_id = NULL,
         bound_device_id = NULL,
         last_reset_at = now(),
         last_device_reset_at = now(),
         device_reset_count = COALESCE(device_reset_count, 0) + 1,
         updated_at = now()
   WHERE id = _lic.id;

  IF _lic.activation_code_id IS NOT NULL THEN
    UPDATE public.activation_codes
       SET locked_device_id = NULL
     WHERE id = _lic.activation_code_id;
  END IF;

  PERFORM public.revoke_user_sessions(_lic.user_id);

  RETURN jsonb_build_object(
    'success', true,
    'message', 'تم فك ربط الجهاز بنجاح. يمكنك الآن تسجيل الدخول من جهازك الجديد.'
  );
END;
$function$;

NOTIFY pgrst, 'reload schema';
