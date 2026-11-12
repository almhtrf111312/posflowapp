-- count_owner_cashiers(_owner_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}

CREATE OR REPLACE FUNCTION public.count_owner_cashiers(_owner_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _count integer;
BEGIN
  SELECT COUNT(*) INTO _count
  FROM public.user_roles
  WHERE owner_id = _owner_id
    AND role = 'cashier'
    AND is_active = true;
  
  RETURN _count;
END;
$function$
;
