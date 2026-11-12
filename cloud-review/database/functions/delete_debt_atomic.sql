-- delete_debt_atomic(_debt_id uuid, _reason text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.delete_debt_atomic(_debt_id uuid, _reason text DEFAULT 'إلغاء الدين'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.cancel_debt_atomic(_debt_id, _reason);
END;
$function$
;
