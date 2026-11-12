-- get_boss_owners()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.get_boss_owners()
 RETURNS SETOF boss_owners_view
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: boss role required';
  END IF;
  RETURN QUERY SELECT * FROM public.boss_owners_view;
END;
$function$
;
