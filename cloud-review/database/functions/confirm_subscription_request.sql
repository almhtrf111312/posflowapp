-- confirm_subscription_request(p_request_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.confirm_subscription_request(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.boss_activate_license(NULL, NULL, NULL, 'extend', p_request_id, NULL);
  IF NOT COALESCE((v_result->>'success')::boolean, false) THEN
    RAISE EXCEPTION '%', COALESCE(v_result->>'error', 'فشل تأكيد الطلب');
  END IF;
  RETURN v_result;
END;
$function$
;
