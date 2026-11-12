-- activate_code_strict(p_code text, p_user_id uuid, p_user_email text, p_device_id text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.activate_code_strict(p_code text, p_user_id uuid, p_user_email text, p_device_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _code_rec record;
  _new_expires_at timestamptz;
BEGIN
  -- جلب الكود مع قفل السجل لمنع أي تكرار متزامن
  SELECT * INTO _code_rec
  FROM public.activation_codes
  WHERE upper(trim(code)) = upper(trim(p_code))
    AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'كود التفعيل غير صالح أو غير موجود');
  END IF;

  -- التحقق من عدد مرات الاستخدام
  IF _code_rec.current_uses >= _code_rec.max_uses THEN
    RETURN jsonb_build_object('success', false, 'error', 'تم استخدام هذا الكود وتفعيله مسبقاً');
  END IF;

  -- 1) شرط الإيميل: منع التفعيل إذا كان الكود مخصصاً لإيميل آخر
  IF _code_rec.assigned_email IS NOT NULL AND lower(trim(_code_rec.assigned_email)) <> lower(trim(p_user_email)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'هذا الكود مخصص لبريد إلكتروني آخر ولا يمكن استخدامه لهذا الحساب');
  END IF;

  -- 2) شرط الحساب: منع التفعيل إذا كان مخصصاً لمعرف مستخدم آخر
  IF _code_rec.assigned_user_id IS NOT NULL AND _code_rec.assigned_user_id <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'هذا الكود مخصص لحساب آخر');
  END IF;

  _new_expires_at := now() + (_code_rec.duration_days || ' days')::interval;

  -- 3) تثبيت الترخيص وربطه ببصمة الجهاز الأول
  INSERT INTO public.app_licenses (
    user_id,
    activation_code_id,
    activated_at,
    expires_at,
    is_trial,
    is_revoked,
    max_cashiers,
    license_tier,
    device_id,
    allow_multi_device
  ) VALUES (
    p_user_id,
    _code_rec.id,
    now(),
    _new_expires_at,
    false,
    false,
    COALESCE(_code_rec.max_cashiers, 1),
    COALESCE(_code_rec.license_tier, 'basic'),
    p_device_id,
    false
  )
  ON CONFLICT (user_id) DO UPDATE SET
    activation_code_id = EXCLUDED.activation_code_id,
    activated_at = EXCLUDED.activated_at,
    expires_at = EXCLUDED.expires_at,
    is_trial = false,
    is_revoked = false,
    max_cashiers = EXCLUDED.max_cashiers,
    license_tier = EXCLUDED.license_tier,
    device_id = CASE WHEN app_licenses.allow_multi_device THEN app_licenses.device_id ELSE p_device_id END,
    revoked_at = NULL,
    revoked_reason = NULL;

  -- 4) قفل الكود فوراً ومنعه من التفعيل لأي جهاز آخر
  UPDATE public.activation_codes
  SET current_uses = current_uses + 1,
      is_active = false,
      used_by = p_user_id,
      used_at = now(),
      locked_device_id = p_device_id
  WHERE id = _code_rec.id;

  RETURN jsonb_build_object(
    'success', true,
    'expires_at', _new_expires_at,
    'duration_days', _code_rec.duration_days,
    'max_cashiers', _code_rec.max_cashiers
  );
END;
$function$
;
