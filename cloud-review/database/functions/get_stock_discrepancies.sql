-- get_stock_discrepancies()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.get_stock_discrepancies()
 RETURNS TABLE(product_id uuid, product_name text, warehouse_id uuid, warehouse_name text, actual_quantity integer, expected_quantity bigint, variance bigint, unit_cost numeric, variance_value numeric, last_movement_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH actual AS (
    SELECT p.user_id, p.id AS product_id, p.name AS product_name,
           NULL::uuid AS warehouse_id, 'المخزون الرئيسي'::text AS warehouse_name,
           COALESCE(p.quantity, 0)::integer AS actual_quantity, COALESCE(p.cost_price, 0)::numeric AS unit_cost
    FROM public.products p
    WHERE p.user_id = public.get_owner_id(auth.uid()) AND COALESCE(p.archived, false) = false
    UNION ALL
    SELECT w.user_id, ws.product_id, p.name, w.id, w.name,
           COALESCE(ws.quantity, 0)::integer, COALESCE(p.cost_price, 0)::numeric
    FROM public.warehouse_stock ws
    JOIN public.warehouses w ON w.id = ws.warehouse_id
    JOIN public.products p ON p.id = ws.product_id
    WHERE w.user_id = public.get_owner_id(auth.uid()) AND COALESCE(w.is_active, true) = true
  ), ledger AS (
    SELECT sm.user_id, sm.product_id, sm.warehouse_id,
           SUM(sm.quantity_delta)::bigint AS expected_quantity,
           MAX(sm.created_at) AS last_movement_at
    FROM public.stock_movements sm
    WHERE sm.user_id = public.get_owner_id(auth.uid())
    GROUP BY sm.user_id, sm.product_id, sm.warehouse_id
  )
  SELECT a.product_id, a.product_name, a.warehouse_id, a.warehouse_name,
         a.actual_quantity, COALESCE(l.expected_quantity, 0),
         a.actual_quantity::bigint - COALESCE(l.expected_quantity, 0),
         a.unit_cost,
         (a.actual_quantity::numeric - COALESCE(l.expected_quantity, 0)::numeric) * a.unit_cost,
         l.last_movement_at
  FROM actual a
  LEFT JOIN ledger l ON l.user_id = a.user_id AND l.product_id = a.product_id
    AND l.warehouse_id IS NOT DISTINCT FROM a.warehouse_id
  ORDER BY ABS(a.actual_quantity::bigint - COALESCE(l.expected_quantity, 0)) DESC, a.product_name;
$function$
;
