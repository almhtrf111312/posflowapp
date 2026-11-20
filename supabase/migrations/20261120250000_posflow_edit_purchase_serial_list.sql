-- edit_purchase_invoice_atomic: a line may carry "serials"; removed in-stock serials are marked returned_to_supplier (audit kept), new ones are registered.
DO $m$
DECLARE _def text; _new text;
BEGIN
  SELECT replace(pg_get_functiondef(p.oid),E'\r','') INTO _def FROM pg_proc p WHERE p.proname='edit_purchase_invoice_atomic' AND p.pronamespace='public'::regnamespace;
  IF position('_edit_serial_list' in _def) > 0 THEN RETURN; END IF;
  _new := replace(_def, '      _items_count := _items_count + 1; _total_qty := _total_qty + _prod_qty;',
E'      IF jsonb_typeof(_line->''serials'') = ''array'' THEN -- _edit_serial_list\n      DECLARE _ns text[]; _missing text[];\n      BEGIN\n        SELECT COALESCE(array_agg(DISTINCT lower(trim(x))),''{}''::text[]) INTO _ns FROM jsonb_array_elements_text(_line->''serials'') x WHERE trim(x) <> '''';\n        INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) SELECT _owner, ps.id, ''returned_to_supplier'', ''edit:''||_orig_inv.invoice_number, _caller FROM public.product_serials ps WHERE ps.user_id=_owner AND ps.product_id=_prod_id AND ps.purchase_invoice_id=_new_invoice_id AND ps.status=''in_stock'' AND lower(ps.serial) <> ALL(_ns);\n        UPDATE public.product_serials SET status=''returned_to_supplier'', updated_at=now() WHERE user_id=_owner AND product_id=_prod_id AND purchase_invoice_id=_new_invoice_id AND status=''in_stock'' AND lower(serial) <> ALL(_ns);\n        SELECT COALESCE(array_agg(s),''{}''::text[]) INTO _missing FROM unnest(_ns) s WHERE NOT EXISTS (SELECT 1 FROM public.product_serials ps WHERE ps.user_id=_owner AND ps.product_id=_prod_id AND lower(ps.serial)=s);\n        IF cardinality(_missing) > 0 THEN PERFORM public._register_serials(_owner,_prod_id,_missing,_prod_cost,_new_invoice_id,cardinality(_missing)); END IF;\n      END;\n      END IF;\n      _items_count := _items_count + 1; _total_qty := _total_qty + _prod_qty;');
  IF _new = _def THEN RAISE EXCEPTION 'patch failed'; END IF;
  EXECUTE _new;
END $m$;
