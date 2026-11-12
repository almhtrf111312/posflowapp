-- boss_revoke_user_license(_target_user_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,=X/postgres}

CREATE OR REPLACE FUNCTION public.boss_revoke_user_license(_target_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- التحقق من صلاحية Boss
  IF NOT public.is_boss(auth.uid()) THEN
    RAISE EXCEPTION 'غير مصرح: مخصص لحساب Boss فقط';
  END IF;

  -- تحديث حالة الرخصة
  UPDATE public.app_licenses
  SET 
    is_revoked = true,
    revoked_at = now(),
    updated_at = now()
  WHERE user_id = _target_user_id;

  -- تعطيل حساب المالك والموظفين التابعين له فورياً
  UPDATE public.user_roles
  SET is_active = false
  WHERE user_id = _target_user_id OR owner_id = _target_user_id;

  RETURN jsonb_build_object(
    'success', true, 
    'message', 'تم إلغاء الترخيص وتعطيل الحساب فورياً'
  );
END;
$function$
;
