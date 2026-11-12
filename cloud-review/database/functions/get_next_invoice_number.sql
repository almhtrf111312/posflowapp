-- get_next_invoice_number(_user_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.get_next_invoice_number(_user_id uuid DEFAULT NULL::uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _owner uuid;
  _next bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  _owner := public.get_owner_id(auth.uid());
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'No owner context';
  END IF;

  IF _user_id IS NOT NULL AND _user_id <> _owner THEN
    IF NOT public.is_boss(auth.uid()) THEN
      RAISE EXCEPTION 'Access denied';
    END IF;
    _owner := _user_id;
  END IF;

  INSERT INTO public.invoice_sequences (user_id, last_number)
  VALUES (_owner, 1)
  ON CONFLICT (user_id) DO UPDATE
    SET last_number = public.invoice_sequences.last_number + 1,
        updated_at = now()
  RETURNING last_number INTO _next;

  RETURN _next;
END;
$function$
;
