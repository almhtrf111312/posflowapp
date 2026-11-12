-- can_refund_invoices(_user_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}

CREATE OR REPLACE FUNCTION public.can_refund_invoices(_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    _user_id IS NOT NULL
    AND (
      public.get_owner_id(_user_id) = _user_id      -- مالك المتجر
      OR public.is_boss(_user_id)
      OR EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = _user_id AND ur.can_refund = true
      )
    );
$function$
;
