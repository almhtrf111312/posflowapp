-- has_paid_write_access(_user_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.has_paid_write_access(_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    public.is_boss(_user_id)
    OR EXISTS (
      SELECT 1
      FROM public.app_licenses al
      WHERE al.user_id = public.get_owner_id(_user_id)
        AND COALESCE(al.is_revoked, false) = false
        AND COALESCE(al.is_trial, false) = false
        AND al.expires_at > now()
    );
$function$
;
