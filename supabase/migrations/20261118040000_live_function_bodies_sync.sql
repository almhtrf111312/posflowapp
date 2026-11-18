-- Bring function bodies in line with the live database (edited there directly).
-- request_device_reset_secure(text,text) intentionally left as is: the live version references columns that no longer exist.

CREATE OR REPLACE FUNCTION public.activate_code_strict__impl(p_code text, p_user_id uuid, p_user_email text, p_device_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _code_rec record; _new_expires_at timestamptz;
BEGIN
  SELECT * INTO _code_rec FROM public.activation_codes WHERE upper(trim(code)) = upper(trim(p_code)) AND is_active = true FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'كود التفعيل غير صالح أو غير موجود'); END IF;
  IF _code_rec.current_uses >= _code_rec.max_uses THEN RETURN jsonb_build_object('success', false, 'error', 'تم استخدام هذا الكود وتفعيله مسبقاً'); END IF;
  IF _code_rec.assigned_email IS NOT NULL AND lower(trim(_code_rec.assigned_email)) <> lower(trim(p_user_email)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'هذا الكود مخصص لبريد إلكتروني آخر ولا يمكن استخدامه لهذا الحساب');
  END IF;
  IF _code_rec.assigned_user_id IS NOT NULL AND _code_rec.assigned_user_id <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'هذا الكود مخصص لحساب آخر');
  END IF;
  _new_expires_at := now() + (_code_rec.duration_days || ' days')::interval;
  INSERT INTO public.app_licenses (user_id, activation_code_id, activated_at, expires_at, is_trial, is_revoked, max_cashiers, license_tier, device_id, allow_multi_device)
  VALUES (p_user_id, _code_rec.id, now(), _new_expires_at, false, false, COALESCE(_code_rec.max_cashiers, 1), COALESCE(_code_rec.license_tier, 'basic'), p_device_id, false)
  ON CONFLICT (user_id) DO UPDATE SET
    activation_code_id = EXCLUDED.activation_code_id, activated_at = EXCLUDED.activated_at, expires_at = EXCLUDED.expires_at,
    is_trial = false, is_revoked = false, max_cashiers = EXCLUDED.max_cashiers, license_tier = EXCLUDED.license_tier,
    device_id = CASE WHEN app_licenses.allow_multi_device THEN app_licenses.device_id ELSE p_device_id END,
    revoked_at = NULL, revoked_reason = NULL;
  UPDATE public.activation_codes SET current_uses = current_uses + 1, is_active = false, used_by = p_user_id, used_at = now(), locked_device_id = p_device_id WHERE id = _code_rec.id;
  RETURN jsonb_build_object('success', true, 'expires_at', _new_expires_at, 'duration_days', _code_rec.duration_days, 'max_cashiers', _code_rec.max_cashiers);
END;
$function$;

CREATE OR REPLACE FUNCTION public.boss_ban_user(p_target_user_id uuid, p_reason text DEFAULT NULL::text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_lic public.app_licenses%ROWTYPE; v_email text; v_reason text := NULLIF(trim(COALESCE(p_reason, '')), ''); v_device text;
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN RETURN jsonb_build_object('success', false, 'error', 'غير مصرح: هذا الإجراء مخصص للمدير العام فقط'); END IF;
  IF p_target_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_target_user_id) THEN RETURN jsonb_build_object('success', false, 'error', 'الحساب غير موجود'); END IF;
  IF public.is_boss(p_target_user_id) THEN RETURN jsonb_build_object('success', false, 'error', 'لا يمكن حظر حساب مدير عام'); END IF;
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_target_user_id AND role::text = 'cashier') THEN RETURN jsonb_build_object('success', false, 'error', 'الحظر يُطبَّق على حساب المالك فقط'); END IF;
  SELECT email INTO v_email FROM auth.users WHERE id = p_target_user_id;
  SELECT * INTO v_lic FROM public.app_licenses WHERE user_id = p_target_user_id FOR UPDATE;
  v_device := NULLIF(trim(COALESCE(v_lic.device_id, '')), '');
  INSERT INTO public.banned_devices (device_id, banned_user_id, banned_email, reason, banned_by, revoked_license)
  VALUES ('user:' || p_target_user_id::text, p_target_user_id, v_email, v_reason, auth.uid(), true)
  ON CONFLICT (device_id) DO UPDATE SET reason = EXCLUDED.reason, banned_at = now(), revoked_license = true;
  IF v_device IS NOT NULL THEN
    INSERT INTO public.banned_devices (device_id, banned_user_id, banned_email, reason, banned_by, revoked_license)
    VALUES (v_device, p_target_user_id, v_email, v_reason, auth.uid(), true)
    ON CONFLICT (device_id) DO UPDATE SET banned_user_id = EXCLUDED.banned_user_id, banned_email = EXCLUDED.banned_email, reason = EXCLUDED.reason, banned_by = EXCLUDED.banned_by, banned_at = now(), revoked_license = true;
  END IF;
  IF v_lic.user_id IS NOT NULL THEN
    UPDATE public.app_licenses SET is_revoked = true, revoked_at = now(), revoked_reason = 'حظر: ' || COALESCE(v_reason, 'بقرار الإدارة'), updated_at = now() WHERE user_id = p_target_user_id;
  END IF;
  RETURN jsonb_build_object('success', true, 'device_banned', v_device IS NOT NULL, 'device_id', v_device,
    'message', CASE WHEN v_device IS NULL THEN 'أُوقف الترخيص، لكن لا يوجد رقم جهاز مرتبط بهذا الحساب ليُحظر' ELSE 'تم حظر الجهاز وإيقاف الترخيص' END);
