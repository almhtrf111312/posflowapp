-- FINANCE FIX (found by the golden-case harness, docs/FINANCE_LAW.md KD-03)
--
-- refund_invoice_atomic (as defined by 20261123003858_posflow_accounting_followup_verified) declares
-- RETURNS TABLE(... invoice_id ...), so `invoice_id` is also a PL/pgSQL variable inside the body. The statement that
-- reverses profit_records used the bare column name `invoice_id`, which PostgreSQL rejects at run time:
--     ERROR: column reference "invoice_id" is ambiguous
-- Every FULL refund therefore failed and rolled back. (Last successful refund on the live database: 2026-11-23 00:08 UTC,
-- before that migration was applied at 00:38 UTC.)
--
-- This migration changes exactly ONE token of the live definition: `invoice_id` -> `profit_records.invoice_id`.
-- Signature, grants and every other line are byte-identical to the live function (verified by md5 of prosrc).
-- Apply manually (owner approval required: AGENTS.md database rule).

CREATE OR REPLACE FUNCTION public.refund_invoice_atomic(_invoice_number text, _source text DEFAULT 'online'::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT NULL::text, _currency_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT NULL::numeric, _settlement_mode text DEFAULT 'drawer'::text)
 RETURNS TABLE(success boolean, already_refunded boolean, invoice_id uuid, invoice_number text, invoice_total numeric, invoice_currency text, restored_item_count integer, restored_unit_count numeric, deleted_debt_amount numeric, customer_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _invoice public.invoices%ROWTYPE;
  _restored_items integer := 0;
  _restored_units numeric := 0;
  _deleted_debt numeric := 0;
  _has_refund boolean := false;
  _track_inventory boolean := true;
  _store_type text;
  _row record;
  _main constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  _settlement jsonb;
  _request jsonb;
  _response jsonb;
  _norm_settlement_mode text := lower(COALESCE(NULLIF(trim(_settlement_mode), ''), 'drawer'));

BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _owner := public.get_owner_id(_caller);

  IF public.can_refund_invoices(auth.uid()) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ليست لديك صلاحية الاسترداد. اطلبها من مالك المتجر' USING ERRCODE = '42501';
  END IF;

  IF _norm_settlement_mode NOT IN ('drawer', 'external_cash') THEN
    RAISE EXCEPTION 'وضع التسوية غير صالح: %', _settlement_mode;
  END IF;

  _request := jsonb_build_object('invoice_number', _invoice_number, 'shift_id', _shift_id,
    'currency', _currency, 'currency_amount', _currency_amount, 'exchange_rate', _exchange_rate, 'settlement_mode', _norm_settlement_mode);
  _response := public._read_sales_settlement_replay(_owner, 'full_refund', _invoice_number, _request);

  SELECT i.* INTO _invoice
  FROM public.invoices i
  WHERE i.invoice_number = _invoice_number AND i.user_id = _owner
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, NULL::uuid, _invoice_number, 0::numeric, NULL::text, 0, 0::numeric, 0::numeric, NULL::text;
    RETURN;
  END IF;

  IF COALESCE(_invoice.status, '') IN ('cancelled', 'written_off') THEN
    RAISE EXCEPTION 'لا يمكن استرداد فاتورة ملغاة أو مشطوبة';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.stock_movements sm
    WHERE sm.user_id = _owner AND sm.invoice_id = _invoice.id AND sm.movement_type = 'refund'
  ) INTO _has_refund;

  -- Idempotent retry: return previously recorded result only (never create a new drawer tx)
  IF _invoice.status = 'refunded' OR _has_refund THEN
    RETURN QUERY SELECT false, true, _invoice.id, _invoice.invoice_number, COALESCE(_invoice.total, 0)::numeric, _invoice.currency::text, 0, 0::numeric, 0::numeric, _invoice.customer_name::text;
    RETURN;
  END IF;

  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'استرداد الفاتورة');

  _settlement := public._allocate_sales_refund(_invoice, 'full_refund', _invoice_number,
    CASE WHEN _invoice.payment_type = 'debt' THEN _invoice.debt_paid ELSE _invoice.total END,
    _shift_id, _norm_settlement_mode);
  PERFORM public._assert_sales_refund_currency(_settlement, _currency, _currency_amount, _exchange_rate);

  SELECT s.store_type INTO _store_type FROM public.stores s WHERE s.user_id = _owner ORDER BY s.created_at LIMIT 1;
  _track_inventory := NOT (COALESCE(_store_type, 'general') IN ('bakery', 'repair'));

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.refund_items(
    product_id uuid NOT NULL,
    warehouse_key uuid NOT NULL,
    quantity numeric(14,3) NOT NULL,
    PRIMARY KEY(product_id, warehouse_key)
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.refund_items;

  INSERT INTO pg_temp.refund_items(product_id, warehouse_key, quantity)
  SELECT
    ii.product_id,
    COALESCE(ii.stock_warehouse_id, _main),
    SUM(GREATEST(COALESCE(ii.quantity, 0), 0) * (CASE WHEN ii.unit = 'bulk' THEN GREATEST(COALESCE(ii.conversion_factor, 1), 1) ELSE 1 END))
  FROM public.invoice_items ii
  WHERE ii.invoice_id = _invoice.id AND ii.product_id IS NOT NULL
  GROUP BY ii.product_id, COALESCE(ii.stock_warehouse_id, _main)
  ON CONFLICT(product_id, warehouse_key) DO UPDATE SET quantity = pg_temp.refund_items.quantity + EXCLUDED.quantity;

  PERFORM set_config('app.stock_movement_type', 'refund', true);
  PERFORM set_config('app.stock_invoice_id', _invoice.id::text, true);
  PERFORM set_config('app.stock_invoice_number', _invoice.invoice_number, true);
  PERFORM set_config('app.stock_actor_id', _caller::text, true);
  PERFORM set_config('app.stock_source', CASE WHEN _source = 'offline-sync' THEN 'offline-sync' ELSE 'online' END, true);
  PERFORM set_config('app.refund_context', 'allowed', true);

  IF _track_inventory THEN
    FOR _row IN SELECT * FROM pg_temp.refund_items WHERE quantity > 0 LOOP
      IF _row.warehouse_key = _main THEN
        UPDATE public.products SET quantity = COALESCE(quantity, 0) + _row.quantity WHERE id = _row.product_id AND user_id = _owner;
      ELSE
        UPDATE public.warehouse_stock ws SET quantity = COALESCE(ws.quantity, 0) + _row.quantity, last_updated = now()
        WHERE ws.warehouse_id = _row.warehouse_key AND ws.product_id = _row.product_id;
        IF NOT FOUND THEN
          UPDATE public.products SET quantity = COALESCE(quantity, 0) + _row.quantity WHERE id = _row.product_id AND user_id = _owner;
        END IF;
      END IF;
    END LOOP;
    SELECT COUNT(*)::integer, COALESCE(SUM(quantity), 0)::numeric INTO _restored_items, _restored_units FROM pg_temp.refund_items WHERE quantity > 0;
  END IF;

  SELECT COALESCE(SUM(d.remaining_debt), 0)::numeric INTO _deleted_debt FROM public.debts d WHERE d.user_id = _owner AND (d.invoice_id = _invoice.invoice_number OR d.invoice_id = _invoice.id::text);

  UPDATE public.debts d SET status = 'cancelled', remaining_debt = 0, notes = concat_ws(E'\n', NULLIF(d.notes,''), 'ملغى بسبب مرتجع الفاتورة '||now()::text), updated_at = now() WHERE d.user_id = _owner AND (d.invoice_id = _invoice.invoice_number OR d.invoice_id = _invoice.id::text);

  IF _invoice.customer_id IS NOT NULL THEN
    UPDATE public.customers c SET total_purchases = s.total_purchases, total_debt = s.total_debt, invoice_count = s.invoice_count
    FROM (
      SELECT
        COALESCE(SUM(i.total) FILTER(WHERE i.id <> _invoice.id AND COALESCE(i.status, '') NOT IN ('refunded', 'cancelled')), 0)::numeric AS total_purchases,
        COALESCE(SUM(i.debt_remaining) FILTER(WHERE i.id <> _invoice.id AND COALESCE(i.status, '') NOT IN ('refunded', 'cancelled', 'paid') AND i.payment_type = 'debt'), 0)::numeric AS total_debt,
        COUNT(*) FILTER(WHERE i.id <> _invoice.id AND COALESCE(i.status, '') NOT IN ('refunded', 'cancelled'))::integer AS invoice_count
      FROM public.invoices i
      WHERE i.user_id = _owner AND i.customer_id = _invoice.customer_id
    ) s
    WHERE c.id = _invoice.customer_id AND c.user_id = _owner;
    PERFORM public.recalc_customer_open_debt(_owner, _invoice.customer_id);
  END IF;

  UPDATE public.invoice_items ii SET profit = 0 WHERE ii.invoice_id = _invoice.id;

  UPDATE public.invoices
  SET status = 'refunded',
      profit = 0,
      debt_remaining = 0,
      notes = concat_ws(E'\n', NULLIF(_invoice.notes, ''), 'Refunded at ' || now()::text),
      updated_at = now()
  WHERE id = _invoice.id;

  PERFORM public.revert_invoice_partner_profits_atomic(_invoice.id, 1.0);

  -- Atomically reverse profit_records within the same transaction
  UPDATE public.profit_records
     SET is_reversed = true,
         reversed_at = now()
   WHERE user_id = _owner
     AND profit_records.invoice_id IN (_invoice.invoice_number, _invoice.id::text)
     AND is_reversed = false;

  INSERT INTO public.activity_log(user_id, actor_id, actor_name, actor_role, action_type, entity_type, entity_id, entity_name, description, metadata)
  SELECT
    _owner, _caller, COALESCE(p.full_name, _invoice.cashier_name, 'مستخدم'), ur.role::text,
    'invoice_refunded', 'invoice', _invoice.id::text, _invoice.invoice_number,
    'تم استرداد الفاتورة ' || _invoice.invoice_number,
    jsonb_build_object(
      'invoice_number', _invoice.invoice_number,
      'invoice_total', COALESCE(_invoice.total, 0),
      'invoice_currency', _invoice.currency,
      'cash_refund_amount', (_settlement->>'cash')::numeric,
      'digital_to_refund', (_settlement->>'digital')::numeric,
      'receipt_allocation', true,
      'settlement_allocations', _settlement->'allocations',
      'shift_id', _shift_id,
      'settlement_mode', _norm_settlement_mode,
      'restored_items', _restored_items,
      'restored_units', _restored_units,
      'deleted_debt_amount', _deleted_debt,
      'source', CASE WHEN _source = 'offline-sync' THEN 'offline-sync' ELSE 'online' END
    )
  FROM (SELECT 1) seed
  LEFT JOIN public.profiles p ON p.user_id = _caller
  LEFT JOIN public.user_roles ur ON ur.user_id = _caller
  LIMIT 1;

  _response := _settlement || jsonb_build_object('invoice_id', _invoice.id, 'invoice_number', _invoice.invoice_number,
    'restored_item_count', _restored_items, 'restored_unit_count', _restored_units, 'deleted_debt_amount', _deleted_debt);
  INSERT INTO public.sales_settlement_replays(user_id, kind, operation_id, request, response)
  VALUES (_owner, 'full_refund', _invoice_number, _request, _response);

  RETURN QUERY SELECT true, false, _invoice.id, _invoice.invoice_number, COALESCE(_invoice.total, 0)::numeric, _invoice.currency::text, _restored_items, _restored_units, _deleted_debt, _invoice.customer_name::text;
END;
$function$;
