-- =============================================================================
-- Migration: 20261122150000_posflow_security_and_tenant_hardening.sql
-- Rollback:  supabase/live-snapshots/rollbacks/ROLLBACK_security_and_tenant_hardening.sql
--
-- 1) prevent_license_self_upgrade(): block client value -> value2 device_id swaps
--    (except one-time legacy non-CAP -> CAP-* Android OS ID migration).
-- 2) request_device_reset_secure(_license_key, _user_email): enforce is_revoked
--    check, 1-day cooldown, device_reset_count increment, and revoke_user_sessions.
-- 3) prevent_customer_deletion_with_dues(): scope debts & invoices checks to
--    user_id = OLD.user_id to prevent cross-store customer-name collisions.
-- 4) Revoke unnecessary PUBLIC/anon EXECUTE on 4 auth-gated SECURITY DEFINER RPCs.
-- =============================================================================

-- 1) Tighten prevent_license_self_upgrade() -----------------------------------
CREATE OR REPLACE FUNCTION public.prevent_license_self_upgrade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- يُسمح فقط للسيرفر الموثوق (Service Role) أو للمدير العام (Boss) بتعديل بيانات الترخيص
  IF auth.uid() IS NULL OR current_setting('role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF public.is_boss(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF NEW.expires_at           IS DISTINCT FROM OLD.expires_at
  OR NEW.is_revoked           IS DISTINCT FROM OLD.is_revoked
  OR NEW.license_tier         IS DISTINCT FROM OLD.license_tier
  OR NEW.max_cashiers         IS DISTINCT FROM OLD.max_cashiers
  OR NEW.allow_multi_device   IS DISTINCT FROM OLD.allow_multi_device
  OR NEW.is_trial             IS DISTINCT FROM OLD.is_trial
  OR NEW.activation_code_id   IS DISTINCT FROM OLD.activation_code_id
  OR NEW.user_id              IS DISTINCT FROM OLD.user_id
  OR NEW.max_offline_days     IS DISTINCT FROM OLD.max_offline_days
  OR NEW.max_offline_invoices IS DISTINCT FROM OLD.max_offline_invoices
  OR NEW.device_reset_count   IS DISTINCT FROM OLD.device_reset_count
  OR NEW.offline_lease_secret IS DISTINCT FROM OLD.offline_lease_secret
  OR NEW.activated_at         IS DISTINCT FROM OLD.activated_at
  OR NEW.current_cashiers     IS DISTINCT FROM OLD.current_cashiers
  OR NEW.max_products         IS DISTINCT FROM OLD.max_products
  OR NEW.total_days           IS DISTINCT FROM OLD.total_days
  OR NEW.plan_id              IS DISTINCT FROM OLD.plan_id
  OR NEW.plan_name            IS DISTINCT FROM OLD.plan_name
  OR NEW.plan_audience        IS DISTINCT FROM OLD.plan_audience
  OR NEW.revoked_at           IS DISTINCT FROM OLD.revoked_at
  OR NEW.revoked_reason       IS DISTINCT FROM OLD.revoked_reason
  OR NEW.bound_device_id      IS DISTINCT FROM OLD.bound_device_id
  OR NEW.last_reset_at        IS DISTINCT FROM OLD.last_reset_at
  OR NEW.last_device_reset_at IS DISTINCT FROM OLD.last_device_reset_at
  OR NEW.last_lease_issued_at IS DISTINCT FROM OLD.last_lease_issued_at
  OR NEW.license_key          IS DISTINCT FROM OLD.license_key
  -- منع فك الربط (value -> NULL) أو التبديل المباشر (value -> value2) من العميل،
  -- مع السماح فقط بالربط الأول (NULL -> value) أو الترحيل لمرة واحدة من معرّف قديم غير CAP إلى معرّف أندرويد الثابت CAP-*
  OR (
    OLD.device_id IS NOT NULL
    AND NEW.device_id IS DISTINCT FROM OLD.device_id
    AND NOT (
      NEW.device_id IS NOT NULL
      AND OLD.device_id NOT LIKE 'CAP-%'
      AND NEW.device_id LIKE 'CAP-%'
    )
  )
  THEN
    RAISE EXCEPTION 'انتهاك أمني: غير مصرح لك بتعديل بيانات أو حدود ترخيص النظام';
  END IF;

  RETURN NEW;
END;
$function$;

-- 2) Harden request_device_reset_secure(_license_key, _user_email) ------------
CREATE OR REPLACE FUNCTION public.request_device_reset_secure(_license_key text, _user_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _clean_key text := upper(replace(trim(_license_key), ' ', ''));
  _clean_email text := lower(trim(_user_email));
  _lic record;
  _since timestamptz;
  _available_at timestamptz;
  _left interval;
BEGIN
  IF _clean_key IS NULL OR _clean_key = '' OR _clean_email IS NULL OR _clean_email = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'يرجى تزويد مفتاح الترخيص والبريد الإلكتروني بشكل صحيح.'
    );
  END IF;

  SELECT l.id, l.user_id, l.activation_code_id, l.is_revoked, l.device_id,
         l.allow_multi_device, l.device_bound_at, l.last_device_reset_at,
         l.activated_at, l.created_at
    INTO _lic
    FROM public.app_licenses l
    LEFT JOIN auth.users u ON u.id = l.user_id
    LEFT JOIN public.activation_codes ac ON ac.id = l.activation_code_id
   WHERE (
     upper(replace(COALESCE(l.license_key, ''), ' ', '')) = _clean_key
     OR (ac.code IS NOT NULL AND upper(replace(ac.code, ' ', '')) = _clean_key)
   )
   AND (
     (u.email IS NOT NULL AND lower(trim(u.email)) = _clean_email)
     OR (ac.assigned_email IS NOT NULL AND lower(trim(ac.assigned_email)) = _clean_email)
   )
   ORDER BY l.created_at DESC
   LIMIT 1
   FOR UPDATE OF l;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'بيانات الترخيص أو البريد الإلكتروني غير صحيحة.'
    );
  END IF;

  IF COALESCE(_lic.is_revoked, false) THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'تم إلغاء ترخيص هذا الحساب، يرجى التواصل مع الإدارة.'
    );
  END IF;

  IF _lic.device_id IS NULL OR COALESCE(_lic.allow_multi_device, false) THEN
    PERFORM public.revoke_user_sessions(_lic.user_id);
    RETURN jsonb_build_object(
      'success', true,
      'already_free', true,
      'message', 'الحساب غير مرتبط بجهاز حالياً. يمكنك تسجيل الدخول مباشرة.'
    );
  END IF;

  _since := COALESCE(_lic.device_bound_at, _lic.last_device_reset_at, _lic.activated_at, _lic.created_at, now());
  _available_at := _since + interval '1 day';

  IF now() < _available_at THEN
    _left := _available_at - now();
    RETURN jsonb_build_object(
      'success', false,
      'cooldown', true,
      'available_at', _available_at,
      'message', format(
        'لا يمكن نقل الحساب ذاتياً قبل مرور يوم على ربط الجهاز الحالي (متبقٍ %s يوم و%s ساعة). لنقل الحساب الآن تواصل مع الدعم عبر بوت تيليجرام.',
        extract(day FROM _left)::int,
        extract(hour FROM _left)::int
      )
    );
  END IF;

  UPDATE public.app_licenses
     SET device_id = NULL,
         bound_device_id = NULL,
         last_reset_at = now(),
         last_device_reset_at = now(),
         device_reset_count = COALESCE(device_reset_count, 0) + 1,
         updated_at = now()
   WHERE id = _lic.id;

  IF _lic.activation_code_id IS NOT NULL THEN
    UPDATE public.activation_codes
       SET locked_device_id = NULL
     WHERE id = _lic.activation_code_id;
  END IF;

  PERFORM public.revoke_user_sessions(_lic.user_id);

  RETURN jsonb_build_object(
    'success', true,
    'message', 'تم فك ربط الجهاز بنجاح. يمكنك الآن تسجيل الدخول من جهازك الجديد.'
  );
END;
$function$;

-- 3) Fix cross-tenant customer deletion guard ---------------------------------
CREATE OR REPLACE FUNCTION public.prevent_customer_deletion_with_dues()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF COALESCE(current_setting('app.purge_context', true), '') = 'owner_purge' AND public.is_boss(auth.uid()) THEN
    RETURN OLD;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.debts
    WHERE user_id = OLD.user_id
      AND customer_name = OLD.name
      AND remaining_debt > 0.001
  ) THEN
    RAISE EXCEPTION 'لا يمكن حذف العميل: توجد ديون وذمم مالية قائمة ومستحقة';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.invoices
    WHERE user_id = OLD.user_id
      AND customer_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'لا يمكن حذف العميل: توجد فواتير مبيعات سابقة مسجلة باسمه';
  END IF;
  RETURN OLD;
END;
$function$;

-- 4) Revoke unnecessary PUBLIC/anon EXECUTE on 4 auth-gated RPCs --------------
REVOKE EXECUTE ON FUNCTION public.reset_device_for_user(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.reset_device_for_user(text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.lookup_serial(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.lookup_serial(text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.assign_store_and_profile_phone(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.assign_store_and_profile_phone(text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.issue_offline_lease(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.issue_offline_lease(text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
