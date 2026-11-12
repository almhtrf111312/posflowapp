-- trg_recalc_pos_invoice_profit()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.trg_recalc_pos_invoice_profit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.invoices i WHERE i.id=NEW.invoice_id AND i.operation_id IS NOT NULL
             AND COALESCE(i.status,'') <> 'refunded') THEN
    PERFORM public.recalc_pos_invoice_profit(NEW.invoice_id);
  END IF;
  RETURN NULL;
END $function$
;
