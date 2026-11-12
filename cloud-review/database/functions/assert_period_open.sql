-- assert_period_open(_owner uuid, _date date, _what text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}

CREATE OR REPLACE FUNCTION public.assert_period_open(_owner uuid, _date date, _what text DEFAULT 'العملية'::text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
BEGIN
  IF _owner IS NULL OR _date IS NULL THEN
    RETURN;
  END IF;
  SELECT c.period_start, c.period_end INTO r
    FROM public.accounting_period_closures c
   WHERE c.user_id = _owner
     AND _date BETWEEN c.period_start AND c.period_end
   ORDER BY c.period_end DESC
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '% مرفوضة: التاريخ % ضمن فترة محاسبية مغلقة (من % إلى %)', _what, _date, r.period_start, r.period_end;
  END IF;
END;
$function$
;
