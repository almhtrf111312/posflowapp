-- normalize_debt_row()
-- SECURITY DEFINER: False
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.normalize_debt_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.total_debt := round(coalesce(NEW.total_debt, 0)::numeric, 8);
  NEW.total_paid := round(greatest(coalesce(NEW.total_paid, 0), 0)::numeric, 8);
  NEW.remaining_debt := round(greatest(NEW.total_debt - NEW.total_paid, 0)::numeric, 8);
  -- الحالات النهائية (مشطوب / ملغى): لا مستحق متبقٍ ولا تُعاد الحالة إلى مفتوح
  IF NEW.status IN ('written_off', 'cancelled') THEN
    NEW.remaining_debt := 0;
    RETURN NEW;
  END IF;
  IF NEW.remaining_debt <= 0.00000001 THEN
    NEW.status := 'fully_paid';
    NEW.remaining_debt := 0;
  ELSIF NEW.total_paid > 0 THEN
    NEW.status := 'partially_paid';
  ELSIF NEW.status IS NULL OR NEW.status IN ('fully_paid','partially_paid') THEN
    NEW.status := 'due';
  END IF;
  RETURN NEW;
END $function$
;
