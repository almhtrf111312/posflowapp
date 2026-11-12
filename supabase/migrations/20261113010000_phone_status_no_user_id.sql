-- =========================================================================
-- check_store_phone_status: إزالة كشف معرّف الحساب الآخر (source_user_id)
-- نفس الدالة الحية حرفياً (من لقطة cloud-review) مع حذف سطر واحد فقط.
-- التطبيق لا يستخدم source_user_id. آمن لإعادة التشغيل.
-- الرجوع: أعد تشغيل cloud-review/database/functions/check_store_phone_status.sql
-- =========================================================================
CREATE OR REPLACE FUNCTION public.check_store_phone_status(_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
    _caller UUID := auth.uid();
    _normalized_phone TEXT;
    _current_user_phone TEXT;
    _existing_profile RECORD;
BEGIN
    IF _caller IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'يجب تسجيل الدخول أولاً');
    END IF;

    -- إذا كان الرقم فارغاً
    IF _phone IS NULL OR trim(_phone) = '' THEN
        RETURN jsonb_build_object(
            'ok', true,
            'status', 'empty',
            'normalized_phone', NULL
        );
    END IF;

    _normalized_phone := public.normalize_phone_number(_phone);

    -- جلب رقم المستخدم الحالي المسجل في ملفه
    SELECT phone INTO _current_user_phone 
    FROM public.profiles 
    WHERE user_id = _caller;

    -- إذا كان الرقم هو نفس رقم المستخدم الحالي المسجل مسبقاً
    IF _current_user_phone IS NOT NULL AND _current_user_phone = _normalized_phone THEN
        RETURN jsonb_build_object(
            'ok', true,
            'status', 'same_user',
            'normalized_phone', _normalized_phone,
            'message', 'الرقم مطابق لرقم حسابك الحالي'
        );
    END IF;

    -- البحث عن أي حساب آخر مسجل بنفس هذا الرقم
    SELECT user_id, full_name, telegram_chat_id INTO _existing_profile
    FROM public.profiles
    WHERE phone = _normalized_phone
      AND user_id <> _caller
    LIMIT 1;

    -- الحالة 1: الرقم غير مستخدم لدى أي حساب آخر (حر ومتاح)
    IF _existing_profile.user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', true,
            'status', 'available',
            'normalized_phone', _normalized_phone,
            'message', 'الرقم متاح ويتطلب تأكيد كلمة مرور الحساب لحفظه كافتراضي'
        );
    END IF;

    -- الحالة 2: الرقم مربوط بحساب آخر ولديه Telegram مفعل
    IF _existing_profile.telegram_chat_id IS NOT NULL AND trim(_existing_profile.telegram_chat_id) <> '' THEN
        RETURN jsonb_build_object(
            'ok', true,
            'status', 'requires_telegram_verification',
            'normalized_phone', _normalized_phone,
            'has_telegram', true,
            'message', 'الرقم مرتبط بحساب آخر، يلزم تأكيد النقل عبر رمز يصل لبوت Telegram للحساب الأصلي'
        );
    END IF;

    -- الحالة 3: الرقم مربوط بحساب آخر وليس لديه Telegram مفعل
    RETURN jsonb_build_object(
        'ok', false,
        'status', 'conflict_no_telegram',
        'normalized_phone', _normalized_phone,
        'has_telegram', false,
        'error', 'هذا الرقم مرتبط بحساب مستخدم آخر وغير مفعل لديه التيليجرام لنقل الملكية. تواصل مع الدعم الفني.'
    );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.check_store_phone_status(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_store_phone_status(text) TO authenticated, service_role;

-- التحقق: يجب أن تكون true
SELECT position('source_user_id' in pg_get_functiondef('public.check_store_phone_status(text)'::regprocedure)) = 0
       AND NOT has_function_privilege('anon', 'public.check_store_phone_status(text)'::regprocedure, 'execute')
       AS phone_status_fixed;
