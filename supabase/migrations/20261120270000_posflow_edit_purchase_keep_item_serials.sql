-- edit_purchase_invoice_atomic: the new purchase_invoice_items rows must keep the per-line serials list
-- (otherwise editing a revised invoice a second time shows no serials box).
DO $m$
DECLARE
  _def text;
  _old text := 'cost_price_before, sale_price, total_cost)
      VALUES (_new_invoice_id, _prod_id, _prod_name, _prod_barcode, _prod_cat, _prod_qty, _prod_cost, _cur_cost, (_line->>''sale_price'')::numeric, _prod_qty*_prod_cost)';
  _new text := 'cost_price_before, sale_price, total_cost, serials)
      VALUES (_new_invoice_id, _prod_id, _prod_name, _prod_barcode, _prod_cat, _prod_qty, _prod_cost, _cur_cost, (_line->>''sale_price'')::numeric, _prod_qty*_prod_cost, CASE WHEN jsonb_typeof(_line->''serials'') = ''array'' THEN ARRAY(SELECT trim(x) FROM jsonb_array_elements_text(_line->''serials'') x WHERE trim(x) <> '''') ELSE NULL END)';
BEGIN
  SELECT replace(pg_get_functiondef(p.oid), E'\r', '') INTO _def
    FROM pg_proc p WHERE p.proname = 'edit_purchase_invoice_atomic' AND p.pronamespace = 'public'::regnamespace;
  IF _def IS NULL THEN RAISE EXCEPTION 'edit_purchase_invoice_atomic not found'; END IF;
  IF position('total_cost, serials)' in _def) > 0 THEN
    RAISE NOTICE 'already applied';
  ELSIF position(_old in _def) > 0 THEN
    EXECUTE replace(_def, _old, _new);
  ELSE
    RAISE EXCEPTION 'anchor not found';
  END IF;
END $m$;
NOTIFY pgrst, 'reload schema';
