-- boss_change_user_password(_target_user_id uuid, _new_password text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,=X/postgres}

CREATE OR REPLACE FUNCTION public.boss_change_user_password(_target_user_id uuid, _new_password text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'extensions'
AS $function$
BEGIN
  -- التحقق من أن المنفذ يحمل رتبة boss حصراً
  IF NOT public.is_boss(auth.uid()) THEN
    RAISE EXCEPTION 'غير مصرح: هذه العملية مخصصة لحساب المطور / Boss فقط';
  END IF;

  IF _new_password IS NULL OR length(trim(_new_password)) < 6 THEN
    RAISE EXCEPTION 'كلمة المرور يجب أن لا تقل عن 6 أحرف';
  END IF;

  -- تشفير وتحديث كلمة المرور مباشرة في جدول المستخدمين
  UPDATE auth.users
  SET 
    encrypted_password = extensions.crypt(_new_password, extensions.gen_salt('bf')),
    updated_at = now()
  WHERE id = _target_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'المستخدم غير موجود';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'تم تحديث كلمة المرور بنجاح'
  );
END;
$function$
;
