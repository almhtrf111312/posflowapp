-- check_and_bind_device(p_device_id text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.check_and_bind_device(p_device_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_user_role TEXT;
  v_owner_id UUID;
  v_license RECORD;
  v_clean_device_id TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'blocked', true, 'error', 'المستخدم غير مسجل');
  END IF;

  -- 1. استثناء الـ Boss استثناءً مطلقاً من أي قيود للأجهزة
  SELECT role INTO v_user_role FROM public.user_roles WHERE user_id = v_user_id LIMIT 1;
  IF v_user_role = 'boss' THEN
    RETURN jsonb_build_object('success', true, 'blocked', false, 'is_boss', true);
  END IF;

  -- تحديد معرّف المالك
  v_owner_id := public.get_owner_id(v_user_id);
  IF v_owner_id IS NULL THEN 
    v_owner_id := v_user_id; 
  END IF;

  -- جلب بيانات الرخصة الحالية
  SELECT id, device_id, allow_multi_device, is_revoked, expires_at
  INTO v_license
  FROM public.app_licenses
  WHERE user_id = v_owner_id
  ORDER BY created_at DESC 
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'blocked', true, 'error', 'لا يوجد ترخيص فعال لهذا الحساب');
  END IF;

  IF v_license.is_revoked = true THEN
    RETURN jsonb_build_object('success', false, 'blocked', true, 'error', 'الترخيص موقوف أو ملغى');
  END IF;

  -- إذا كان مسموحاً بتعدد الأجهزة صراحة
  IF v_license.allow_multi_device = true THEN
    RETURN jsonb_build_object('success', true, 'blocked', false, 'allow_multi_device', true);
  END IF;

  -- تنظيف معرّف الجهاز المرسل
  v_clean_device_id := trim(COALESCE(p_device_id, ''));
  IF v_clean_device_id = '' THEN
    RETURN jsonb_build_object('success', false, 'blocked', true, 'error', 'معرّف الجهاز مفقود');
  END IF;

  -- إذا لم يكن هناك جهاز مسجل: يتم قفل الحساب على هذا الجهاز فوراً
  IF v_license.device_id IS NULL OR trim(v_license.device_id) = '' THEN
    UPDATE public.app_licenses 
    SET device_id = v_clean_device_id, updated_at = now() 
    WHERE id = v_license.id;
    
    RETURN jsonb_build_object('success', true, 'blocked', false, 'bound_now', true, 'registered_device_id', v_clean_device_id);
  END IF;

  -- فحص التطابق مع الجهاز المسجل
  IF trim(v_license.device_id) = v_clean_device_id THEN
    RETURN jsonb_build_object('success', true, 'blocked', false, 'matched', true);
  ELSE
    -- حظر صريح وقاطع لأي جهاز ثانٍ
    RETURN jsonb_build_object(
      'success', false, 
      'blocked', true, 
      'error', 'هذا الحساب مرتبط بجهاز آخر، ولا يمكن استخدامه على هذا الجهاز',
      'registered_device_id', v_license.device_id
    );
  END IF;
END;
$function$
;
