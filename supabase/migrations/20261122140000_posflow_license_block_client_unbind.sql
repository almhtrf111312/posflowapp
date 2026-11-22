-- =============================================================================
-- Migration: 20261122140000_posflow_license_block_client_unbind.sql
-- Already applied to the live project as posflow_license_block_client_unbind_and_device_fields.
-- Rollback: re-apply the previous body of prevent_license_self_upgrade from
--   supabase/migrations/20261110080000_license_privilege_escalation_hardening.sql
--
-- A regular user could unbind the device with a direct REST update (device_id = NULL),
-- bypassing the once-per-day reset in request_device_reset_secure. Verified in a rolled-back
-- test before the fix (bound device unbound successfully).
-- Now clients may:
--   - bind the first time (NULL -> value), and
--   - NOT unbind (value -> NULL), and NOT change the device-binding/reset/lease bookkeeping.
-- Server RPCs (service role, auth.uid() NULL) and the boss are unaffected.
-- Verified after applying: client unbind blocked, client first bind allowed, server unbind works.
-- =============================================================================

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
  -- new: device binding and reset/lease bookkeeping can only change through the server RPCs
  OR NEW.bound_device_id       IS DISTINCT FROM OLD.bound_device_id
  OR NEW.last_reset_at         IS DISTINCT FROM OLD.last_reset_at
  OR NEW.last_device_reset_at  IS DISTINCT FROM OLD.last_device_reset_at
  OR NEW.last_lease_issued_at  IS DISTINCT FROM OLD.last_lease_issued_at
  OR NEW.license_key           IS DISTINCT FROM OLD.license_key
  -- new: a client may bind a device once (NULL -> value) but may not unbind it (value -> NULL)
  OR (NEW.device_id IS NULL AND OLD.device_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'انتهاك أمني: غير مصرح لك بتعديل بيانات أو حدود ترخيص النظام';
  END IF;

  RETURN NEW;
END;
$function$;

NOTIFY pgrst, 'reload schema';
