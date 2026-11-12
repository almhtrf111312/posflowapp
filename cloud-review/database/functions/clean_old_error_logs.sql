-- clean_old_error_logs()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.clean_old_error_logs()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.error_logs
  WHERE (is_resolved = true AND occurred_at < NOW() - INTERVAL '14 days')
     OR (occurred_at < NOW() - INTERVAL '60 days');
     
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$function$
;
