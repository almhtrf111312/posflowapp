DROP TRIGGER IF EXISTS trg_release_serials_on_refund ON public.invoices;
DROP FUNCTION IF EXISTS public._release_serials_on_invoice_refund();
DROP FUNCTION IF EXISTS public.release_serials_atomic(text,text[]);
DROP FUNCTION IF EXISTS public.lookup_serial(text);
DROP FUNCTION IF EXISTS public.register_serials_atomic(uuid,text[]);
-- finalize_purchase_invoice_atomic / process_pos_sale_atomic: re-apply previous bodies (serial blocks must be removed) BEFORE dropping _register_serials.
DROP FUNCTION IF EXISTS public._register_serials(uuid,uuid,text[],numeric,uuid,numeric);
-- Tables hold history; drop only if never used:
-- DROP TABLE public.product_serial_events; DROP TABLE public.product_serials;
-- ALTER TABLE public.purchase_invoice_items DROP COLUMN serials; ALTER TABLE public.products DROP COLUMN track_serials;
