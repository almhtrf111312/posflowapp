-- record_warehouse_stock_movement()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.record_warehouse_stock_movement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _before numeric;
  _after numeric;
  _owner uuid;
  _product_name text;
  _warehouse_name text;
  _unit_cost numeric;
  _movement_type text;
  _invoice_id uuid;
  _invoice_number text;
  _actor uuid;
  _source text;
  _key text;
BEGIN
  _before := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE(OLD.quantity, 0) END;
  _after := COALESCE(NEW.quantity, 0);
  IF _before = _after THEN RETURN NEW; END IF;

  SELECT w.user_id, w.name INTO _owner, _warehouse_name
  FROM public.warehouses w WHERE w.id = NEW.warehouse_id;
  SELECT p.name, COALESCE(p.cost_price, 0) INTO _product_name, _unit_cost
  FROM public.products p WHERE p.id = NEW.product_id;

  IF _owner IS NULL THEN RAISE EXCEPTION 'Warehouse owner not found'; END IF;

  _movement_type := COALESCE(NULLIF(current_setting('app.stock_movement_type', true), ''),
    CASE WHEN TG_OP = 'INSERT' THEN 'opening_balance' WHEN _after > _before THEN 'adjustment_in' ELSE 'adjustment_out' END);
  _invoice_id := NULLIF(current_setting('app.stock_invoice_id', true), '')::uuid;
  _invoice_number := NULLIF(current_setting('app.stock_invoice_number', true), '');
  _actor := COALESCE(NULLIF(current_setting('app.stock_actor_id', true), '')::uuid, auth.uid());
  _source := COALESCE(NULLIF(current_setting('app.stock_source', true), ''), 'database_trigger');
  _key := CASE
    WHEN _movement_type = 'refund' AND _invoice_id IS NOT NULL
      THEN 'refund:' || _invoice_id::text || ':' || NEW.product_id::text || ':' || NEW.warehouse_id::text
    ELSE 'movement:' || gen_random_uuid()::text
  END;

  INSERT INTO public.stock_movements (
    user_id, invoice_id, invoice_number, product_id, product_name,
    warehouse_id, warehouse_name, movement_type, quantity_delta,
    quantity_before, quantity_after, unit_cost, created_by, source,
    idempotency_key, metadata
  ) VALUES (
    _owner, _invoice_id, _invoice_number, NEW.product_id, _product_name,
    NEW.warehouse_id, _warehouse_name, _movement_type, _after - _before,
    _before, _after, COALESCE(_unit_cost, 0), _actor, _source,
    _key, '{}'::jsonb
  );
  RETURN NEW;
END;
$function$
;
