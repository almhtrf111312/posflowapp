-- track_license_device_binding()
-- SECURITY DEFINER: False
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.track_license_device_binding()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.device_id IS NULL THEN
    NEW.device_bound_at := NULL;
  ELSIF TG_OP = 'INSERT' OR NEW.device_id IS DISTINCT FROM OLD.device_id THEN
    NEW.device_bound_at := now();
  END IF;
  RETURN NEW;
END;
$function$
;
