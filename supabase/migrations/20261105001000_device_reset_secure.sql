-- ============================================================================
-- Migration: 20261105001000_device_reset_secure.sql
-- Description: دالة فك ربط جهاز الكاشير أو المستخدم بأمان (Secure Cashier/User Device Unbinding RPC)
-- ============================================================================

-- 1. التأكد من توفر الحقول المساعدة في جدول تراخيص التطبيق
ALTER TABLE public.app_licenses
  ADD COLUMN IF NOT EXISTS license_key text,
  ADD COLUMN IF NOT EXISTS bound_device_id text,
  ADD COLUMN IF NOT EXISTS last_reset_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- 2. دالة فك ربط الجهاز الآمنة
CREATE OR REPLACE FUNCTION public.request_device_reset_secure(
  _license_key text,
  _user_email text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _clean_key text := upper(replace(trim(_license_key), ' ', ''));
  _clean_email text := lower(trim(_user_email));
  _lic record;
BEGIN
  IF _clean_key IS NULL OR _clean_key = '' OR _clean_email IS NULL OR _clean_email = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'يرجى تزويد مفتاح الترخيص والبريد الإلكتروني بشكل صحيح.'
    );
  END IF;

  -- البحث في جدول التراخيص بالربط مع المستخدمين وأكواد التفعيل
  SELECT l.id, l.user_id, l.activation_code_id
    INTO _lic
    FROM public.app_licenses l
    LEFT JOIN auth.users u ON u.id = l.user_id
    LEFT JOIN public.activation_codes ac ON ac.id = l.activation_code_id
   WHERE (
     upper(replace(COALESCE(l.license_key, ''), ' ', '')) = _clean_key
     OR (ac.code IS NOT NULL AND upper(replace(ac.code, ' ', '')) = _clean_key)
   )
   AND (
     (u.email IS NOT NULL AND lower(trim(u.email)) = _clean_email)
     OR (ac.assigned_email IS NOT NULL AND lower(trim(ac.assigned_email)) = _clean_email)
   )
   ORDER BY l.created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    -- محاولة فحص بديلة مباشرة في حال كان كود التفعيل مطابقاً في جدول التراخيص
    SELECT l.id, l.user_id, l.activation_code_id
      INTO _lic
      FROM public.app_licenses l
      LEFT JOIN auth.users u ON u.id = l.user_id
     WHERE upper(replace(COALESCE(l.license_key, ''), ' ', '')) = _clean_key
       AND u.email IS NOT NULL 
       AND lower(trim(u.email)) = _clean_email
     ORDER BY l.created_at DESC
     LIMIT 1;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'success', false,
        'message', 'بيانات الترخيص أو البريد الإلكتروني غير صحيحة.'
      );
    END IF;
  END IF;

  -- تصفير ربط الجهاز في جدول التراخيص
  UPDATE public.app_licenses
     SET device_id = NULL,
         bound_device_id = NULL,
         last_reset_at = now(),
         updated_at = now()
   WHERE id = _lic.id;

  -- تصفير قفل الجهاز في كود التفعيل المرتبط إن وجد
  IF _lic.activation_code_id IS NOT NULL THEN
    UPDATE public.activation_codes
       SET locked_device_id = NULL
     WHERE id = _lic.activation_code_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'تم فك ربط الجهاز بنجاح. يمكنك الآن تسجيل الدخول من جهازك الجديد.'
  );
END;
$function$;

-- منح صلاحيات التشغيل
REVOKE EXECUTE ON FUNCTION public.request_device_reset_secure(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_device_reset_secure(text, text) TO anon, authenticated, service_role;
