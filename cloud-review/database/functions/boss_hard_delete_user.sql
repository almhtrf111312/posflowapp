-- boss_hard_delete_user(_target_user_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,=X/postgres}

CREATE OR REPLACE FUNCTION public.boss_hard_delete_user(_target_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN
    RAISE EXCEPTION 'غير مصرح: العملية مخصصة لحساب Boss فقط';
  END IF;

  IF _target_user_id IS NULL THEN
    RAISE EXCEPTION 'معرف المستخدم غير صالح';
  END IF;

  -- 1) حذف بيانات الجداول التابعة
  DELETE FROM public.user_roles WHERE user_id = _target_user_id OR owner_id = _target_user_id;
  DELETE FROM public.profiles WHERE user_id = _target_user_id;
  DELETE FROM public.app_licenses WHERE user_id = _target_user_id;
  DELETE FROM public.stores WHERE user_id = _target_user_id;

  -- 2) الحذف الجذري من جدول مصادقة Supabase الرئيسي لمنعه من تسجيل الدخول نهائياً
  DELETE FROM auth.users WHERE id = _target_user_id;

  RETURN jsonb_build_object('success', true, 'message', 'تم حذف الحساب بالكامل من النظام ومنعه من الدخول');
END;
$function$
;
