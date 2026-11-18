-- Functions that exist on the live database but were created outside migration files.

CREATE OR REPLACE FUNCTION public.assign_store_and_profile_phone(_phone text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'auth' AS $function$
DECLARE _caller UUID := auth.uid(); _normalized_phone TEXT; _other_user UUID;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'غير مصرح: يجب تسجيل الدخول'; END IF;
  IF _phone IS NULL OR trim(_phone) = '' THEN
    UPDATE public.profiles SET phone = NULL, updated_at = now() WHERE user_id = _caller;
    UPDATE public.stores SET phone = NULL WHERE user_id = _caller;
    RETURN jsonb_build_object('ok', true, 'status', 'cleared');
  END IF;
  _normalized_phone := public.normalize_phone_number(_phone);
  SELECT user_id INTO _other_user FROM public.profiles WHERE phone = _normalized_phone AND user_id <> _caller LIMIT 1;
  IF _other_user IS NOT NULL THEN RAISE EXCEPTION 'الرقم مسجل بالفعل لحساب مستخدم آخر، يتطلب التحقق عبر تيليجرام'; END IF;
  UPDATE public.profiles SET phone = _normalized_phone, updated_at = now() WHERE user_id = _caller;
  UPDATE public.stores SET phone = _normalized_phone WHERE user_id = _caller;
  RETURN jsonb_build_object('ok', true, 'status', 'assigned', 'normalized_phone', _normalized_phone);
END;
$function$;

CREATE OR REPLACE FUNCTION public.auto_confirm_user_email() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'auth' AS $function$
BEGIN
  NEW.email_confirmed_at := COALESCE(NEW.email_confirmed_at, now());
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.boss_change_user_password(_target_user_id uuid, _new_password text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'auth', 'extensions' AS $function$
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN RAISE EXCEPTION 'غير مصرح: هذه العملية مخصصة لحساب المطور / Boss فقط'; END IF;
  IF _new_password IS NULL OR length(trim(_new_password)) < 6 THEN RAISE EXCEPTION 'كلمة المرور يجب أن لا تقل عن 6 أحرف'; END IF;
  UPDATE auth.users SET encrypted_password = extensions.crypt(_new_password, extensions.gen_salt('bf')), updated_at = now() WHERE id = _target_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'المستخدم غير موجود'; END IF;
  RETURN jsonb_build_object('success', true, 'message', 'تم تحديث كلمة المرور بنجاح');
END;
$function$;

CREATE OR REPLACE FUNCTION public.boss_hard_delete_user(_target_user_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'auth' AS $function$
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN RAISE EXCEPTION 'غير مصرح: العملية مخصصة لحساب Boss فقط'; END IF;
  IF _target_user_id IS NULL THEN RAISE EXCEPTION 'معرف المستخدم غير صالح'; END IF;
  DELETE FROM public.user_roles WHERE user_id = _target_user_id OR owner_id = _target_user_id;
  DELETE FROM public.profiles WHERE user_id = _target_user_id;
  DELETE FROM public.app_licenses WHERE user_id = _target_user_id;
  DELETE FROM public.stores WHERE user_id = _target_user_id;
  DELETE FROM auth.users WHERE id = _target_user_id;
  RETURN jsonb_build_object('success', true, 'message', 'تم حذف الحساب بالكامل من النظام ومنعه من الدخول');
END;
$function$;

CREATE OR REPLACE FUNCTION public.boss_reactivate_user_license(_target_user_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN RAISE EXCEPTION 'غير مصرح: مخصص لحساب Boss فقط'; END IF;
  UPDATE public.app_licenses SET is_revoked = false, revoked_at = NULL, updated_at = now() WHERE user_id = _target_user_id;
  UPDATE public.user_roles SET is_active = true WHERE user_id = _target_user_id OR owner_id = _target_user_id;
  RETURN jsonb_build_object('success', true, 'message', 'تمت إعادة تفعيل الترخيص وتنشيط الحساب بنجاح');
END;
$function$;

CREATE OR REPLACE FUNCTION public.boss_revoke_user_license(_target_user_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN RAISE EXCEPTION 'غير مصرح: مخصص لحساب Boss فقط'; END IF;
  UPDATE public.app_licenses SET is_revoked = true, revoked_at = now(), updated_at = now() WHERE user_id = _target_user_id;
  UPDATE public.user_roles SET is_active = false WHERE user_id = _target_user_id OR owner_id = _target_user_id;
  RETURN jsonb_build_object('success', true, 'message', 'تم إلغاء الترخيص وتعطيل الحساب فورياً');
END;
$function$;

CREATE OR REPLACE FUNCTION public.boss_set_single_device(p_target_email text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'auth' AS $function$
DECLARE v_target_user_id UUID;
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN RAISE EXCEPTION 'غير مصرح: هذه العملية لحساب Boss فقط'; END IF;
  SELECT id INTO v_target_user_id FROM auth.users WHERE email = trim(p_target_email) LIMIT 1;
  IF v_target_user_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'المستخدم غير موجود'); END IF;
  UPDATE public.app_licenses SET allow_multi_device = false, device_id = NULL, updated_at = now() WHERE user_id = v_target_user_id;
  RETURN jsonb_build_object('success', true, 'message', 'تم إلغاء التعدد وجاهز للربط على أول جهاز فقط');
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_product_addition_limit(p_owner_id uuid, p_has_image boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF NOT public.caller_can_query_account(p_owner_id) THEN
    RAISE EXCEPTION 'غير مصرح بالاستعلام عن بيانات حساب آخر' USING ERRCODE = '42501';
  END IF;
  RETURN public.check_product_addition_limit__impl(p_owner_id, p_has_image);
END;$function$;

CREATE OR REPLACE FUNCTION public.check_product_addition_limit__impl(p_owner_id uuid, p_has_image boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_license record; v_count integer; v_max_allowed integer := 100; v_tier text := 'trial';
BEGIN
  SELECT * INTO v_license FROM public.app_licenses WHERE user_id = p_owner_id;
  IF v_license.id IS NOT NULL THEN
    v_tier := COALESCE(v_license.license_tier, CASE WHEN v_license.is_trial THEN 'trial' ELSE 'standard' END);
    v_max_allowed := COALESCE(v_license.max_products, CASE WHEN v_tier = 'institution' THEN 5000 WHEN v_tier = 'pro' THEN 1000 WHEN v_tier = 'standard' THEN 600 ELSE 100 END);
  END IF;
  SELECT count(*) INTO v_count FROM public.products WHERE user_id = p_owner_id;
  IF v_count >= v_max_allowed THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'product_limit_reached', 'current_count', v_count, 'max_allowed', v_max_allowed, 'tier', v_tier,
      'message', 'لقد بلغت الحد الأقصى للمنتجات المسموحة في باقتك الحالية (' || v_max_allowed || ' منتج). يُرجى ترقية الاشتراك لإضافة المزيد.');
  END IF;
  IF v_tier = 'pro' AND v_count >= 600 AND p_has_image THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'image_not_allowed_above_limit', 'current_count', v_count, 'max_allowed', v_max_allowed, 'tier', v_tier,
      'message', 'في الباقة الاحترافية (Pro)، يُسمح بإضافة المنتجات بعد 600 منتج بدون صور فقط (حتى 1000 منتج).');
  END IF;
  RETURN jsonb_build_object('allowed', true, 'current_count', v_count, 'max_allowed', v_max_allowed, 'tier', v_tier);
END;
$function$;

CREATE OR REPLACE FUNCTION public.clean_old_error_logs() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE deleted_count integer;
BEGIN
  DELETE FROM public.error_logs WHERE (is_resolved = true AND occurred_at < NOW() - INTERVAL '14 days') OR (occurred_at < NOW() - INTERVAL '60 days');
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_phone_transfer(_request_id uuid, _entered_code text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'auth', 'extensions' AS $function$
DECLARE _caller UUID := auth.uid(); _req RECORD;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'غير مصرح: يجب تسجيل الدخول'; END IF;
  SELECT * INTO _req FROM public.phone_transfer_requests WHERE id = _request_id AND target_user_id = _caller;
  IF _req.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'طلب التحقق غير موجود أو منتهي الصلاحية'); END IF;
  IF _req.expires_at < now() THEN
    DELETE FROM public.phone_transfer_requests WHERE id = _request_id;
    RETURN jsonb_build_object('ok', false, 'error', 'انتهت صلاحية رمز التحقق، يرجى طلب رمز جديد');
  END IF;
  IF _req.attempts >= 3 THEN
    DELETE FROM public.phone_transfer_requests WHERE id = _request_id;
    RETURN jsonb_build_object('ok', false, 'error', 'تم تجاوز الحد الأقصى للمحاولات الخاطئة. اطلب رمزاً جديداً');
  END IF;
  IF _req.code_hash <> encode(digest(trim(_entered_code), 'sha256'), 'hex') THEN
    UPDATE public.phone_transfer_requests SET attempts = attempts + 1 WHERE id = _request_id;
    RETURN jsonb_build_object('ok', false, 'error', 'رمز التحقق غير صحيح، المحاولات المتبقية: ' || (2 - _req.attempts));
  END IF;
  UPDATE public.profiles SET phone = NULL, updated_at = now() WHERE user_id = _req.source_user_id;
  UPDATE public.profiles SET phone = _req.phone, updated_at = now() WHERE user_id = _caller;
  UPDATE public.stores SET phone = _req.phone WHERE user_id = _caller;
  DELETE FROM public.phone_transfer_requests WHERE id = _request_id;
  RETURN jsonb_build_object('ok', true, 'status', 'transferred', 'normalized_phone', _req.phone, 'message', 'تم نقل الرقم وربطه بحسابك وبمتجرك بنجاح');
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_subscription_request(p_plan_id uuid, p_method_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_user_id uuid := auth.uid(); v_plan record; v_method record; v_ref_code text; v_request_id uuid;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'المستخدم غير مسجل الدخول'; END IF;
  IF EXISTS (SELECT 1 FROM public.subscription_requests WHERE user_id = v_user_id AND status IN ('pending', 'paid_claimed')) THEN
    RAISE EXCEPTION 'لديك طلب تجديد قيد المراجعة بالفعل، يمكنك تعديله أو إلغاؤه';
  END IF;
  SELECT * INTO v_plan FROM public.subscription_plans WHERE id = p_plan_id AND enabled = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'باقة الاشتراك المحددة غير متوفرة أو معطلة'; END IF;
  SELECT * INTO v_method FROM public.payment_methods WHERE id = p_method_id AND enabled = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'طريقة الدفع المحددة غير متوفرة'; END IF;
  v_ref_code := 'FP-' || upper(substr(md5(random()::text), 1, 5));
  INSERT INTO public.subscription_requests (user_id, ref_code, plan_id, plan_name, plan_audience, plan_days, price_usd, equivalents_snapshot, method_id, method_name, status)
  VALUES (v_user_id, v_ref_code, v_plan.id, v_plan.name, v_plan.audience, v_plan.duration_days, v_plan.price_usd, v_plan.equivalents, v_method.id, v_method.name, 'pending')
  RETURNING id INTO v_request_id;
  RETURN jsonb_build_object('success', true, 'request_id', v_request_id, 'ref_code', v_ref_code);
END;
$function$;

CREATE OR REPLACE FUNCTION public.distribute_sale_profit_to_partners_atomic(_invoice_id text, _customer_name text, _is_debt boolean, _category_profits jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  _uid uuid := auth.uid(); _owner uuid; _cat_record record; _partner record; _cat_profit numeric; _cat_name text;
  _remaining numeric; _partner_share numeric; _dist_result jsonb := '[]'::jsonb; _profit_record jsonb;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'المستخدم غير مسجل'; END IF;
  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN RAISE EXCEPTION 'لم يتم العثور على حساب المالك'; END IF;
  IF _category_profits IS NULL OR jsonb_array_length(_category_profits) = 0 THEN
    RETURN jsonb_build_object('success', true, 'distributed_count', 0);
  END IF;
  FOR _cat_record IN SELECT * FROM jsonb_to_recordset(_category_profits) AS x(category text, profit numeric) LOOP
    _cat_name := COALESCE(_cat_record.category, 'عام');
    _cat_profit := round(COALESCE(_cat_record.profit, 0), 8);
    IF _cat_profit > 0 THEN
      _remaining := _cat_profit;
      FOR _partner IN SELECT * FROM public.partners WHERE user_id = _owner AND access_all = false FOR UPDATE LOOP
        SELECT (x->>'percentage')::numeric INTO _partner_share
          FROM jsonb_array_elements(COALESCE(_partner.category_shares, '[]'::jsonb)) AS x
          WHERE (x->>'enabled')::boolean = true AND (x->>'categoryName') = _cat_name LIMIT 1;
        IF _partner_share IS NOT NULL AND _partner_share > 0 THEN
          DECLARE _calc_share numeric := round((_cat_profit * _partner_share) / 100, 8);
          BEGIN
            _remaining := _remaining - _calc_share;
            _profit_record := jsonb_build_object('id', gen_random_uuid()::text, 'invoiceId', _invoice_id, 'amount', _calc_share, 'category', _cat_name, 'isDebt', _is_debt, 'createdAt', now());
            IF _is_debt THEN
              UPDATE public.partners SET
                pending_profit = round(COALESCE(pending_profit, 0) + _calc_share, 8),
                profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
                pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || jsonb_build_object('invoiceId', _invoice_id, 'amount', _calc_share, 'customerName', _customer_name, 'createdAt', now()),
                updated_at = now() WHERE id = _partner.id;
            ELSE
              UPDATE public.partners SET
                confirmed_profit = round(COALESCE(confirmed_profit, 0) + _calc_share, 8),
                current_balance = round(COALESCE(current_balance, 0) + _calc_share, 8),
                total_profit_earned = round(COALESCE(total_profit_earned, 0) + _calc_share, 8),
                profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
                updated_at = now() WHERE id = _partner.id;
            END IF;
            _dist_result := _dist_result || jsonb_build_object('partnerId', _partner.id, 'partnerName', _partner.name, 'amount', _calc_share, 'category', _cat_name);
          END;
        END IF;
      END LOOP;
      IF _remaining > 0 THEN
        FOR _partner IN SELECT * FROM public.partners WHERE user_id = _owner AND access_all = true AND COALESCE(share_percentage, 0) > 0 FOR UPDATE LOOP
          DECLARE _full_share numeric := round((_remaining * _partner.share_percentage) / 100, 8);
          BEGIN
            IF _full_share > 0 THEN
              _profit_record := jsonb_build_object('id', gen_random_uuid()::text, 'invoiceId', _invoice_id, 'amount', _full_share, 'category', _cat_name, 'isDebt', _is_debt, 'createdAt', now());
              IF _is_debt THEN
                UPDATE public.partners SET
                  pending_profit = round(COALESCE(pending_profit, 0) + _full_share, 8),
                  profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
                  pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || jsonb_build_object('invoiceId', _invoice_id, 'amount', _full_share, 'customerName', _customer_name, 'createdAt', now()),
                  updated_at = now() WHERE id = _partner.id;
              ELSE
                UPDATE public.partners SET
                  confirmed_profit = round(COALESCE(confirmed_profit, 0) + _full_share, 8),
                  current_balance = round(COALESCE(current_balance, 0) + _full_share, 8),
                  total_profit_earned = round(COALESCE(total_profit_earned, 0) + _full_share, 8),
                  profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
                  updated_at = now() WHERE id = _partner.id;
              END IF;
              _dist_result := _dist_result || jsonb_build_object('partnerId', _partner.id, 'partnerName', _partner.name, 'amount', _full_share, 'category', _cat_name);
            END IF;
          END;
        END LOOP;
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'invoice_id', _invoice_id, 'distributions', _dist_result);
END;
$function$;

CREATE OR REPLACE FUNCTION public.hard_delete_product_atomic(_product_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _owner uuid := public.get_owner_id(auth.uid());
BEGIN
  IF auth.uid() IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  DELETE FROM public.warehouse_stock WHERE product_id = _product_id;
  DELETE FROM public.products WHERE id = _product_id AND user_id = _owner;
  RETURN jsonb_build_object('success', true, 'deleted_id', _product_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.issue_offline_lease(p_device_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'auth', 'extensions' AS $function$
DECLARE v_user_id uuid := auth.uid(); v_owner_id uuid; v_license record; v_expires_at timestamptz; v_valid_until_epoch bigint; v_payload text; v_secret text; v_signature text;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Unauthorized: User not authenticated'; END IF;
  v_owner_id := public.get_owner_id(v_user_id);
  SELECT * INTO v_license FROM public.app_licenses WHERE user_id = v_owner_id AND (is_revoked IS FALSE OR is_revoked IS NULL) LIMIT 1;
  IF v_license IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'NO_ACTIVE_LICENSE'); END IF;
  IF v_license.device_id IS NOT NULL AND v_license.allow_multi_device IS NOT TRUE AND v_license.device_id <> p_device_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'DEVICE_MISMATCH');
  END IF;
  v_expires_at := LEAST(v_license.expires_at, now() + (COALESCE(v_license.max_offline_days, 15) || ' days')::interval);
  v_valid_until_epoch := EXTRACT(EPOCH FROM v_expires_at)::bigint;
  v_secret := COALESCE(v_license.offline_lease_secret, 'FLOWPOS_PRO_FALLBACK_SALT_2026');
  v_payload := v_license.id || ':' || p_device_id || ':' || v_valid_until_epoch || ':' || COALESCE(v_license.max_offline_invoices, 100);
  v_signature := encode(sha256((v_payload || ':' || v_secret)::bytea), 'hex');
  UPDATE public.app_licenses SET last_lease_issued_at = now() WHERE id = v_license.id;
  RETURN jsonb_build_object('success', true, 'license_id', v_license.id, 'device_id', p_device_id, 'valid_until_epoch', v_valid_until_epoch,
    'max_offline_invoices', COALESCE(v_license.max_offline_invoices, 100), 'signature', v_signature, 'issued_at_epoch', EXTRACT(EPOCH FROM now())::bigint);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reset_device_for_user(p_target_email text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'auth' AS $function$
DECLARE v_caller_role TEXT; v_target_user_id UUID;
BEGIN
  SELECT role INTO v_caller_role FROM public.user_roles WHERE user_id = auth.uid() LIMIT 1;
  IF v_caller_role != 'boss' THEN RAISE EXCEPTION 'غير مصرح: هذه العملية مخصصة لحساب Boss فقط'; END IF;
  SELECT id INTO v_target_user_id FROM auth.users WHERE email = p_target_email LIMIT 1;
  IF v_target_user_id IS NULL THEN RAISE EXCEPTION 'المستخدم غير موجود'; END IF;
  UPDATE public.app_licenses SET device_id = NULL, updated_at = now() WHERE user_id = v_target_user_id;
  RETURN TRUE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_expense_atomic(p_expense_id uuid, p_reason text DEFAULT 'تراجع بواسطة المستخدم'::text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_caller UUID := auth.uid(); v_expense RECORD;
BEGIN
  IF v_caller IS NULL THEN RETURN jsonb_build_object('success', false, 'message', 'يج ب تسجيل الدخول أولاً'); END IF;
  SELECT * INTO v_expense FROM public.expenses WHERE id = p_expense_id AND (user_id = v_caller OR user_id = public.get_owner_id(v_caller));
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'المصروف غير موجود أو لا تملك صلاحية الوصول إليه'); END IF;
  IF COALESCE(v_expense.is_reversed, false) THEN RETURN jsonb_build_object('success', false, 'message', 'تم التراجع عن هذا المصروف مسبقاً'); END IF;
  UPDATE public.expenses SET is_reversed = TRUE, reversed_at = NOW(), reversed_by = v_caller, reversed_reason = p_reason WHERE id = p_expense_id;
  RETURN jsonb_build_object('success', true, 'amount', v_expense.amount, 'expense_type', v_expense.expense_type, 'message', 'تم التراجع عن المصروف بنجاح');
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_store_appearance(_font_family text, _theme text DEFAULT NULL::text, _appearance jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _uid uuid := auth.uid(); _owner uuid;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN RAISE EXCEPTION 'لم يتم العثور على مالك المتجر'; END IF;
  UPDATE public.stores SET
    font_family = COALESCE(NULLIF(trim(_font_family), ''), font_family, 'Cairo'),
    theme = COALESCE(_theme, theme),
    appearance_settings = COALESCE(_appearance, appearance_settings),
    updated_at = now()
  WHERE user_id = _owner;
  RETURN jsonb_build_object('success', true, 'font_family', _font_family, 'theme', _theme);
END;
$function$;

CREATE OR REPLACE FUNCTION public.send_support_message(_message text, _conversation_id uuid DEFAULT NULL::uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _uid uuid := auth.uid(); _owner uuid; _conv_id uuid := _conversation_id; _is_boss_user boolean; _user_email text; _user_phone text; _user_name text; _store_name text; _msg_id uuid; _role text;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF trim(COALESCE(_message, '')) = '' THEN RAISE EXCEPTION 'لا يمكن إرسال رسالة فارغة'; END IF;
  _is_boss_user := public.is_boss(_uid);
  _owner := public.get_owner_id(_uid);
  IF _is_boss_user AND _conv_id IS NOT NULL THEN
    _role := 'boss';
  ELSE
    _role := 'user';
    IF _conv_id IS NULL THEN
      SELECT id INTO _conv_id FROM public.support_conversations WHERE user_id = _uid ORDER BY created_at DESC LIMIT 1;
      IF _conv_id IS NULL THEN
        SELECT email INTO _user_email FROM auth.users WHERE id = _uid;
        SELECT full_name, phone INTO _user_name, _user_phone FROM public.profiles WHERE user_id = _uid;
        SELECT name INTO _store_name FROM public.stores WHERE user_id = COALESCE(_owner, _uid) LIMIT 1;
        INSERT INTO public.support_conversations (user_id, owner_id, user_name, user_email, user_phone, store_name)
        VALUES (_uid, _owner, _user_name, _user_email, _user_phone, _store_name)
        RETURNING id INTO _conv_id;
      END IF;
    END IF;
  END IF;
  INSERT INTO public.support_messages (conversation_id, sender_id, sender_role, message)
  VALUES (_conv_id, _uid, _role, trim(_message)) RETURNING id INTO _msg_id;
  UPDATE public.support_conversations SET last_message_at = now(), updated_at = now(), status = 'open' WHERE id = _conv_id;
  RETURN jsonb_build_object('success', true, 'message_id', _msg_id, 'conversation_id', _conv_id, 'role', _role, 'created_at', now());
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_category_atomic(_category_id uuid, _new_name text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _owner uuid := public.get_owner_id(auth.uid()); _old_name text; _partner record; _updated_shares jsonb; _item jsonb;
BEGIN
  IF auth.uid() IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  _new_name := trim(_new_name);
  IF _new_name IS NULL OR length(_new_name) = 0 THEN RAISE EXCEPTION 'اسم التصنيف لا يمكن أن يكون فارغاً'; END IF;
  SELECT name INTO _old_name FROM public.categories WHERE id = _category_id AND user_id = _owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'التصنيف غير موجود'; END IF;
  IF _old_name = _new_name THEN RETURN jsonb_build_object('success', true, 'updated', false); END IF;
  UPDATE public.categories SET name = _new_name, updated_at = now() WHERE id = _category_id;
  UPDATE public.products SET category = _new_name, updated_at = now() WHERE user_id = _owner AND category = _old_name;
  FOR _partner IN SELECT id, category_shares FROM public.partners WHERE user_id = _owner AND category_shares IS NOT NULL FOR UPDATE LOOP
    _updated_shares := '[]'::jsonb;
    FOR _item IN SELECT * FROM jsonb_array_elements(_partner.category_shares) LOOP
      IF (_item->>'categoryName') = _old_name THEN
        _updated_shares := _updated_shares || jsonb_set(_item, '{categoryName}', to_jsonb(_new_name));
      ELSE
        _updated_shares := _updated_shares || _item;
      END IF;
    END LOOP;
    UPDATE public.partners SET category_shares = _updated_shares, updated_at = now() WHERE id = _partner.id;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'old_name', _old_name, 'new_name', _new_name);
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_activation_code_strength() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF NEW.code IS NULL OR length(regexp_replace(NEW.code, '[^A-Za-z0-9]', '', 'g')) < 12 THEN
    RAISE EXCEPTION 'Activation code must contain at least 12 letters or digits';
  END IF;
  RETURN NEW;
END $function$;
