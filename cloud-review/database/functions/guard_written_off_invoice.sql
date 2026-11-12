-- guard_written_off_invoice()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.guard_written_off_invoice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.total IS DISTINCT FROM OLD.total
          OR NEW.profit IS DISTINCT FROM OLD.profit
          OR NEW.debt_paid IS DISTINCT FROM OLD.debt_paid
          OR NEW.debt_remaining IS DISTINCT FROM OLD.debt_remaining) THEN
    RAISE EXCEPTION 'هذه الفاتورة دينها مشطوب ولا يمكن استردادها أو تعديل مبالغها' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$
;
