-- request_device_reset_secure(_license_key text, _user_email text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.request_device_reset_secure(_license_key text, _user_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _lic record;
BEGIN
  -- التحقق من وجود الترخيص ومطابقة البريد
  SELECT * INTO _lic 
    FROM public.app_licenses 
   WHERE license_key = _license_key 
     AND lower(email) = lower(_user_email)
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false, 
      'message', 'بيانات الترخيص أو البريد الإلكتروني غير صحيحة.'
    );
  END IF;

  -- تفريغ معرف الجهاز وتوثيق تاريخ إعادة التعيين
  UPDATE public.app_licenses
     SET bound_device_id = NULL,
         last_reset_at = now(),
         updated_at = now()
   WHERE id = _lic.id;

  RETURN jsonb_build_object(
    'success', true, 
    'message', 'تم فك ربط الجهاز بنجاح. يمكنك الآن تسجيل الدخول من جهازك الجديد.'
  );
END;
$function$
;
