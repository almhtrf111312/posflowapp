-- approve_subscription_request_atomic(p_request_id uuid, p_admin_note text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,=X/postgres}

CREATE OR REPLACE FUNCTION public.approve_subscription_request_atomic(p_request_id uuid, p_admin_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.boss_activate_license(NULL, NULL, NULL, 'extend', p_request_id, p_admin_note);
END;
$function$
;
