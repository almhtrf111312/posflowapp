DO $m$
DECLARE _def text; _new text;
BEGIN
  SELECT replace(pg_get_functiondef(p.oid),E'\r','') INTO _def FROM pg_proc p WHERE p.proname='record_stock_damage_atomic' AND p.pronamespace='public'::regnamespace;
  IF position('^[0-9a-f]{8}' in _def) > 0 THEN RETURN; END IF;
  _new := replace(_def, 'COALESCE(_source,''manual''), _source_ref)', 'COALESCE(_source,''manual''), CASE WHEN _source_ref ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'' THEN _source_ref::uuid ELSE NULL END)');
  IF _new = _def THEN RAISE EXCEPTION 'patch failed'; END IF;
  EXECUTE _new;
END $m$;
