-- assign_store_and_profile_phone(_phone text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.assign_store_and_profile_phone(_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
    _caller UUID := auth.uid();
    _normalized_phone TEXT;
    _other_user UUID;
BEGIN
    IF _caller IS NULL THEN
        RAISE EXCEPTION 'غير مصرح: يجب تسجيل الدخول';
    END IF;

    IF _phone IS NULL OR trim(_phone) = '' THEN
        -- تفريغ الرقم من الملف والمتجر
        UPDATE public.profiles SET phone = NULL, updated_at = now() WHERE user_id = _caller;
        UPDATE public.stores SET phone = NULL WHERE user_id = _caller;
        RETURN jsonb_build_object('ok', true, 'status', 'cleared');
    END IF;

    _normalized_phone := public.normalize_phone_number(_phone);

    -- حماية من التضارب اللحظي: التأكد أنه لا يخص مستخدماً آخر
    SELECT user_id INTO _other_user
    FROM public.profiles
    WHERE phone = _normalized_phone AND user_id <> _caller
    LIMIT 1;

    IF _other_user IS NOT NULL THEN
        RAISE EXCEPTION 'الرقم مسجل بالفعل لحساب مستخدم آخر، يتطلب التحقق عبر تيليجرام';
    END IF;

    -- 1. تحديث البروفايل
    UPDATE public.profiles
    SET phone = _normalized_phone, updated_at = now()
    WHERE user_id = _caller;

    -- 2. تحديث المتجر للمالك
    UPDATE public.stores
    SET phone = _normalized_phone
    WHERE user_id = _caller;

    RETURN jsonb_build_object(
        'ok', true,
        'status', 'assigned',
        'normalized_phone', _normalized_phone
    );
END;
$function$
;
