-- get_inventory_value(_owner_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.get_inventory_value(_owner_id uuid)
 RETURNS TABLE(total_cost numeric, total_sale numeric, total_units bigint, total_skus bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF _owner_id IS DISTINCT FROM public.get_owner_id(auth.uid())
     AND NOT public.is_boss(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  RETURN QUERY
  SELECT
    COALESCE(SUM(COALESCE(p.quantity,0) * COALESCE(p.cost_price,0)), 0)::numeric,
    COALESCE(SUM(COALESCE(p.quantity,0) * COALESCE(p.sale_price,0)), 0)::numeric,
    COALESCE(SUM(COALESCE(p.quantity,0)), 0)::bigint,
    COUNT(*)::bigint
  FROM public.products p
  WHERE p.user_id = _owner_id AND COALESCE(p.archived,false) = false;
END;
$function$
;
