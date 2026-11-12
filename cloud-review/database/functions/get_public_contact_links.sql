-- get_public_contact_links()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.get_public_contact_links()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(value::jsonb, '{}'::jsonb)
  FROM public.app_settings
  WHERE key = 'contact_links'
  LIMIT 1;
$function$
;
