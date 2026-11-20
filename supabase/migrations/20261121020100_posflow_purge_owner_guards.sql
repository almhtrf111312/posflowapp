-- Owner purge must pass three guard triggers that otherwise block deleting a whole account:
--   invoices (use existing app.invoice_delete_context), customers (dues/invoices), partner_ledger_entries (immutable).
-- The bypass only works inside purge_owner_data (transaction-local setting) and for a Boss caller.

CREATE OR REPLACE FUNCTION public.prevent_customer_deletion_with_dues()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF COALESCE(current_setting('app.purge_context', true), '') = 'owner_purge' AND public.is_boss(auth.uid()) THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM public.debts WHERE customer_name = OLD.name AND remaining_debt > 0.001) THEN
    RAISE EXCEPTION 'لا يمكن حذف العميل: توجد ديون وذمم مالية قائمة ومستحقة';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE customer_id = OLD.id) THEN
    RAISE EXCEPTION 'لا يمكن حذف العميل: توجد فواتير مبيعات سابقة مسجلة باسمه';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public._partner_ledger_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE'
     AND COALESCE(current_setting('app.purge_context', true), '') = 'owner_purge'
     AND public.is_boss(auth.uid()) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'سجل الشركاء غير قابل للتعديل أو الحذف';
END $function$;
