-- General store drawer (D-35, owner-approved design 2026-11-27).
-- One permanent drawer per store (cash_shifts.is_general). It is never closed. It receives:
--   * cash operations made without a shift (the app passes its id as the shift id; every cash RPC already accepts any
--     open shift of the store),
--   * the counted cash of every cashier shift when that shift closes (transfer_in, per currency),
--   * minus the opening float of every new shift (transfer_out, per currency),
--   * optional counts (count_general_drawer_atomic) that post a surplus/shortage without closing it.
-- Money is never counted twice: a shift's cash enters the general drawer only once, when the shift closes.
-- The transfers happen only when the store HAS a general drawer, so stores that never create one behave exactly as before.
-- F-17/F-18/F-19 keep holding: every transfer is one shift_transactions row with a unique (shift, type, reference).

ALTER TABLE public.cash_shifts ADD COLUMN IF NOT EXISTS is_general boolean NOT NULL DEFAULT false;

-- One general drawer per store; it does not count as a cashier's open shift.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_shifts_one_general ON public.cash_shifts (user_id) WHERE is_general;
DROP INDEX IF EXISTS public.uq_cash_shifts_one_open_per_cashier;
CREATE UNIQUE INDEX uq_cash_shifts_one_open_per_cashier
  ON public.cash_shifts (user_id, COALESCE(cashier_id, user_id)) WHERE closed_at IS NULL AND NOT is_general;

-- Clients cannot create, flag or close a general drawer directly (old APKs write shifts directly, S-2).
CREATE OR REPLACE FUNCTION public.guard_general_drawer()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_general AND public._direct_client_write() THEN
      RAISE EXCEPTION 'الصندوق العام يُنشأ عبر العملية الذرية فقط' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.is_general IS DISTINCT FROM OLD.is_general THEN
    RAISE EXCEPTION 'لا يمكن تغيير نوع الصندوق' USING ERRCODE = '42501';
  END IF;
  IF OLD.is_general AND NEW.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'الصندوق العام لا يُغلق؛ استعمل «عدّ الصندوق» للمطابقة' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $function$;
DROP TRIGGER IF EXISTS a1_guard_general_drawer ON public.cash_shifts;
CREATE TRIGGER a1_guard_general_drawer BEFORE INSERT OR UPDATE ON public.cash_shifts
  FOR EACH ROW EXECUTE FUNCTION public.guard_general_drawer();

-- Returns the store's general drawer, creating it on first use (any member of the store; the starting balance is used only
-- when it is created, and only the owner may set it).
CREATE OR REPLACE FUNCTION public.ensure_general_drawer_atomic(_opening_balance numeric DEFAULT 0)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _owner uuid := public.get_owner_id(auth.uid());
  _opening numeric := round(COALESCE(_opening_balance, 0)::numeric, 8);
  _id uuid;
BEGIN
  IF _uid IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('general_drawer:' || _owner::text));
  SELECT id INTO _id FROM public.cash_shifts WHERE user_id = _owner AND is_general;
  IF FOUND THEN RETURN jsonb_build_object('id', _id, 'status', 'existing'); END IF;
  IF _opening < 0 THEN RAISE EXCEPTION 'رصيد البداية لا يكون سالباً'; END IF;
  IF _opening > 0 AND _uid <> _owner THEN RAISE EXCEPTION 'رصيد البداية يحدده المالك فقط'; END IF;
  INSERT INTO public.cash_shifts(user_id, cashier_id, cashier_name, opened_at, opening_balance, expected_balance,
                                 reconciliation_status, is_general)
  VALUES (_owner, NULL, 'الصندوق العام', now(), _opening, _opening, 'open', true)
  RETURNING id INTO _id;
  RETURN jsonb_build_object('id', _id, 'status', 'created');
