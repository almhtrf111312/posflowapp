-- =========================================================================
-- Migration: 20261116010000_audit_fixes.sql
-- إصلاحات تدقيق 16 نوفمبر 2026 (FIN-01, FIN-02) + عطلان إنتاجيان اكتُشفا أثناء التحقق:
--   A) receive_stock_wac و cancel_purchase_invoice_atomic كانتا تكتبان في أعمدة
--      غير موجودة في stock_movements (quantity, reference_id, notes) فتفشلان دائماً (42703).
--      حركة المخزون يسجلها أصلاً trigger المنتجات record_main_stock_movement.
--   B) اعتماد فاتورة الشراء يصبح معاملة واحدة على الخادم (finalize_purchase_invoice_atomic).
--   C) بيع نفس المنتج بوحدتين (كرتونة + قطعة) في فاتورة واحدة كان يُجمع بوحدة السطر الأول.
--   D) سحب صلاحية التنفيذ من anon/PUBLIC لدالتين ماليتين.
-- كل جزء آمن لإعادة التشغيل (idempotent).
-- =========================================================================

-- ========================================================
-- PART 1) receive_stock_wac: حذف الإدراج المعطوب والاعتماد على trigger المنتجات
-- ========================================================
CREATE OR REPLACE FUNCTION public.receive_stock_wac(
  _product_id uuid,
  _quantity numeric,
  _unit_cost numeric,
  _reference text DEFAULT NULL::text
)
RETURNS TABLE(new_quantity numeric, new_cost numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _cur_qty numeric;
  _cur_cost numeric;
  _pos_qty numeric;
  _calc_cost numeric;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'Owner context is required';
  END IF;

  IF COALESCE(_quantity, 0) <= 0 OR COALESCE(_unit_cost, -1) < 0 THEN
    RAISE EXCEPTION 'Invalid stock quantity or unit cost';
  END IF;

  SELECT COALESCE(p.quantity, 0), COALESCE(p.cost_price, 0)
    INTO _cur_qty, _cur_cost
    FROM public.products p
   WHERE p.id = _product_id AND p.user_id = _owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  _pos_qty := GREATEST(_cur_qty, 0);

  IF _pos_qty = 0 THEN
    _calc_cost := _unit_cost;
  ELSIF _unit_cost = 0 THEN
    _calc_cost := _cur_cost;
  ELSE
    _calc_cost := round(((_pos_qty * _cur_cost) + (_quantity * _unit_cost)) / (_pos_qty + _quantity), 8);
  END IF;

  -- trigger record_main_stock_movement reads these settings and writes the stock_movements row
  PERFORM set_config('app.stock_movement_type', 'purchase', true);
  PERFORM set_config('app.stock_source', 'receive_stock_wac', true);
  PERFORM set_config('app.stock_invoice_number', COALESCE(_reference, ''), true);

  UPDATE public.products
     SET quantity = _cur_qty + _quantity,
         cost_price = _calc_cost,
         updated_at = now()
   WHERE id = _product_id;

  RETURN QUERY SELECT (_cur_qty + _quantity), _calc_cost;
END;
$function$;

REVOKE ALL ON FUNCTION public.receive_stock_wac(uuid, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_stock_wac(uuid, numeric, numeric, text) TO authenticated, service_role;

-- ========================================================
-- PART 2) cancel_purchase_invoice_atomic: نفس العطل — ترقيع التعريف الحي في مكانه
-- ========================================================
DO $patch$
DECLARE
  _def text;
  _n int;
  _s int;
  _e int;
BEGIN
  SELECT count(*), max(pg_get_functiondef(p.oid)) INTO _n, _def
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'cancel_purchase_invoice_atomic';
  IF _n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one cancel_purchase_invoice_atomic, found %', _n;
  END IF;

  _s := position('INSERT INTO public.stock_movements' in _def);
  IF _s = 0 THEN
    RAISE NOTICE 'cancel_purchase_invoice_atomic already patched';
    RETURN;
  END IF;

  _e := position(');' in substring(_def from _s));
  IF _e = 0 THEN
    RAISE EXCEPTION 'broken INSERT terminator not found';
  END IF;

  _def := left(_def, _s - 1) || 'NULL;' || substring(_def from _s + _e + 1);

  IF (length(_def) - length(replace(_def, 'UPDATE public.products', ''))) <> length('UPDATE public.products') THEN
    RAISE EXCEPTION 'expected exactly one UPDATE public.products';
  END IF;

  _def := replace(
    _def,
    'UPDATE public.products',
    'PERFORM set_config(''app.stock_movement_type'', ''purchase_reversal'', true); PERFORM set_config(''app.stock_source'', ''cancel_purchase_invoice'', true); UPDATE public.products'
  );

  EXECUTE _def;
END
$patch$;

-- ========================================================
-- PART 3) finalize_purchase_invoice_atomic: اعتماد فاتورة الشراء في معاملة واحدة
-- ========================================================
CREATE OR REPLACE FUNCTION public.finalize_purchase_invoice_atomic(_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _inv public.purchase_invoices%ROWTYPE;
  _it record;
  _pid uuid;
  _old_cost numeric;
  _no_inventory boolean := false;
  _hist jsonb;
  _count integer := 0;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'Owner context is required';
  END IF;

  SELECT * INTO _inv
    FROM public.purchase_invoices
   WHERE id = _invoice_id AND user_id = _owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase invoice not found';
  END IF;

  -- idempotency: a retry after a lost response must not add stock twice
  IF _inv.status = 'finalized' THEN
    RETURN jsonb_build_object('success', true, 'already_finalized', true, 'invoice_id', _invoice_id);
  END IF;

  IF COALESCE(_inv.status, 'draft') NOT IN ('draft', 'reconciled') THEN
    RAISE EXCEPTION 'Purchase invoice cannot be finalized from status %', _inv.status;
  END IF;

  SELECT COALESCE(s.store_type, 'general') IN ('bakery', 'repair')
    INTO _no_inventory
    FROM public.stores s
   WHERE s.user_id = _owner
   LIMIT 1;
  _no_inventory := COALESCE(_no_inventory, false);

  FOR _it IN
    SELECT * FROM public.purchase_invoice_items
     WHERE invoice_id = _invoice_id
     ORDER BY created_at, id
  LOOP
    _count := _count + 1;
    _pid := _it.product_id;

    PERFORM set_config('app.stock_movement_type', 'purchase', true);
    PERFORM set_config('app.stock_source', 'finalize_purchase_invoice', true);
    PERFORM set_config('app.stock_invoice_number', COALESCE(_inv.invoice_number, ''), true);

    _hist := jsonb_build_array(jsonb_build_object(
      'invoice_id', _invoice_id,
      'invoice_number', _inv.invoice_number,
      'supplier_name', _inv.supplier_name,
      'date', _inv.invoice_date,
      'quantity', _it.quantity,
      'cost_price', _it.cost_price,
      'added_at', now()
    ));

    -- a linked product must belong to this store; otherwise resolve it again
    IF _pid IS NOT NULL THEN
      PERFORM 1 FROM public.products p WHERE p.id = _pid AND p.user_id = _owner;
      IF NOT FOUND THEN
        _pid := NULL;
      END IF;
    END IF;

    IF _pid IS NULL AND NULLIF(trim(_it.barcode), '') IS NOT NULL THEN
      SELECT p.id INTO _pid
        FROM public.products p
       WHERE p.user_id = _owner AND p.barcode = trim(_it.barcode)
       ORDER BY p.created_at
       LIMIT 1;
    END IF;

    IF _pid IS NULL AND NULLIF(trim(_it.product_name), '') IS NOT NULL THEN
      SELECT p.id INTO _pid
        FROM public.products p
       WHERE p.user_id = _owner AND lower(trim(p.name)) = lower(trim(_it.product_name))
       ORDER BY p.created_at
       LIMIT 1;
    END IF;

    IF _pid IS NULL THEN
      INSERT INTO public.products(
        user_id, name, barcode, category, quantity, cost_price, sale_price, min_stock_level, purchase_history
      ) VALUES (
        _owner, _it.product_name, NULLIF(trim(_it.barcode), ''), _it.category,
        CASE WHEN _no_inventory THEN 99999 ELSE _it.quantity END,
        COALESCE(_it.cost_price, 0),
        COALESCE(NULLIF(_it.sale_price, 0), _it.cost_price, 0),
        5, _hist
      )
      RETURNING id INTO _pid;

      UPDATE public.purchase_invoice_items
         SET product_id = _pid, cost_price_before = 0
       WHERE id = _it.id;
    ELSE
      SELECT COALESCE(p.cost_price, 0) INTO _old_cost
        FROM public.products p
       WHERE p.id = _pid
         FOR UPDATE;

      UPDATE public.purchase_invoice_items
         SET product_id = _pid, cost_price_before = _old_cost
       WHERE id = _it.id;

      IF _no_inventory THEN
        UPDATE public.products
           SET cost_price = COALESCE(_it.cost_price, 0), updated_at = now()
         WHERE id = _pid;
      ELSE
        PERFORM public.receive_stock_wac(
          _pid,
          _it.quantity::numeric,
          COALESCE(_it.cost_price, 0)::numeric,
          'purchase_invoice:' || COALESCE(_inv.invoice_number, '')
        );
      END IF;

      UPDATE public.products
         SET purchase_history = (CASE WHEN jsonb_typeof(purchase_history) = 'array' THEN purchase_history ELSE '[]'::jsonb END) || _hist
       WHERE id = _pid;
    END IF;
  END LOOP;

  IF _count = 0 THEN
    RAISE EXCEPTION 'Purchase invoice has no items';
  END IF;

  UPDATE public.purchase_invoices
     SET status = 'finalized', updated_at = now()
   WHERE id = _invoice_id;

  RETURN jsonb_build_object('success', true, 'already_finalized', false, 'invoice_id', _invoice_id, 'items', _count);
END;
$function$;

REVOKE ALL ON FUNCTION public.finalize_purchase_invoice_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_purchase_invoice_atomic(uuid) TO authenticated, service_role;

-- ========================================================
-- PART 4) process_pos_sale_atomic: نفس المنتج بوحدتين مختلفتين يُحوَّل إلى قطع قبل الجمع
-- ========================================================
DO $patch$
DECLARE
  _def text;
  _n int;
  _old text := 'quantity = pg_temp.pos_sale_items.quantity + EXCLUDED.quantity,';
  _new text := $new$quantity = CASE WHEN pg_temp.pos_sale_items.unit = EXCLUDED.unit AND pg_temp.pos_sale_items.conversion_factor = EXCLUDED.conversion_factor THEN pg_temp.pos_sale_items.quantity + EXCLUDED.quantity ELSE (CASE WHEN pg_temp.pos_sale_items.unit = 'bulk' THEN pg_temp.pos_sale_items.quantity * pg_temp.pos_sale_items.conversion_factor ELSE pg_temp.pos_sale_items.quantity END) + (CASE WHEN EXCLUDED.unit = 'bulk' THEN EXCLUDED.quantity * EXCLUDED.conversion_factor ELSE EXCLUDED.quantity END) END, /* mixed_unit_merge */
      unit_price = CASE WHEN pg_temp.pos_sale_items.unit = EXCLUDED.unit AND pg_temp.pos_sale_items.conversion_factor = EXCLUDED.conversion_factor THEN pg_temp.pos_sale_items.unit_price ELSE round((pg_temp.pos_sale_items.amount_usd + EXCLUDED.amount_usd) / NULLIF((CASE WHEN pg_temp.pos_sale_items.unit = 'bulk' THEN pg_temp.pos_sale_items.quantity * pg_temp.pos_sale_items.conversion_factor ELSE pg_temp.pos_sale_items.quantity END) + (CASE WHEN EXCLUDED.unit = 'bulk' THEN EXCLUDED.quantity * EXCLUDED.conversion_factor ELSE EXCLUDED.quantity END), 0), 8) END,
      unit = CASE WHEN pg_temp.pos_sale_items.unit = EXCLUDED.unit AND pg_temp.pos_sale_items.conversion_factor = EXCLUDED.conversion_factor THEN pg_temp.pos_sale_items.unit ELSE 'piece' END,
      conversion_factor = CASE WHEN pg_temp.pos_sale_items.unit = EXCLUDED.unit AND pg_temp.pos_sale_items.conversion_factor = EXCLUDED.conversion_factor THEN pg_temp.pos_sale_items.conversion_factor ELSE 1 END,$new$;
