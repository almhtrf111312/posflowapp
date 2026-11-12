-- guard_written_off_debt()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.guard_written_off_debt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.total_paid IS DISTINCT FROM OLD.total_paid
          OR NEW.remaining_debt IS DISTINCT FROM OLD.remaining_debt
          OR NEW.total_debt IS DISTINCT FROM OLD.total_debt) THEN
    RAISE EXCEPTION 'هذا الدين مشطوب ولا يقبل دفعات أو تعديلات' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$
;
