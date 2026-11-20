-- =============================================================================
-- Migration: 20261120260000_posflow_audit_review_critical_fixes.sql
-- PosFlow — Critical Fixes from Deep Audit Review of v1.5.210–v1.5.215
-- Target DB: PosFlow (bwlqfxfvchjvehnbvwaz)
-- Rollback:  supabase/live-snapshots/rollbacks/ROLLBACK_audit_review_fixes.sql
--
-- Covers:
--   1. mark_invoice_digital: fix cashier silent failure (get_owner_id vs auth.uid)
--   2. record_stock_damage_atomic: fix double stock deduction on sub-warehouses
--   3. _partners_trim_history: fix 400-day trigger perf trap -> 90 days + cap 500
--   4. release_pending_partner_profits_for_invoice: fix PartnerProfitDetailedReport
--      double-counting by flipping isDebt=false & marking prior releases superseded
--   5. purchase_return_atomic: prevent WAC cost_price collapsing to 0
--   6. refund_invoice_partial_atomic: support explicit serials[] per refunded item
--      with LIFO fallback when omitted
--   7. edit_purchase_invoice_atomic: block edit if any serial is already sold/removed
--      and preserve original serial casing
--   8. Add missing index invoices(user_id, updated_at DESC) for Delta Sync
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1) mark_invoice_digital: use get_owner_id(auth.uid()) so cashiers succeed
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_invoice_digital(_invoice_number text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $f$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _n int;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;
  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'لم يتم العثور على سياق المتجر';
  END IF;

  UPDATE public.invoices
     SET payment_method = 'digital',
         updated_at = now()
   WHERE invoice_number = _invoice_number
     AND user_id = _owner
     AND COALESCE(payment_method, 'cash') <> 'digital';

  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n > 0;
END $f$;

REVOKE ALL ON FUNCTION public.mark_invoice_digital(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_invoice_digital(text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2) record_stock_damage_atomic: deduct ONLY warehouse_stock OR products (never both)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_stock_damage_atomic(
  _product_id uuid,
  _warehouse_id uuid,
  _quantity numeric,
  _unit_cost numeric DEFAULT NULL,
  _reason text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _apply_to_stock boolean DEFAULT true,
  _source text DEFAULT 'manual',
  _source_ref text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $f$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _p record;
  _ws_qty numeric;
  _cost numeric;
  _id uuid;
  _name text;
  _ref_uuid uuid;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'owner not found';
  END IF;
  IF COALESCE(_quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'الكمية يجب أن تكون أكبر من الصفر';
  END IF;

  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'تسجيل تالف');

  SELECT id, name, quantity, cost_price
    INTO _p
    FROM public.products
   WHERE id = _product_id AND user_id = _owner
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'المنتج غير موجود';
  END IF;

  _cost := COALESCE(_unit_cost, _p.cost_price, 0);

  IF COALESCE(_apply_to_stock, true) THEN
    PERFORM set_config('app.stock_movement_type', 'damage', true);
    PERFORM set_config('app.stock_actor_id', _caller::text, true);
    PERFORM set_config('app.stock_source', 'record_stock_damage_atomic', true);

    IF _warehouse_id IS NOT NULL THEN
      -- المستودع الفرعي: الخصم يتم من warehouse_stock فقط دون المساس بمخزون products الرئيسي
      SELECT quantity
        INTO _ws_qty
        FROM public.warehouse_stock
       WHERE warehouse_id = _warehouse_id AND product_id = _product_id
         FOR UPDATE;

      IF NOT FOUND OR COALESCE(_ws_qty, 0) < _quantity THEN
        RAISE EXCEPTION 'الكمية التالفة (%) أكبر من المخزون المتاح في المستودع (%)', _quantity, COALESCE(_ws_qty, 0);
      END IF;

      UPDATE public.warehouse_stock
         SET quantity = round(_ws_qty - _quantity, 3),
             last_updated = now()
       WHERE warehouse_id = _warehouse_id AND product_id = _product_id;
    ELSE
      -- المستودع الرئيسي: الخصم يتم من products فقط
      IF COALESCE(_p.quantity, 0) < _quantity THEN
        RAISE EXCEPTION 'الكمية التالفة (%) أكبر من المخزون المتاح (%)', _quantity, COALESCE(_p.quantity, 0);
      END IF;

      UPDATE public.products
         SET quantity = round(quantity - _quantity, 3),
             updated_at = now()
       WHERE id = _product_id;
    END IF;
  END IF;

  SELECT COALESCE(full_name, 'مستخدم') INTO _name FROM public.profiles WHERE user_id = _caller;

  _ref_uuid := CASE
    WHEN _source_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN _source_ref::uuid
    ELSE NULL
  END;

  INSERT INTO public.stock_damages(
    user_id, product_id, product_name, warehouse_id, quantity, unit_cost, cost_value,
    reason, notes, damaged_at, recorded_by, recorded_by_name, source, source_ref
  ) VALUES (
    _owner, _product_id, _p.name, _warehouse_id, _quantity, _cost, round(_quantity * _cost, 8),
    _reason, _notes, now(), _caller, COALESCE(_name, 'مستخدم'), COALESCE(_source, 'manual'), _ref_uuid
  ) RETURNING id INTO _id;

  RETURN _id;
END $f$;

REVOKE ALL ON FUNCTION public.record_stock_damage_atomic(uuid, uuid, numeric, numeric, text, text, boolean, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_stock_damage_atomic(uuid, uuid, numeric, numeric, text, text, boolean, text, text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3) _partners_trim_history: fix 400-day perf trap -> 90 days AND max 500 entries
--    (full immutable history is preserved in public.partner_ledger_entries)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._partners_trim_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $f$
DECLARE
  _cut timestamptz := now() - interval '90 days';
  _max_len constant int := 500;
  _trigger_len constant int := 600;
BEGIN
  IF jsonb_typeof(NEW.profit_history) = 'array' AND jsonb_array_length(NEW.profit_history) > _trigger_len THEN
    NEW.profit_history := COALESCE((
      SELECT jsonb_agg(sub.x ORDER BY sub.ord)
      FROM (
        SELECT x, ord
        FROM jsonb_array_elements(NEW.profit_history) WITH ORDINALITY AS t(x, ord)
        WHERE (COALESCE(x->>'createdAt', '') !~ '^\d{4}-' OR (x->>'createdAt')::timestamptz >= _cut)
        ORDER BY ord DESC
        LIMIT _max_len
      ) sub
    ), '[]'::jsonb);
  END IF;

  IF jsonb_typeof(NEW.expense_history) = 'array' AND jsonb_array_length(NEW.expense_history) > _trigger_len THEN
    NEW.expense_history := COALESCE((
      SELECT jsonb_agg(sub.x ORDER BY sub.ord)
      FROM (
        SELECT x, ord
        FROM jsonb_array_elements(NEW.expense_history) WITH ORDINALITY AS t(x, ord)
        WHERE (COALESCE(x->>'createdAt', '') !~ '^\d{4}-' OR (x->>'createdAt')::timestamptz >= _cut)
        ORDER BY ord DESC
        LIMIT _max_len
      ) sub
    ), '[]'::jsonb);
  END IF;

  IF jsonb_typeof(NEW.withdrawal_history) = 'array' AND jsonb_array_length(NEW.withdrawal_history) > _trigger_len THEN
    NEW.withdrawal_history := COALESCE((
      SELECT jsonb_agg(sub.x ORDER BY sub.ord)
      FROM (
        SELECT x, ord
        FROM jsonb_array_elements(NEW.withdrawal_history) WITH ORDINALITY AS t(x, ord)
        WHERE (COALESCE(x->>'createdAt', x->>'date', '') !~ '^\d{4}-' OR COALESCE(x->>'createdAt', x->>'date')::timestamptz >= _cut)
        ORDER BY ord DESC
        LIMIT _max_len
      ) sub
    ), '[]'::jsonb);
  END IF;

  RETURN NEW;
END $f$;

-- -----------------------------------------------------------------------------
-- 4) release_pending_partner_profits_for_invoice:
--    Flip original isDebt->false and mark prior release entries superseded=true
--    so PartnerProfitDetailedReport never double-counts or shows ghost pending.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_pending_partner_profits_for_invoice(_invoice_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $f$
DECLARE
  _inv public.invoices%ROWTYPE;
  _p record;
  _sum numeric;
  _tot numeric := 0;
  _keep jsonb;
  _hist jsonb;
  _it jsonb;
BEGIN
  PERFORM set_config('app.partner_source', 'release_pending_partner_profits_for_invoice', true);
  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  FOR _p IN
    SELECT * FROM public.partners
     WHERE user_id = _inv.user_id
       AND (
         pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
         OR profit_history @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number, 'isDebt', true))
       )
     FOR UPDATE
  LOOP
    _sum := 0;
    _keep := '[]'::jsonb;
    FOR _it IN SELECT * FROM jsonb_array_elements(COALESCE(_p.pending_profit_details, '[]'::jsonb)) LOOP
      IF _it->>'invoiceId' = _inv.invoice_number THEN
        _sum := _sum + COALESCE((_it->>'amount')::numeric, 0);
      ELSE
        _keep := _keep || _it;
      END IF;
    END LOOP;

    _hist := '[]'::jsonb;
    FOR _it IN SELECT * FROM jsonb_array_elements(COALESCE(_p.profit_history, '[]'::jsonb)) LOOP
      IF (_it->>'invoiceId') = _inv.invoice_number
         AND COALESCE((_it->>'isDebt')::boolean, false) = true
         AND COALESCE((_it->>'isReversal')::boolean, false) = false THEN
        _hist := _hist || jsonb_set(_it, '{isDebt}', 'false'::jsonb);
      ELSIF (_it->>'invoiceId') = _inv.invoice_number
            AND (COALESCE((_it->>'isRelease')::boolean, false) OR COALESCE(_it->>'id', '') LIKE '%-rel')
            AND NOT COALESCE((_it->>'superseded')::boolean, false) THEN
        _hist := _hist || jsonb_set(_it, '{superseded}', 'true'::jsonb);
      ELSE
        _hist := _hist || _it;
      END IF;
    END LOOP;

    UPDATE public.partners
       SET pending_profit = round((SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(_keep) x), 4),
           confirmed_profit = round(COALESCE(confirmed_profit, 0) + _sum, 4),
           current_balance = round(COALESCE(current_balance, 0) + _sum, 4),
           total_profit_earned = round(COALESCE(total_profit_earned, 0) + _sum, 4),
           pending_profit_details = _keep,
           profit_history = _hist,
           updated_at = now()
     WHERE id = _p.id;

    _tot := _tot + _sum;
  END LOOP;

  RETURN _tot;
END $f$;

REVOKE ALL ON FUNCTION public.release_pending_partner_profits_for_invoice(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_pending_partner_profits_for_invoice(uuid) TO service_role;

-- -----------------------------------------------------------------------------
-- 5) purchase_return_atomic: prevent WAC cost_price collapsing to 0
-- -----------------------------------------------------------------------------
DO $m$
DECLARE
  _def text;
  _new text;
  _old_expr text := 'CASE WHEN quantity - _qty > 0 THEN GREATEST(0, round((quantity*COALESCE(cost_price,0) - _qty*COALESCE(_it.cost_price,0))/(quantity - _qty),8)) ELSE cost_price END';
  _new_expr text := 'CASE WHEN quantity - _qty > 0 AND (quantity*COALESCE(cost_price,0) - _qty*COALESCE(_it.cost_price,0)) > 0 THEN round((quantity*COALESCE(cost_price,0) - _qty*COALESCE(_it.cost_price,0))/(quantity - _qty),8) ELSE COALESCE(cost_price,0) END';
BEGIN
  SELECT replace(pg_get_functiondef(p.oid), E'\r', '')
    INTO _def
    FROM pg_proc p
   WHERE p.proname = 'purchase_return_atomic'
     AND p.pronamespace = 'public'::regnamespace;

  IF _def IS NULL THEN
    RAISE EXCEPTION 'purchase_return_atomic not found';
  END IF;

  IF position(_new_expr in _def) > 0 THEN
    RAISE NOTICE 'purchase_return_atomic WAC guard already applied';
  ELSIF position(_old_expr in _def) > 0 THEN
    _new := replace(_def, _old_expr, _new_expr);
    EXECUTE _new;
  ELSE
    RAISE NOTICE 'purchase_return_atomic anchor not matched — inspect live body manually';
  END IF;
END $m$;

-- -----------------------------------------------------------------------------
-- 6) refund_invoice_partial_atomic: support explicit serials[] per item (with LIFO fallback)
-- -----------------------------------------------------------------------------
DO $m$
DECLARE
  _def text;
  _new text;
  _start int;
  _end int;
  _replacement text := $r$  DECLARE _ri record; _sid uuid; _explicit text[]; _released int; -- _refund_serial_release_v2
  BEGIN
    FOR _ri IN
      SELECT (e->>'product_id')::uuid AS pid,
             floor(COALESCE((e->>'quantity')::numeric,0) * COALESCE((SELECT CASE WHEN ii.unit='bulk' THEN GREATEST(COALESCE(ii.conversion_factor,1),1) ELSE 1 END FROM public.invoice_items ii WHERE ii.invoice_id=_inv.id AND ii.product_id=(e->>'product_id')::uuid LIMIT 1),1))::int AS q,
             CASE WHEN jsonb_typeof(e->'serials') = 'array' THEN ARRAY(SELECT lower(trim(x)) FROM jsonb_array_elements_text(e->'serials') x WHERE trim(x) <> '') ELSE NULL END AS req_serials
      FROM jsonb_array_elements(_items) e
      WHERE NULLIF(e->>'product_id','') IS NOT NULL
    LOOP
      IF _ri.q > 0 AND EXISTS (SELECT 1 FROM public.products WHERE id=_ri.pid AND track_serials) THEN
        IF _ri.req_serials IS NOT NULL AND cardinality(_ri.req_serials) > 0 THEN
          IF cardinality(_ri.req_serials) <> _ri.q THEN
            RAISE EXCEPTION 'عدد الأرقام التسلسلية المحددة للاسترداد (%) لا يطابق الكمية (%)', cardinality(_ri.req_serials), _ri.q;
          END IF;
          _released := 0;
          FOR _sid IN
            SELECT id FROM public.product_serials
             WHERE user_id=_owner AND sold_invoice_id=_inv.id AND product_id=_ri.pid AND status='sold'
               AND lower(serial) = ANY(_ri.req_serials)
             FOR UPDATE
          LOOP
            UPDATE public.product_serials SET status='in_stock', sold_invoice_id=NULL, sold_invoice_number=NULL, sold_at=NULL, customer_name=NULL, warranty_until=NULL, updated_at=now() WHERE id=_sid;
            INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) VALUES (_owner,_sid,'customer_return',_inv.invoice_number,auth.uid());
            _released := _released + 1;
          END LOOP;
          IF _released <> cardinality(_ri.req_serials) THEN
            RAISE EXCEPTION 'بعض الأرقام التسلسلية المحددة غير مرتبطة بهذه الفاتورة أو سبق إرجاعها';
          END IF;
        ELSE
          -- الاحتياطي (LIFO) فقط إذا لم تُمرّر أرقام محددة من الواجهة
          FOR _sid IN SELECT id FROM public.product_serials WHERE user_id=_owner AND sold_invoice_id=_inv.id AND product_id=_ri.pid AND status='sold' ORDER BY sold_at DESC, id LIMIT _ri.q FOR UPDATE LOOP
            UPDATE public.product_serials SET status='in_stock', sold_invoice_id=NULL, sold_invoice_number=NULL, sold_at=NULL, customer_name=NULL, warranty_until=NULL, updated_at=now() WHERE id=_sid;
            INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) VALUES (_owner,_sid,'customer_return',_inv.invoice_number,auth.uid());
          END LOOP;
        END IF;
      END IF;
    END LOOP;
  END;
