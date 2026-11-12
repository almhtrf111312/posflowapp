-- boss_reactivate_user_license(_target_user_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,=X/postgres}

CREATE OR REPLACE FUNCTION public.boss_reactivate_user_license(_target_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN
    RAISE EXCEPTION 'غير مصرح: مخصص لحساب Boss فقط';
  END IF;

  -- إعادة تفعيل الرخصة
  UPDATE public.app_licenses
  SET 
    is_revoked = false,
    revoked_at = NULL,
    updated_at = now()
  WHERE user_id = _target_user_id;

  -- إعادة تفعيل حساب المالك والكاشيرات
  UPDATE public.user_roles
  SET is_active = true
  WHERE user_id = _target_user_id OR owner_id = _target_user_id;

  RETURN jsonb_build_object(
    'success', true, 
    'message', 'تمت إعادة تفعيل الترخيص وتنشيط الحساب بنجاح'
  );
END;
$function$
;
