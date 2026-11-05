-- ============================================================================
-- حزمة الأمان والتشفير وتطبيع أرقام الهواتف وفرض التفرد
-- 1. تشفير وتعيين رموز PIN السريعة باستخدام pgcrypto (bcrypt Cost 10)
-- 2. تطبيع أرقام الهواتف (سوريا +963، تركيا +90، دولي +) وفرض قيد التفرد الفريد
-- 3. دالة الفحص الاستباقي للبريد ورقم الهاتف (check_phone_email_availability)
-- ============================================================================

-- 1. تفعيل إضافة التشفير pgcrypto إن لم تكن مفعلة
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- 2. إضافة عمود pin_hash لجدول profiles
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS pin_hash TEXT DEFAULT NULL;

-- 3. دالة تعيين أو تحديث رمز الدخول السريع المشفر للكاشير/المستخدم
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
    _is_owner BOOLEAN;
BEGIN
    -- التحقق من الهوية: إما المستخدم نفسه أو مدير النظام/المالك
    IF _caller IS NULL THEN
        RAISE EXCEPTION 'غير مصرح: يجب تسجيل الدخول';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.user_roles 
        WHERE user_id = _caller AND role IN ('admin', 'boss')
    ) INTO _is_owner;

    IF _caller <> _target_user_id AND NOT _is_owner THEN
        RAISE EXCEPTION 'غير مصرح بتعيين رمز مرور لمستخدم آخر';
    END IF;

    -- التحقق من طول الـ PIN (من 4 إلى 8 أرقام)
    IF length(trim(_raw_pin)) < 4 OR length(trim(_raw_pin)) > 8 THEN
        RAISE EXCEPTION 'رمز الـ PIN يجب أن يتكون من 4 إلى 8 خانات';
    END IF;

    -- تشفير الـ PIN باستخدام bcrypt مع Salt عشوائي (Cost factor 10)
    UPDATE public.profiles
    SET pin_hash = crypt(trim(_raw_pin), gen_salt('bf', 10)),
        updated_at = now()
    WHERE user_id = _target_user_id;

    RETURN TRUE;
END;
$$;

-- 4. دالة التحقق من الـ PIN عند تسجيل الدخول السريع (بالمقارنة التشفيرية الآمنة ضد هجمات التوقيت)
CREATE OR REPLACE FUNCTION public.verify_user_pin(
    _user_id UUID,
    _entered_pin TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    _stored_hash TEXT;
BEGIN
    SELECT pin_hash INTO _stored_hash
    FROM public.profiles
    WHERE user_id = _user_id;

    IF _stored_hash IS NULL THEN
        RETURN FALSE;
    END IF;

    RETURN (_stored_hash = crypt(trim(_entered_pin), _stored_hash));
END;
$$;

-- 5. دالة تنظيف وتطبيع رقم الهاتف إلى صيغة معيارية موحدة
CREATE OR REPLACE FUNCTION public.normalize_phone_number(p_phone TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_clean TEXT;
BEGIN
    IF p_phone IS NULL OR trim(p_phone) = '' THEN
        RETURN NULL;
    END IF;

    -- إزالة كافة الرموز والمسافات والأقواس والإبقاء على الأرقام فقط وعلامة الزائد
    v_clean := regexp_replace(trim(p_phone), '[^\+0-9]', '', 'g');

    -- تحويل 00 في بداية الرقم الدولي إلى +
    IF v_clean ~ '^00' THEN
        v_clean := '+' || substring(v_clean from 3);
    END IF;

    -- إذا كان الرقم السوري يبدأ بـ 09 ننسقه إلى +9639
    IF v_clean ~ '^09[0-9]{8}$' THEN
        v_clean := '+963' || substring(v_clean from 2);
    -- إذا كان الرقم التركي يبدأ بـ 05 ننسقه إلى +905
    ELSIF v_clean ~ '^05[0-9]{9}$' THEN
        v_clean := '+90' || substring(v_clean from 2);
    END IF;

    -- إذا لم يحمل علامة + وكان رقماً محلياً، نتركه نظيفاً من المسافات
    IF v_clean = '' THEN
        RETURN NULL;
    END IF;

    RETURN v_clean;
END;
$$;

-- 6. تنظيف وتطبيع أرقام الهواتف الحالية في جدول profiles
UPDATE public.profiles
SET phone = public.normalize_phone_number(phone)
WHERE phone IS NOT NULL AND phone <> '';

-- تنظيف التكرارات السابقة إن وجدت لحماية إنشاء الفهرس الفريد
WITH ranked_phones AS (
    SELECT id, phone,
           ROW_NUMBER() OVER (
               PARTITION BY phone 
               ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
           ) as rn
    FROM public.profiles
    WHERE phone IS NOT NULL AND phone <> ''
)
UPDATE public.profiles p
SET phone = NULL
FROM ranked_phones rp
WHERE p.id = rp.id AND rp.rn > 1;

-- 7. مشغل تلقائي لتطبيع الهاتف قبل الإدخال أو التحديث
CREATE OR REPLACE FUNCTION public.trigger_normalize_profile_phone()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.phone := public.normalize_phone_number(NEW.phone);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_profile_phone ON public.profiles;
CREATE TRIGGER trg_normalize_profile_phone
    BEFORE INSERT OR UPDATE OF phone ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_normalize_profile_phone();

-- 8. فرض قيد التفرد الصارم (Unique Partial Index)
DROP INDEX IF EXISTS idx_profiles_phone_unique;
CREATE UNIQUE INDEX idx_profiles_phone_unique 
ON public.profiles (phone) 
WHERE (phone IS NOT NULL AND phone <> '');

-- 9. دالة الفحص الاستباقي: تمنع التكرار والاستيلاء وترجع رسالة خطأ واضحة
CREATE OR REPLACE FUNCTION public.check_phone_email_availability(
    _phone TEXT,
    _email TEXT,
    _exclude_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
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
$$;

-- منح صلاحيات التنفيذ
GRANT EXECUTE ON FUNCTION public.set_user_pin(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_user_pin(UUID, TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.normalize_phone_number(TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.check_phone_email_availability(TEXT, TEXT, UUID) TO authenticated, anon;
