-- boss_set_single_device(p_target_email text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,=X/postgres}

CREATE OR REPLACE FUNCTION public.boss_set_single_device(p_target_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_target_user_id UUID;
BEGIN
  -- التحقق من صلاحية Boss
  IF NOT public.is_boss(auth.uid()) THEN
    RAISE EXCEPTION 'غير مصرح: هذه العملية لحساب Boss فقط';
  END IF;

  SELECT id INTO v_target_user_id FROM auth.users WHERE email = trim(p_target_email) LIMIT 1;
  IF v_target_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'المستخدم غير موجود');
  END IF;

  -- إلغاء التعدد وتصفير الجهاز حتى يقفل على أول جهاز يسجل دخولاً
  UPDATE public.app_licenses
  SET allow_multi_device = false,
      device_id = NULL,
      updated_at = now()
  WHERE user_id = v_target_user_id;

  RETURN jsonb_build_object('success', true, 'message', 'تم إلغاء التعدد وجاهز للربط على أول جهاز فقط');
END;
$function$
;
