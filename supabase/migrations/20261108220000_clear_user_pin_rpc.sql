-- ============================================================================
-- دالة تصفير رمز الـ PIN المنسي للمستخدم عند استعادته بكلمة المرور الرئيسية
-- ============================================================================
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
    _is_admin_or_boss BOOLEAN;
BEGIN
    -- التحقق من تسجيل الدخول
    IF _caller IS NULL THEN
        RAISE EXCEPTION 'غير مصرح: يجب تسجيل الدخول أولاً';
    END IF;

    -- التحقق: هل المستخدم هو صاحب الحساب نفسه أم مدير/مالك؟
    SELECT EXISTS (
        SELECT 1 FROM public.user_roles 
        WHERE user_id = _caller AND role IN ('admin', 'boss')
    ) INTO _is_admin_or_boss;

    IF _caller <> _target_user_id AND NOT _is_admin_or_boss THEN
        RAISE EXCEPTION 'غير مصرح لك بإلغاء رمز أمان مستخدم آخر';
    END IF;

    -- تصفير الهاش السحابي للـ PIN
    UPDATE public.profiles
    SET pin_hash = NULL,
        updated_at = now()
    WHERE user_id = _target_user_id;

    RETURN TRUE;
END;
$$;

-- منح صلاحيات التنفيذ للمستخدمين المسجلين فقط
GRANT EXECUTE ON FUNCTION public.clear_user_pin(UUID) TO authenticated;
