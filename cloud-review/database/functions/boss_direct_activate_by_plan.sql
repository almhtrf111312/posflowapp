-- boss_direct_activate_by_plan(p_target_user_id uuid, p_plan_id uuid, p_custom_days integer)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,=X/postgres}

CREATE OR REPLACE FUNCTION public.boss_direct_activate_by_plan(p_target_user_id uuid, p_plan_id uuid DEFAULT NULL::uuid, p_custom_days integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.boss_activate_license(
    p_target_user_id, p_plan_id,
    CASE WHEN p_plan_id IS NULL THEN COALESCE(p_custom_days, 90) ELSE NULL END,
    'extend', NULL, NULL
  );
END;
$function$
;
