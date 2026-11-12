-- deduct_product_quantity(_product_id uuid, _amount integer)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.deduct_product_quantity(_product_id uuid, _amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _current_qty integer;
  _new_qty integer;
  _owner uuid := public.get_owner_id(auth.uid());
BEGIN
  IF auth.uid() IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Invalid stock adjustment';
  END IF;

  SELECT quantity INTO _current_qty
  FROM public.products
  WHERE id = _product_id AND user_id = _owner
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF COALESCE(_current_qty, 0) < _amount THEN RAISE EXCEPTION 'Insufficient stock'; END IF;

  PERFORM set_config('app.stock_movement_type', 'sale', true);
  PERFORM set_config('app.stock_actor_id', auth.uid()::text, true);
  PERFORM set_config('app.stock_source', 'authenticated_rpc', true);

  _new_qty := _current_qty - _amount;
  UPDATE public.products SET quantity = _new_qty WHERE id = _product_id AND user_id = _owner;
  RETURN _new_qty;
END;
$function$
;
