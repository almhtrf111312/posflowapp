-- is_license_valid(_user_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.is_license_valid(_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _owner_id uuid;
  _license_valid boolean;
BEGIN
  -- Get the owner id (self if owner, or owner_id if cashier)
  _owner_id := public.get_owner_id(_user_id);
  
  IF _owner_id IS NULL THEN
    RETURN false;
  END IF;
  
  -- Check if license exists and is valid
  SELECT EXISTS (
    SELECT 1
    FROM public.app_licenses
    WHERE user_id = _owner_id
      AND expires_at > now()
      AND is_revoked = false
  ) INTO _license_valid;
  
  RETURN _license_valid;
END;
$function$
;
