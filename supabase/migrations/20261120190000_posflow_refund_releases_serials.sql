-- Partial/full customer refund returns the sold serials (LIFO) of the refunded tracked products to stock.
DO $m$
DECLARE _def text; _new text;
BEGIN
  SELECT replace(pg_get_functiondef(p.oid),E'\r','') INTO _def FROM pg_proc p WHERE p.proname='refund_invoice_partial_atomic' AND p.pronamespace='public'::regnamespace;
  IF position('_refund_serial_release' in _def) > 0 THEN RETURN; END IF;
  _new := replace(_def,
    E'  IF _inv.customer_id IS NOT NULL THEN\n    UPDATE public.customers c SET total_purchases',
    E'  DECLARE _ri record; _sid uuid; -- _refund_serial_release\n  BEGIN\n    FOR _ri IN SELECT (e->>''product_id'')::uuid AS pid, floor(COALESCE((e->>''quantity'')::numeric,0))::int AS q FROM jsonb_array_elements(_items) e WHERE NULLIF(e->>''product_id'','''') IS NOT NULL LOOP\n      IF _ri.q > 0 AND EXISTS (SELECT 1 FROM public.products WHERE id=_ri.pid AND track_serials) THEN\n        FOR _sid IN SELECT id FROM public.product_serials WHERE user_id=_owner AND sold_invoice_id=_inv.id AND product_id=_ri.pid AND status=''sold'' ORDER BY sold_at DESC, id LIMIT _ri.q LOOP\n          UPDATE public.product_serials SET status=''in_stock'', sold_invoice_id=NULL, sold_invoice_number=NULL, sold_at=NULL, customer_name=NULL, warranty_until=NULL, updated_at=now() WHERE id=_sid;\n          INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) VALUES (_owner,_sid,''customer_return'',_inv.invoice_number,auth.uid());\n        END LOOP;\n      END IF;\n    END LOOP;\n  END;\n  IF _inv.customer_id IS NOT NULL THEN\n    UPDATE public.customers c SET total_purchases');
  IF _new = _def THEN RAISE EXCEPTION 'patch refund serials failed'; END IF;
  EXECUTE _new;
END $m$;
