-- prevent_license_self_upgrade()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,service_role=X/postgres}

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

  -- منع المستخدم العادي من تعديل أي حقل من حقول الباقة والترخيص:
  -- يُسمح له فقط بتحديث معرف جهازه (device_id) في الحالات المسموح بها نظامياً
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
  THEN
    RAISE EXCEPTION 'انتهاك أمني: غير مصرح لك بتعديل بيانات أو حدود ترخيص النظام';
  END IF;

  RETURN NEW;
END;
$function$
;