$r$;
BEGIN
  SELECT replace(pg_get_functiondef(p.oid), E'\r', '')
    INTO _def
    FROM pg_proc p
   WHERE p.proname = 'refund_invoice_partial_atomic'
     AND p.pronamespace = 'public'::regnamespace;

  IF _def IS NULL THEN
    RAISE EXCEPTION 'refund_invoice_partial_atomic not found';
  END IF;

  IF position('_refund_serial_release_v2' in _def) > 0 THEN
    RAISE NOTICE 'refund_invoice_partial_atomic explicit serials already applied';
  ELSE
    _start := position('  DECLARE _ri record; _sid uuid; -- _refund_serial_release' in _def);
    _end := position('  IF _inv.customer_id IS NOT NULL THEN' in _def);
    IF _start > 0 AND _end > _start THEN
      _new := left(_def, _start - 1) || _replacement || substring(_def from _end);
      EXECUTE _new;
    ELSE
      RAISE NOTICE 'refund_invoice_partial_atomic serial block anchor not found — inspect live body manually';
    END IF;
  END IF;
END $m$;

-- -----------------------------------------------------------------------------
-- 7) edit_purchase_invoice_atomic:
--    (a) Block edit if any serial belonging to _invoice_id is already sold/removed
--    (b) Preserve original serial letter casing on new serial registration
-- -----------------------------------------------------------------------------
DO $m$
DECLARE
  _def text;
  _new text;
  _guard_anchor text := '  -- 1) عكس أثر الفاتورة القديمة';
  _guard_inject text := E'  IF EXISTS (SELECT 1 FROM public.product_serials WHERE purchase_invoice_id = _invoice_id AND user_id = _owner AND status <> ''in_stock'') THEN\n    RAISE EXCEPTION ''لا يمكن تعديل الفاتورة: بعض أرقامها التسلسلية بيعت أو أُخرجت بالفعل'';\n  END IF;\n  -- 1) عكس أثر الفاتورة القديمة';
