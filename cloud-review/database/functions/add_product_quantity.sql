-- add_product_quantity(_product_id uuid, _amount integer)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.add_product_quantity(_product_id uuid, _amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _new_qty integer;
  _owner uuid := public.get_owner_id(auth.uid());
BEGIN
  IF auth.uid() IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Invalid stock adjustment';
  END IF;

  PERFORM set_config('app.stock_movement_type', 'adjustment_in', true);
  PERFORM set_config('app.stock_actor_id', auth.uid()::text, true);
  PERFORM set_config('app.stock_source', 'authenticated_rpc', true);

  UPDATE public.products
  SET quantity = COALESCE(quantity, 0) + _amount
  WHERE id = _product_id AND user_id = _owner
  RETURNING quantity INTO _new_qty;

  IF _new_qty IS NULL THEN RAISE EXCEPTION 'Product not found'; END IF;
  RETURN _new_qty;
END;
$function$
;
