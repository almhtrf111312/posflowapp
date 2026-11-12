-- revoke_license(_license_id uuid, _reason text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.revoke_license(_license_id uuid, _reason text DEFAULT 'Revoked by admin'::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only boss can revoke
  IF NOT is_boss(auth.uid()) THEN
    RETURN false;
  END IF;
  
  UPDATE public.app_licenses
  SET is_revoked = true,
      revoked_at = now(),
      revoked_reason = _reason
  WHERE id = _license_id;
  
  RETURN true;
END;
$function$
;
