-- request_device_reset_secure(p_user_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

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
$function$
;