END $function$;
REVOKE EXECUTE ON FUNCTION public.ensure_general_drawer_atomic(numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_general_drawer_atomic(numeric) TO authenticated, service_role;

-- Opening float of a cashier shift leaves the general drawer; counted cash of a closed shift enters it (per currency).
CREATE OR REPLACE FUNCTION public.general_drawer_shift_transfer()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _gen uuid;
  _k text; _v numeric; _rate numeric; _d jsonb; _cnt numeric;
  _total numeric := 0;
BEGIN
  IF NEW.is_general THEN RETURN NEW; END IF;
  SELECT id INTO _gen FROM public.cash_shifts WHERE user_id = NEW.user_id AND is_general;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.opening_by_currency IS NOT NULL AND jsonb_typeof(NEW.opening_by_currency) = 'object' THEN
      FOR _k, _v IN SELECT key, NULLIF(value #>> '{}', '')::numeric FROM jsonb_each(NEW.opening_by_currency) LOOP
        IF COALESCE(_v, 0) > 0 THEN
          _rate := CASE WHEN upper(_k) = 'USD' THEN 1 ELSE NULLIF((NEW.opening_exchange_rates->>upper(_k))::numeric, 0) END;
          IF _rate IS NULL THEN RAISE EXCEPTION 'سعر صرف العملة % غير متوفر لتحويل رصيد الافتتاح', _k; END IF;
          INSERT INTO public.shift_transactions(shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes, created_at)
          VALUES (_gen, NEW.user_id, 'transfer_out', round(_v / _rate, 8), upper(_k), _v, _rate,
                  'shift_open:' || NEW.id || ':' || upper(_k), 'رصيد افتتاح وردية ' || COALESCE(NEW.cashier_name, ''), now());
          _total := _total + round(_v / _rate, 8);
        END IF;
      END LOOP;
    ELSIF COALESCE(NEW.opening_balance, 0) > 0 THEN
      INSERT INTO public.shift_transactions(shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes, created_at)
      VALUES (_gen, NEW.user_id, 'transfer_out', round(NEW.opening_balance, 8), 'USD', round(NEW.opening_balance, 8), 1,
              'shift_open:' || NEW.id || ':USD', 'رصيد افتتاح وردية ' || COALESCE(NEW.cashier_name, ''), now());
      _total := round(NEW.opening_balance, 8);
    END IF;
    IF _total > 0 THEN
      UPDATE public.cash_shifts SET expected_balance = round(COALESCE(expected_balance, 0) - _total, 8) WHERE id = _gen;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: the shift has just been closed.
  IF OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL THEN
    IF NEW.currency_counts IS NOT NULL AND jsonb_typeof(NEW.currency_counts) = 'array' AND jsonb_array_length(NEW.currency_counts) > 0 THEN
      FOR _d IN SELECT * FROM jsonb_array_elements(NEW.currency_counts) LOOP
        _cnt := COALESCE((_d->>'counted')::numeric, 0);
        _rate := CASE WHEN upper(_d->>'code') = 'USD' THEN 1 ELSE NULLIF((_d->>'rate')::numeric, 0) END;
        IF _cnt > 0 AND _rate IS NOT NULL THEN
          INSERT INTO public.shift_transactions(shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes, created_at)
          VALUES (_gen, NEW.user_id, 'transfer_in', round(_cnt / _rate, 8), upper(_d->>'code'), _cnt, _rate,
                  'shift_close:' || NEW.id || ':' || upper(_d->>'code'), 'تسليم وردية ' || COALESCE(NEW.cashier_name, ''), now());
          _total := _total + round(_cnt / _rate, 8);
        END IF;
      END LOOP;
    ELSIF COALESCE(NEW.actual_balance, 0) > 0 THEN
      INSERT INTO public.shift_transactions(shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes, created_at)
      VALUES (_gen, NEW.user_id, 'transfer_in', round(NEW.actual_balance, 8), 'USD', round(NEW.actual_balance, 8), 1,
              'shift_close:' || NEW.id || ':USD', 'تسليم وردية ' || COALESCE(NEW.cashier_name, ''), now());
      _total := round(NEW.actual_balance, 8);
    END IF;
    IF _total > 0 THEN
      UPDATE public.cash_shifts SET expected_balance = round(COALESCE(expected_balance, 0) + _total, 8) WHERE id = _gen;
    END IF;
  END IF;
  RETURN NEW;
END $function$;
DROP TRIGGER IF EXISTS z_general_drawer_transfer ON public.cash_shifts;
CREATE TRIGGER z_general_drawer_transfer AFTER INSERT OR UPDATE OF closed_at ON public.cash_shifts
  FOR EACH ROW EXECUTE FUNCTION public.general_drawer_shift_transfer();

-- Optional count of the general drawer (owner only): posts the difference as surplus/shortage; the drawer stays open.
-- Idempotent by operation id (reference 'count:<op>').
CREATE OR REPLACE FUNCTION public.count_general_drawer_atomic(_counted_usd numeric, _note text DEFAULT NULL, _operation_id text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _owner uuid := public.get_owner_id(auth.uid());
  _gen record;
  _ref text;
  _expected numeric; _diff numeric;
BEGIN
  IF _uid IS NULL OR _owner IS NULL OR _uid <> _owner THEN RAISE EXCEPTION 'عدّ الصندوق العام للمالك فقط'; END IF;
  IF _counted_usd IS NULL OR _counted_usd < 0 THEN RAISE EXCEPTION 'المبلغ المعدود غير صالح'; END IF;
  SELECT * INTO _gen FROM public.cash_shifts WHERE user_id = _owner AND is_general FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'لا يوجد صندوق عام لهذا المتجر'; END IF;
  _ref := 'count:' || COALESCE(NULLIF(_operation_id, ''), gen_random_uuid()::text);
  IF EXISTS (SELECT 1 FROM public.shift_transactions WHERE shift_id = _gen.id AND reference_id = _ref) THEN
    RETURN jsonb_build_object('success', true, 'replayed', true);
  END IF;
  _expected := round(COALESCE(_gen.opening_balance, 0)
    + COALESCE((SELECT SUM(amount) FROM public.shift_transactions WHERE shift_id = _gen.id AND type IN ('sale','deposit','deposit_capital','deposit_revenue','deposit_purchase_cover','debt_payment','surplus','expense_refund','supplier_refund','fx_in','transfer_in')), 0)
    - COALESCE((SELECT SUM(amount) FROM public.shift_transactions WHERE shift_id = _gen.id AND type IN ('expense','refund','withdrawal','supplier_payment','store_credit_refund','shortage','fx_out','transfer_out')), 0), 8);
  _diff := round(round(_counted_usd, 8) - _expected, 8);
  IF _diff <> 0 THEN
    PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'عدّ الصندوق العام');
    INSERT INTO public.shift_transactions(shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes, created_at)
    VALUES (_gen.id, _owner, CASE WHEN _diff > 0 THEN 'surplus' ELSE 'shortage' END, abs(_diff), 'USD', abs(_diff), 1, _ref,
            CASE WHEN _diff > 0 THEN 'فائض عند عدّ الصندوق العام: ' ELSE 'عجز عند عدّ الصندوق العام: ' END || COALESCE(_note, ''), now());
  END IF;
  UPDATE public.cash_shifts SET expected_balance = round(_counted_usd, 8), updated_at = now() WHERE id = _gen.id;
  RETURN jsonb_build_object('success', true, 'expected', _expected, 'counted', round(_counted_usd, 8), 'difference', _diff);
END $function$;
REVOKE EXECUTE ON FUNCTION public.count_general_drawer_atomic(numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.count_general_drawer_atomic(numeric, text, text) TO authenticated, service_role;

-- Patches of existing functions (exact occurrence counts are asserted; any mismatch aborts the whole migration):
--   * guard_fx_change_during_open_shift: the general drawer is always open, so it must not block currency changes.
--   * add_expense_atomic / delete_expense_atomic / process_quick_purchase_atomic: a cashier may use the general drawer.
DO $patch$
DECLARE
  _p record; _src text; _new text; _n int;
BEGIN
  FOR _p IN SELECT * FROM (VALUES
      ('guard_fx_change_during_open_shift', E'           AND closed_at IS NULL\n', E'           AND closed_at IS NULL\n           AND NOT is_general\n'),
      ('add_expense_atomic', '(cashier_id = _uid OR public.is_store_owner(_uid))', '(cashier_id = _uid OR is_general OR public.is_store_owner(_uid))'),
      ('delete_expense_atomic', '(cashier_id = _caller OR public.is_store_owner(_caller))', '(cashier_id = _caller OR is_general OR public.is_store_owner(_caller))'),
      ('process_quick_purchase_atomic', '(cashier_id::text = _caller::text OR _caller = _owner)', '(cashier_id::text = _caller::text OR is_general OR _caller = _owner)')
    ) AS t(fn, old_text, new_text)
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO _src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = _p.fn;
    IF _src IS NULL THEN RAISE EXCEPTION 'general drawer patch: function % not found', _p.fn; END IF;
    _src := replace(_src, E'\r', '');
    _n := (length(_src) - length(replace(_src, _p.old_text, ''))) / length(_p.old_text);
    IF _n <> 1 THEN RAISE EXCEPTION 'general drawer patch: % has % occurrences of the target (expected 1)', _p.fn, _n; END IF;
    _new := replace(_src, _p.old_text, _p.new_text);
    EXECUTE _new;
  END LOOP;
END $patch$;
