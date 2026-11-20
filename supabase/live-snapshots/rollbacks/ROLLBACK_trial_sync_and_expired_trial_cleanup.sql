-- Rollback for 20261121020000_posflow_trial_sync_and_expired_trial_cleanup.sql
-- (restores the previous has_paid_write_access / delete_owner_cascade; data deleted by purge cannot be restored)

CREATE OR REPLACE FUNCTION public.has_paid_write_access(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    public.is_boss(_user_id)
    OR EXISTS (
      SELECT 1
      FROM public.app_licenses al
      WHERE al.user_id = public.get_owner_id(_user_id)
        AND COALESCE(al.is_revoked, false) = false
        AND COALESCE(al.is_trial, false) = false
        AND al.expires_at > now()
    );
$function$;

CREATE OR REPLACE FUNCTION public.delete_owner_cascade(_owner_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT is_boss(auth.uid()) THEN
    RETURN false;
  END IF;
  DELETE FROM public.user_roles WHERE owner_id = _owner_id;
  DELETE FROM public.app_licenses WHERE user_id = _owner_id;
  DELETE FROM public.products WHERE user_id = _owner_id;
  DELETE FROM public.customers WHERE user_id = _owner_id;
  DELETE FROM public.invoices WHERE user_id = _owner_id;
  DELETE FROM public.debts WHERE user_id = _owner_id;
  DELETE FROM public.expenses WHERE user_id = _owner_id;
  DELETE FROM public.partners WHERE user_id = _owner_id;
  DELETE FROM public.categories WHERE user_id = _owner_id;
  DELETE FROM public.stores WHERE user_id = _owner_id;
  DELETE FROM public.maintenance_services WHERE user_id = _owner_id;
  DELETE FROM public.recurring_expenses WHERE user_id = _owner_id;
  DELETE FROM public.profiles WHERE user_id = _owner_id;
  DELETE FROM public.user_roles WHERE user_id = _owner_id;
  RETURN true;
END;
$function$;

DROP FUNCTION IF EXISTS public.purge_owner_data(uuid);
DROP FUNCTION IF EXISTS public.boss_expired_trials(integer);
NOTIFY pgrst, 'reload schema';
