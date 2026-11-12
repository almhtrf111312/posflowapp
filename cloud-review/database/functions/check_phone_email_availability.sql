-- check_phone_email_availability(_phone text, _email text, _exclude_user_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,=X/postgres}

CREATE OR REPLACE FUNCTION public.check_phone_email_availability(_phone text, _email text, _exclude_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
    _normalized_phone TEXT;
    _normalized_email TEXT;
    _phone_exists BOOLEAN := FALSE;
    _email_exists BOOLEAN := FALSE;
    _conflicting_user_name TEXT;
BEGIN
    _normalized_phone := public.normalize_phone_number(_phone);
    _normalized_email := lower(trim(COALESCE(_email, '')));

    -- 1. فحص البريد الإلكتروني في auth.users
    IF _normalized_email <> '' THEN
        SELECT EXISTS (
            SELECT 1 FROM auth.users
            WHERE lower(email) = _normalized_email
              AND (_exclude_user_id IS NULL OR id <> _exclude_user_id)
        ) INTO _email_exists;

        IF _email_exists THEN
            RETURN jsonb_build_object(
                'available', false,
                'field', 'email',
                'error', 'البريد الإلكتروني مسجل بالفعل لحساب آخر ولا يمكن استخدامه'
            );
        END IF;
    END IF;

    -- 2. فحص رقم الهاتف في جدول profiles
    IF _normalized_phone IS NOT NULL THEN
        SELECT full_name INTO _conflicting_user_name
        FROM public.profiles
        WHERE phone = _normalized_phone
          AND (_exclude_user_id IS NULL OR user_id <> _exclude_user_id)
        LIMIT 1;

        IF _conflicting_user_name IS NOT NULL THEN
            RETURN jsonb_build_object(
                'available', false,
                'field', 'phone',
                'error', 'رقم الهاتف (' || _normalized_phone || ') مسجل بالفعل لحساب مستخدم آخر ولا يمكن استخدامه'
            );
        END IF;
    END IF;

    -- في حال كان كلاهما متاحاً
    RETURN jsonb_build_object(
        'available', true,
        'normalized_phone', _normalized_phone,
        'normalized_email', _normalized_email
    );
END;
$function$
;
