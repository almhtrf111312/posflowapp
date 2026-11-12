-- verify_user_pin(_user_id uuid, _entered_pin text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.verify_user_pin(_user_id uuid, _entered_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    _stored_hash TEXT;
BEGIN
    SELECT pin_hash INTO _stored_hash
    FROM public.profiles
    WHERE user_id = _user_id;

    IF _stored_hash IS NULL THEN
        RETURN FALSE;
    END IF;

    -- مقارنة الهاش بالمدخل: مطابقة تجزئة آمنة تمنع هجمات التوقيت
    RETURN (_stored_hash = crypt(trim(_entered_pin), _stored_hash));
END;
$function$
;
