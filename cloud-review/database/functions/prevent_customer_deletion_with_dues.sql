-- prevent_customer_deletion_with_dues()
-- SECURITY DEFINER: False
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.prevent_customer_deletion_with_dues()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.debts WHERE customer_name = OLD.name AND remaining_debt > 0.001) THEN
    RAISE EXCEPTION 'لا يمكن حذف العميل: توجد ديون وذمم مالية قائمة ومستحقة';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE customer_id = OLD.id) THEN
    RAISE EXCEPTION 'لا يمكن حذف العميل: توجد فواتير مبيعات سابقة مسجلة باسمه';
  END IF;
  RETURN OLD;
END;
$function$
;
