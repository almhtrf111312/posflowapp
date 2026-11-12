-- trigger_normalize_profile_phone()
-- SECURITY DEFINER: False
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.trigger_normalize_profile_phone()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.phone := public.normalize_phone_number(NEW.phone);
    RETURN NEW;
END;
$function$
;
