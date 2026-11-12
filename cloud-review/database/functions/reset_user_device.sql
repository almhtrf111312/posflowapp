-- reset_user_device(_target_user_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.reset_user_device(_target_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Verify caller is boss
  IF NOT public.is_boss(auth.uid()) THEN
    RAISE EXCEPTION 'Only boss can reset device';
  END IF;
  
  -- Reset device_id for the target user's license
  UPDATE public.app_licenses
  SET device_id = NULL
  WHERE user_id = _target_user_id;
  
  RETURN TRUE;
END;
$function$
;
