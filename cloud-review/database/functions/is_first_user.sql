-- is_first_user()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.is_first_user()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT NOT EXISTS (SELECT 1 FROM public.user_roles)
$function$
;
