-- set_invoice_paid_at_sale()
-- SECURITY DEFINER: False
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.set_invoice_paid_at_sale()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.paid_at_sale IS NULL THEN
    NEW.paid_at_sale := CASE
      WHEN NEW.payment_type = 'debt'
        THEN LEAST(GREATEST(COALESCE(NEW.debt_paid, 0), 0), COALESCE(NEW.total, 0))
      ELSE COALESCE(NEW.total, 0)
    END;
  END IF;
  RETURN NEW;
END;
$function$
;
