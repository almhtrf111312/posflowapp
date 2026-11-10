-- =========================================================================
-- FlowPOS Pro — نقل الحساب لجهاز آخر: ذاتياً بعد 5 أيام من ربط الجهاز الحالي
-- آمن لإعادة التشغيل. لا يحذف بيانات.
--
-- القاعدة:
--   - إذا مضى 5 أيام أو أكثر على ربط الجهاز الحالي: زر «تصفير الجهاز» في شاشة الدخول
--     يفك الربط فوراً ويُسجَّل الدخول من الجهاز الجديد.
--   - قبل 5 أيام: يُرفض النقل الذاتي برسالة توضح المدة المتبقية، ويتم النقل عبر الدعم (بوت تيليجرام).
-- =========================================================================

BEGIN;

-- 1. تاريخ ربط الجهاز الحالي بالترخيص
ALTER TABLE public.app_licenses ADD COLUMN IF NOT EXISTS device_bound_at timestamptz;

UPDATE public.app_licenses
   SET device_bound_at = COALESCE(last_device_reset_at, activated_at, created_at)
 WHERE device_id IS NOT NULL
   AND device_bound_at IS NULL;

-- 2. تسجيل وقت الربط تلقائياً كلما تغيّر الجهاز المربوط (من أي مسار: الدخول، الفحص، لوحة البوس)
CREATE OR REPLACE FUNCTION public.track_license_device_binding()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.device_id IS NULL THEN
    NEW.device_bound_at := NULL;
  ELSIF TG_OP = 'INSERT' OR NEW.device_id IS DISTINCT FROM OLD.device_id THEN
    NEW.device_bound_at := now();
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_track_license_device_binding ON public.app_licenses;
CREATE TRIGGER trg_track_license_device_binding
BEFORE INSERT OR UPDATE OF device_id ON public.app_licenses
FOR EACH ROW
EXECUTE FUNCTION public.track_license_device_binding();

-- 3. التصفير الذاتي للجهاز (تستدعيه دالة reset-own-device بعد التحقق من كلمة المرور)
CREATE OR REPLACE FUNCTION public.request_device_reset_secure(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _lic public.app_licenses%ROWTYPE;
  _since timestamptz;
  _available_at timestamptz;
  _left interval;
BEGIN
  -- يُسمح فقط للخادم (service role) أو لصاحب الحساب نفسه أو للبوس
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id AND NOT public.is_boss(auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'غير مصرح');
  END IF;

  SELECT * INTO _lic FROM public.app_licenses WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'لا يوجد ترخيص مرتبط بهذا الحساب');
  END IF;

  IF _lic.device_id IS NULL OR COALESCE(_lic.allow_multi_device, false) THEN
    RETURN jsonb_build_object('success', true, 'already_free', true, 'reset_at', now());
  END IF;

  _since := COALESCE(_lic.device_bound_at, _lic.last_device_reset_at, _lic.activated_at, _lic.created_at, now());
  _available_at := _since + interval '5 days';

  IF now() < _available_at THEN
    _left := _available_at - now();
    RETURN jsonb_build_object(
      'success', false,
      'available_at', _available_at,
      'error', format(
        'لا يمكن نقل الحساب ذاتياً قبل مرور 5 أيام على ربط الجهاز الحالي (متبقٍ %s يوم و%s ساعة). لنقل الحساب الآن تواصل مع الدعم عبر بوت تيليجرام.',
        extract(day FROM _left)::int,
        extract(hour FROM _left)::int
      )
    );
  END IF;

  UPDATE public.app_licenses
     SET device_id = NULL,
         last_device_reset_at = now(),
         device_reset_count = COALESCE(device_reset_count, 0) + 1,
         updated_at = now()
   WHERE id = _lic.id;

  RETURN jsonb_build_object('success', true, 'reset_at', now());
END;
$function$;

REVOKE ALL ON FUNCTION public.request_device_reset_secure(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_device_reset_secure(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- التحقق بعد التنفيذ: يجب أن تكون القيم true
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'app_licenses' AND column_name = 'device_bound_at') AS bound_at_column_ready,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_track_license_device_binding') AS binding_trigger_ready,
  to_regprocedure('public.request_device_reset_secure(uuid)') IS NOT NULL AS self_reset_ready;
