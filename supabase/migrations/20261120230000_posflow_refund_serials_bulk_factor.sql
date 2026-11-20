DO $m$
DECLARE _def text; _new text;
BEGIN
  SELECT replace(pg_get_functiondef(p.oid),E'\r','') INTO _def FROM pg_proc p WHERE p.proname='refund_invoice_partial_atomic' AND p.pronamespace='public'::regnamespace;
  IF position('ii.conversion_factor' in _def) > 0 THEN RETURN; END IF;
  _new := replace(_def, 'floor(COALESCE((e->>''quantity'')::numeric,0))::int AS q',
    'floor(COALESCE((e->>''quantity'')::numeric,0) * COALESCE((SELECT CASE WHEN ii.unit=''bulk'' THEN GREATEST(COALESCE(ii.conversion_factor,1),1) ELSE 1 END FROM public.invoice_items ii WHERE ii.invoice_id=_inv.id AND ii.product_id=(e->>''product_id'')::uuid LIMIT 1),1))::int AS q');
  IF _new = _def THEN RAISE EXCEPTION 'patch failed'; END IF;
  EXECUTE _new;
END $m$;
