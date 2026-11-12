-- validate_activation_code_strength()
-- SECURITY DEFINER: False
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.validate_activation_code_strength()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.code IS NULL OR length(regexp_replace(NEW.code, '[^A-Za-z0-9]', '', 'g')) < 12 THEN
    RAISE EXCEPTION 'Activation code must contain at least 12 letters or digits';
  END IF;
  RETURN NEW;
END $function$
;