END;
$function$;

CREATE OR REPLACE FUNCTION public.boss_unban_user(p_target_user_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_deleted integer;
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN RETURN jsonb_build_object('success', false, 'error', 'غير مصرح: هذا الإجراء مخصص للمدير العام فقط'); END IF;
  DELETE FROM public.banned_devices WHERE banned_user_id = p_target_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  UPDATE public.app_licenses SET is_revoked = false, revoked_at = NULL, revoked_reason = NULL, updated_at = now()
  WHERE user_id = p_target_user_id AND is_revoked = true AND revoked_reason LIKE 'حظر:%';
  RETURN jsonb_build_object('success', true, 'devices_unbanned', v_deleted);
END;
$function$;

CREATE OR REPLACE FUNCTION public.can_add_cashier__impl(_owner_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _max_cashiers integer; _current_cashiers integer; _is_revoked boolean; _expires_at timestamptz;
BEGIN
  SELECT max_cashiers, is_revoked, expires_at INTO _max_cashiers, _is_revoked, _expires_at
  FROM public.app_licenses WHERE user_id = _owner_id ORDER BY created_at DESC LIMIT 1;
  IF _max_cashiers IS NULL OR _is_revoked IS TRUE OR (_expires_at IS NOT NULL AND _expires_at < now()) THEN RETURN false; END IF;
  SELECT count(*) INTO _current_cashiers FROM public.user_roles WHERE owner_id = _owner_id AND role = 'cashier';
  RETURN _current_cashiers < _max_cashiers;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_and_bind_device(p_device_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'auth' AS $function$
DECLARE v_user_id UUID := auth.uid(); v_user_role TEXT; v_owner_id UUID; v_license RECORD; v_clean_device_id TEXT;
BEGIN
  IF v_user_id IS NULL THEN RETURN jsonb_build_object('success', false, 'blocked', true, 'error', 'المستخدم غير مسجل'); END IF;
  SELECT role INTO v_user_role FROM public.user_roles WHERE user_id = v_user_id LIMIT 1;
  IF v_user_role = 'boss' THEN RETURN jsonb_build_object('success', true, 'blocked', false, 'is_boss', true); END IF;
  v_owner_id := public.get_owner_id(v_user_id);
  IF v_owner_id IS NULL THEN v_owner_id := v_user_id; END IF;
  SELECT id, device_id, allow_multi_device, is_revoked, expires_at INTO v_license
  FROM public.app_licenses WHERE user_id = v_owner_id ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'blocked', true, 'error', 'لا يوجد ترخيص فعال لهذا الحساب'); END IF;
  IF v_license.is_revoked = true THEN RETURN jsonb_build_object('success', false, 'blocked', true, 'error', 'الترخيص موقوف أو ملغى'); END IF;
  IF v_license.allow_multi_device = true THEN RETURN jsonb_build_object('success', true, 'blocked', false, 'allow_multi_device', true); END IF;
  v_clean_device_id := trim(COALESCE(p_device_id, ''));
  IF v_clean_device_id = '' THEN RETURN jsonb_build_object('success', false, 'blocked', true, 'error', 'معرّف الجهاز مفقود'); END IF;
  IF v_license.device_id IS NULL OR trim(v_license.device_id) = '' THEN
    UPDATE public.app_licenses SET device_id = v_clean_device_id, updated_at = now() WHERE id = v_license.id;
    RETURN jsonb_build_object('success', true, 'blocked', false, 'bound_now', true, 'registered_device_id', v_clean_device_id);
  END IF;
  IF trim(v_license.device_id) = v_clean_device_id THEN
    RETURN jsonb_build_object('success', true, 'blocked', false, 'matched', true);
  ELSE
    RETURN jsonb_build_object('success', false, 'blocked', true, 'error', 'هذا الحساب مرتبط بجهاز آخر، ولا يمكن استخدامه على هذا الجهاز', 'registered_device_id', v_license.device_id);
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_on_support_message() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_conv record; v_target_user uuid; v_title text; v_body text;
BEGIN
  SELECT * INTO v_conv FROM public.support_conversations WHERE id = NEW.conversation_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.sender_role IN ('boss', 'admin') THEN
    v_target_user := v_conv.user_id;
    v_title := '💬 رسالة جديدة من الدعم الفني';
    v_body := substring(NEW.message from 1 for 100);
    INSERT INTO public.user_notifications (user_id, title, message, type, action_url)
    VALUES (v_target_user, v_title, v_body, 'support_reply', '/contact');
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.verify_user_pin(_user_id uuid, _entered_pin text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $function$
DECLARE _stored_hash TEXT;
BEGIN
  SELECT pin_hash INTO _stored_hash FROM public.profiles WHERE user_id = _user_id;
  IF _stored_hash IS NULL THEN RETURN FALSE; END IF;
  RETURN (_stored_hash = crypt(trim(_entered_pin), _stored_hash));
END;
$function$;
