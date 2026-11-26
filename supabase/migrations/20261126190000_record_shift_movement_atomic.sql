-- Direct-write migration, step 1 (owner-approved 2026-11-26): drawer movements that the app used to insert directly into
-- shift_transactions (cash sale without a server-posted movement, digital sale, cash refund without a server movement,
-- deposits) now go through this RPC, online and from the offline queue.
-- Behaviour is the SAME as the old client path (no financial change): one row per client id (a replay returns the stored
-- row), the (shift, type, reference) unique rule handled exactly like writeShiftTransactionRow (a sale/debt payment with
-- the same reference is the same movement; other types keep the movement under reference#<id prefix>), and the shift's
-- expected_balance is NOT touched (it is a cache; the close computes from movements, F-18 / KD-06).
-- Added checks: caller's store, open shift (a closed shift -> (F-20), parked for manual reconciliation), amount > 0, and
-- only the types the app posts. Server-owned types (expense, debt_payment, write-off, supplier, store credit, fx, surplus,
-- shortage...) are refused here: their RPCs write them.
-- The direct insert path stays open (guarded by S-2) for APKs already installed; it is closed in a later release.

CREATE OR REPLACE FUNCTION public.record_shift_movement_atomic(
  _id uuid, _shift_id uuid, _type text, _amount numeric, _reference_id text DEFAULT NULL, _notes text DEFAULT NULL,
  _currency text DEFAULT NULL, _currency_amount numeric DEFAULT NULL, _exchange_rate numeric DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _owner uuid := public.get_owner_id(auth.uid());
  _amt numeric := round(COALESCE(_amount, 0)::numeric, 8);
  _shift record;
  _row public.shift_transactions%ROWTYPE;
  _ref text := NULLIF(trim(COALESCE(_reference_id, '')), '');
BEGIN
  IF auth.uid() IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF _id IS NULL THEN RAISE EXCEPTION 'معرّف حركة الصندوق مطلوب'; END IF;
  -- Replay of the same client id: the stored row, nothing new.
  SELECT * INTO _row FROM public.shift_transactions WHERE id = _id;
  IF FOUND THEN
    IF _row.user_id <> _owner THEN RAISE EXCEPTION 'غير مصرح'; END IF;
    RETURN jsonb_build_object('id', _row.id, 'status', 'replayed');
  END IF;
  IF _type IS NULL OR _type NOT IN ('sale', 'digital_sale', 'refund', 'deposit_capital', 'deposit_revenue', 'deposit_purchase_cover') THEN
    RAISE EXCEPTION 'نوع حركة الصندوق غير مسموح من التطبيق: %', COALESCE(_type, '-');
  END IF;
  IF _amt <= 0 THEN RAISE EXCEPTION 'مبلغ حركة الصندوق يجب أن يكون أكبر من الصفر'; END IF;
  SELECT id, user_id, closed_at INTO _shift FROM public.cash_shifts WHERE id = _shift_id FOR SHARE;
  IF NOT FOUND OR _shift.user_id <> _owner THEN RAISE EXCEPTION 'الوردية غير موجودة لهذا المتجر'; END IF;
  IF _shift.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'حركة لوردية مغلقة: تبقى معلقة للمطابقة اليدوية من المالك (F-20)';
  END IF;

  IF _ref IS NOT NULL AND EXISTS (SELECT 1 FROM public.shift_transactions
                                   WHERE shift_id = _shift_id AND type = _type AND reference_id = _ref) THEN
    -- Same rule as the old client path.
    IF _type = 'sale' THEN RETURN jsonb_build_object('status', 'duplicate_reference'); END IF;
    _ref := _ref || '#' || left(_id::text, 8);
  END IF;

  INSERT INTO public.shift_transactions(id, shift_id, user_id, type, amount, reference_id, notes, currency, currency_amount, exchange_rate)
  VALUES (_id, _shift_id, _owner, _type, _amt, _ref, NULLIF(_notes, ''),
          COALESCE(NULLIF(upper(trim(COALESCE(_currency, ''))), ''), 'USD'),
          CASE WHEN _currency_amount IS NULL THEN NULL ELSE round(_currency_amount::numeric, 8) END,
          COALESCE(_exchange_rate, 1))
  ON CONFLICT (shift_id, type, reference_id) DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'duplicate_reference'); END IF;
  RETURN jsonb_build_object('id', _id, 'status', 'inserted');
END $function$;
REVOKE EXECUTE ON FUNCTION public.record_shift_movement_atomic(uuid, uuid, text, numeric, text, text, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_shift_movement_atomic(uuid, uuid, text, numeric, text, text, text, numeric, numeric) TO authenticated, service_role;