BEGIN
  SELECT replace(pg_get_functiondef(p.oid), E'\r', '')
    INTO _def
    FROM pg_proc p
   WHERE p.proname = 'edit_purchase_invoice_atomic'
     AND p.pronamespace = 'public'::regnamespace;

  IF _def IS NULL THEN
    RAISE EXCEPTION 'edit_purchase_invoice_atomic not found';
  END IF;

  _new := _def;

  -- (a) Sold serials guard
  IF position('بعض أرقامها التسلسلية بيعت أو أُخرجت بالفعل' in _new) = 0 THEN
    IF position(_guard_anchor in _new) > 0 THEN
      _new := replace(_new, _guard_anchor, _guard_inject);
    END IF;
  END IF;

  -- (b) Preserve serial casing in _edit_serial_list
  _new := replace(
    _new,
    'SELECT COALESCE(array_agg(DISTINCT lower(trim(x))),''{}''::text[]) INTO _ns FROM jsonb_array_elements_text(_line->''serials'') x WHERE trim(x) <> '''';',
    'SELECT COALESCE(array_agg(DISTINCT trim(x)),''{}''::text[]) INTO _ns FROM jsonb_array_elements_text(_line->''serials'') x WHERE trim(x) <> '''';'
  );
  _new := replace(
    _new,
    'AND lower(ps.serial) <> ALL(_ns);',
    'AND lower(ps.serial) <> ALL(SELECT lower(u) FROM unnest(_ns) u);'
  );
  _new := replace(
    _new,
    'AND lower(serial) <> ALL(_ns);',
    'AND lower(serial) <> ALL(SELECT lower(u) FROM unnest(_ns) u);'
  );
  _new := replace(
    _new,
    'WHERE NOT EXISTS (SELECT 1 FROM public.product_serials ps WHERE ps.user_id=_owner AND ps.product_id=_prod_id AND lower(ps.serial)=s);',
    'WHERE NOT EXISTS (SELECT 1 FROM public.product_serials ps WHERE ps.user_id=_owner AND ps.product_id=_prod_id AND lower(ps.serial)=lower(s));'
  );

  IF _new <> _def THEN
    EXECUTE _new;
  END IF;
END $m$;

-- -----------------------------------------------------------------------------
-- 8) Missing index for Delta Sync on invoices (updated_at)
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_invoices_user_updated_at
  ON public.invoices (user_id, updated_at DESC);

NOTIFY pgrst, 'reload schema';

COMMIT;
