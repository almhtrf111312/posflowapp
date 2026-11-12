-- guard_refunded_invoice_status()
-- SECURITY DEFINER: False
-- EXECUTE grants (proacl): {postgres=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.guard_refunded_invoice_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (NEW.status = 'refunded' OR OLD.status = 'refunded')
     AND COALESCE(current_setting('app.refund_context', true), '') <> 'allowed'
  THEN
    RAISE EXCEPTION 'Refund status can only be changed by the protected refund operation';
  END IF;
  RETURN NEW;
END;
$function$
;