BEGIN
  SELECT count(*), max(pg_get_functiondef(p.oid)) INTO _n, _def
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'process_pos_sale_atomic';
  IF _n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one process_pos_sale_atomic, found %', _n;
  END IF;

  IF position('mixed_unit_merge' in _def) > 0 THEN
    RAISE NOTICE 'process_pos_sale_atomic already patched';
    RETURN;
  END IF;

  IF (length(_def) - length(replace(_def, _old, ''))) <> length(_old) THEN
    RAISE EXCEPTION 'expected exactly one ON CONFLICT quantity line in process_pos_sale_atomic';
  END IF;

  _def := replace(_def, _old, _new);
  EXECUTE _def;
END
$patch$;

-- ========================================================
-- PART 5) تشديد الصلاحيات: لا تنفيذ لغير المسجلين
-- ========================================================
REVOKE EXECUTE ON FUNCTION public.close_cash_shift_atomic(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_cash_shift_atomic(uuid, numeric, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.edit_purchase_invoice_atomic(uuid, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_purchase_invoice_atomic(uuid, jsonb, text, text) TO authenticated, service_role;

-- ========================================================
-- PART 6) رصيد افتتاح الوردية لا يكون سالباً
-- ========================================================
DO $patch$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cash_shifts_opening_balance_nonneg'
       AND conrelid = 'public.cash_shifts'::regclass
  ) THEN
    ALTER TABLE public.cash_shifts
      ADD CONSTRAINT cash_shifts_opening_balance_nonneg CHECK (opening_balance >= 0);
  END IF;
END
$patch$;
