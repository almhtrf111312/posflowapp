-- clear_user_pin(_target_user_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.clear_user_pin(_target_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    _caller UUID := auth.uid();
    _is_authorized BOOLEAN := FALSE;
BEGIN
    IF _caller IS NULL THEN
        RAISE EXCEPTION 'غير مصرح: يجب تسجيل الدخول أولاً';
    END IF;

    SELECT (
        _caller = _target_user_id 
        OR public.is_boss(_caller) 
        OR EXISTS (
            SELECT 1 FROM public.user_roles 
            WHERE user_id = _target_user_id 
              AND owner_id = _caller
        )
    ) INTO _is_authorized;

    IF NOT _is_authorized THEN
        RAISE EXCEPTION 'غير مصرح: لا يمكنك إلغاء رمز أمان مستخدم لا يتبع لمتجرك';
    END IF;

    UPDATE public.profiles
    SET pin_hash = NULL,
        updated_at = now()
    WHERE user_id = _target_user_id;

    RETURN TRUE;
END;
$function$
;
