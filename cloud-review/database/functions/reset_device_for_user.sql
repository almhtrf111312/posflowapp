-- reset_device_for_user(p_target_email text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.reset_device_for_user(p_target_email text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_caller_role TEXT;
  v_target_user_id UUID;
BEGIN
  -- التحقق أن المستدعي هو Boss
  SELECT role INTO v_caller_role FROM public.user_roles WHERE user_id = auth.uid() LIMIT 1;
  IF v_caller_role != 'boss' THEN
    RAISE EXCEPTION 'غير مصرح: هذه العملية مخصصة لحساب Boss فقط';
  END IF;

  SELECT id INTO v_target_user_id FROM auth.users WHERE email = p_target_email LIMIT 1;
  IF v_target_user_id IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير موجود';
  END IF;

  UPDATE public.app_licenses
  SET device_id = NULL, updated_at = now()
  WHERE user_id = v_target_user_id;

  RETURN TRUE;
END;
$function$
;
