-- set_user_pin(_target_user_id uuid, _raw_pin text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.set_user_pin(_target_user_id uuid, _raw_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    _caller UUID := auth.uid();
    _is_authorized BOOLEAN := FALSE;
BEGIN
    -- التحقق من وجود جلسة مصادقة نشطة
    IF _caller IS NULL THEN
        RAISE EXCEPTION 'غير مصرح: يجب تسجيل الدخول أولاً';
    END IF;

    -- التحقق الصارم من الملكية وعزل المتجر:
    -- يُسمح فقط إذا كان:
    -- 1) المستخدم يغير رمز PIN الخاص به شخصياً
    -- 2) أو المستدعي هو المدير العام (Boss)
    -- 3) أو المستدعي هو المالك المباشر (owner_id) للمستخدم المستهدف في جدول user_roles
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
        RAISE EXCEPTION 'غير مصرح: لا يمكنك تعيين رمز أمان لمستخدم لا يتبع لمتجرك';
    END IF;

    -- التحقق من طول رمز الـ PIN (من 4 إلى 8 أرقام)
    IF length(trim(_raw_pin)) < 4 OR length(trim(_raw_pin)) > 8 THEN
        RAISE EXCEPTION 'رمز الـ PIN يجب أن يتكون من 4 إلى 8 خانات رقمية';
    END IF;

    -- تشفير وتخزين الهاش الآمن مع Salt عشوائي
    UPDATE public.profiles
    SET pin_hash = crypt(trim(_raw_pin), gen_salt('bf', 10)),
        updated_at = now()
    WHERE user_id = _target_user_id;

    RETURN TRUE;
END;
$function$
;
