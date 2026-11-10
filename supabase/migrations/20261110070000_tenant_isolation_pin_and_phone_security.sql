-- =====================================================================
-- خطة الإصلاح الأمني - المرحلة الأولى: عزل المتاجر وحماية الـ PIN
-- =====================================================================

-- 1. إصلاح دالة set_user_pin لسد ثغرة كسر عزل المستأجرين (Cross-Tenant)
CREATE OR REPLACE FUNCTION public.set_user_pin(
    _target_user_id UUID,
    _raw_pin TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
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
$$;

-- 2. إصلاح دالة clear_user_pin لفرض نفس عزل المتاجر
CREATE OR REPLACE FUNCTION public.clear_user_pin(
    _target_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
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
$$;

-- 3. سد ثغرة التخمين العنيف (Brute-Force) لدالة verify_user_pin
-- سحب صلاحية التنفيذ من العامة (anon/public) وحصرها بالمستخدم المسجل
REVOKE EXECUTE ON FUNCTION public.verify_user_pin(UUID, TEXT) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.verify_user_pin(UUID, TEXT) TO authenticated;

-- حصر صلاحيات set_user_pin و clear_user_pin للمسجلين فقط
REVOKE EXECUTE ON FUNCTION public.set_user_pin(UUID, TEXT) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.set_user_pin(UUID, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.clear_user_pin(UUID) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.clear_user_pin(UUID) TO authenticated;

-- 4. إحكام إغلاق جدول phone_transfer_requests
ALTER TABLE IF EXISTS public.phone_transfer_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.phone_transfer_requests FROM anon, authenticated, public;
GRANT ALL ON public.phone_transfer_requests TO service_role;
