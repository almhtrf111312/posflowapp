-- Direct-write migration, step 2 (W-2, owner-approved 2026-11-26): opening a shift goes through this RPC (online and from the
-- offline queue) instead of a direct upsert into cash_shifts.
-- Same behaviour as before: the client id is the shift id; one open shift per cashier is still enforced by the unique index
-- uq_cash_shifts_one_open_per_cashier, so a second open is refused with SQLSTATE 23505 exactly as the app already expects.
-- One deliberate difference: a replay of an id that already exists returns the stored shift and changes nothing (the old
-- upsert rewrote opening/expected_balance on a retry, resetting the cache of an active shift).
-- Added checks: the cashier belongs to the caller's store, opening balance >= 0, opened_at not in the future (the offline
-- open time is kept: a shift opened offline keeps the moment it was opened).
-- The direct insert stays open (guarded by S-2) for APKs already installed; it is closed together with W-1.

CREATE OR REPLACE FUNCTION public.open_cash_shift_atomic(
  _id uuid, _cashier_id uuid DEFAULT NULL, _cashier_name text DEFAULT NULL, _opening_balance numeric DEFAULT 0,
  _opening_by_currency jsonb DEFAULT NULL, _opened_at timestamptz DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _owner uuid := public.get_owner_id(auth.uid());
  _cashier uuid := COALESCE(_cashier_id, auth.uid());
  _opening numeric := round(COALESCE(_opening_balance, 0)::numeric, 8);
  _at timestamptz := LEAST(COALESCE(_opened_at, now()), now());
  _row public.cash_shifts%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF _id IS NULL THEN RAISE EXCEPTION 'معرّف الوردية مطلوب'; END IF;
  SELECT * INTO _row FROM public.cash_shifts WHERE id = _id;
  IF FOUND THEN
    IF _row.user_id <> _owner THEN RAISE EXCEPTION 'غير مصرح'; END IF;
    RETURN jsonb_build_object('id', _row.id, 'status', 'replayed', 'closed', _row.closed_at IS NOT NULL);
  END IF;
  IF public.get_owner_id(_cashier) IS DISTINCT FROM _owner THEN
    RAISE EXCEPTION 'الكاشير لا يتبع لهذا المتجر';
  END IF;
  IF _opening < 0 THEN RAISE EXCEPTION 'رصيد الافتتاح لا يكون سالباً'; END IF;
  INSERT INTO public.cash_shifts(id, user_id, cashier_id, cashier_name, opened_at, opening_balance, expected_balance,
                                 reconciliation_status, opening_by_currency)
  VALUES (_id, _owner, _cashier, NULLIF(_cashier_name, ''), _at, _opening, _opening, 'open',
          CASE WHEN _opening_by_currency IS NOT NULL AND jsonb_typeof(_opening_by_currency) = 'object' THEN _opening_by_currency END);
  RETURN jsonb_build_object('id', _id, 'status', 'opened');
END $function$;
REVOKE EXECUTE ON FUNCTION public.open_cash_shift_atomic(uuid, uuid, text, numeric, jsonb, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_cash_shift_atomic(uuid, uuid, text, numeric, jsonb, timestamptz) TO authenticated, service_role;
