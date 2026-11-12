-- guard_debt_writeoff_status()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.guard_debt_writeoff_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'written_off'
     AND OLD.status IS DISTINCT FROM 'written_off'
     AND auth.uid() IS NOT NULL
     AND COALESCE(current_setting('app.debt_writeoff_internal', true), '') <> '1' THEN
    RAISE EXCEPTION 'شطب الدين يتم من شاشة الديون بصلاحية مالك المتجر فقط' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$
;
