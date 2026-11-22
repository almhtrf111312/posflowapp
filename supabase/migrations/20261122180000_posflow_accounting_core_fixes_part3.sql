-- =============================================================================
-- Migration: 20261122180000_posflow_accounting_core_fixes_part3.sql
-- Scope: Purchase Finalization, Cancellation, Returns, and Supplier Drawer/FX Guards
-- =============================================================================

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

  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'اعتماد فاتورة الشراء مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
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

  IF _inv.status = 'finalized' THEN
    RETURN jsonb_build_object('success', true, 'already_finalized', true, 'invoice_id', _invoice_id);
  END IF;

  IF COALESCE(_inv.status, 'draft') NOT IN ('draft', 'reconciled') THEN
    RAISE EXCEPTION 'Purchase invoice cannot be finalized from status %', _inv.status;
  END IF;

  PERFORM public.assert_period_open(_owner, COALESCE(_inv.invoice_date::date, CURRENT_DATE), 'اعتماد فاتورة شراء');

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

  DECLARE _sr record;
  BEGIN
    FOR _sr IN SELECT i.product_id, i.quantity, i.cost_price, i.serials, p.track_serials, p.name FROM public.purchase_invoice_items i JOIN public.products p ON p.id=i.product_id WHERE i.invoice_id=_invoice_id AND (p.track_serials OR cardinality(COALESCE(i.serials,'{}'::text[]))>0) LOOP
      IF _sr.track_serials AND cardinality(COALESCE(_sr.serials,'{}'::text[])) = 0 THEN RAISE EXCEPTION 'المنتج % يتطلب إدخال أرقام تسلسلية', _sr.name; END IF;
      PERFORM public._register_serials(_owner,_sr.product_id,_sr.serials,_sr.cost_price,_invoice_id,_sr.quantity);
      UPDATE public.products SET track_serials=true WHERE id=_sr.product_id AND NOT track_serials;
    END LOOP;
  END;

  IF _inv.supplier_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.supplier_ledger_entries
        WHERE reference_type = 'purchase_invoice'
          AND reference_id = _invoice_id::text
          AND entry_type = 'purchase'
     ) THEN
    DECLARE _tot numeric; _paid numeric := COALESCE(_inv.amount_paid,0);
    BEGIN
      SELECT COALESCE(SUM(quantity*COALESCE(cost_price,0)),0) INTO _tot FROM public.purchase_invoice_items WHERE invoice_id=_invoice_id;
      IF _paid > _tot + 0.0001 THEN RAISE EXCEPTION 'المدفوع أكبر من إجمالي الفاتورة'; END IF;
      IF _paid > 0 AND _inv.paid_from = 'drawer' THEN
        PERFORM public._supplier_drawer_tx(_owner,_inv.paid_shift_id,'supplier_payment',_paid,_inv.paid_currency,_inv.paid_currency_amount,_inv.paid_rate,'purchase:'||_invoice_id::text,'دفعة فاتورة شراء '||COALESCE(_inv.invoice_number,''));
      END IF;
      IF round(_tot, 4) > 0 THEN
        INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,reference_id,note,created_by)
        VALUES (_owner,_inv.supplier_id,'purchase',round(_tot,4),'purchase_invoice',_invoice_id::text,'فاتورة شراء '||COALESCE(_inv.invoice_number,''),_caller);
      END IF;
      IF _paid > 0 THEN
        INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,reference_id,payment_method,payment_source,shift_id,note,created_by)
        VALUES (_owner,_inv.supplier_id,'payment',-round(_paid,4),'purchase_invoice',_invoice_id::text,_inv.payment_method,COALESCE(_inv.paid_from,'external'),CASE WHEN _inv.paid_from='drawer' THEN _inv.paid_shift_id END,'دفعة عند الشراء '||COALESCE(_inv.invoice_number,''),_caller);
      END IF;
    END;
  END IF;
  RETURN jsonb_build_object('success', true, 'already_finalized', false, 'invoice_id', _invoice_id, 'items', _count);
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_purchase_invoice_atomic(_invoice_id uuid, _reason text DEFAULT 'إلغاء فاتورة شراء'::text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _orig_inv record;
  _old_item record;
  _cur_stock numeric;
  _cur_cost numeric;
  _new_stock numeric;
  _new_cost numeric;
  _rem_val numeric;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'إلغاء فاتورة الشراء مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _orig_inv
    FROM public.purchase_invoices
   WHERE id = _invoice_id AND user_id = _owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'فاتورة المشتريات غير موجودة';
  END IF;

  IF _orig_inv.status = 'cancelled' OR _orig_inv.payment_status = 'cancelled' THEN
    RETURN true;
  END IF;

  PERFORM public.assert_period_open(_owner, _orig_inv.invoice_date, 'إلغاء فاتورة الشراء');

  IF COALESCE(_orig_inv.status, 'draft') IN ('draft', 'reconciled') THEN
    UPDATE public.purchase_invoices
       SET status = 'cancelled',
           payment_status = 'cancelled',
           notes = concat_ws(E'\n', notes, '[ملغاة] ' || COALESCE(_reason, 'إلغاء الفاتورة')),
           updated_at = now()
     WHERE id = _invoice_id;
    RETURN true;
  END IF;

  IF EXISTS (SELECT 1 FROM public.purchase_returns WHERE invoice_id = _invoice_id) THEN
    RAISE EXCEPTION 'لا يمكن إلغاء فاتورة لها مرتجعات';
  END IF;

  IF EXISTS (SELECT 1 FROM public.product_serials WHERE purchase_invoice_id=_invoice_id AND user_id=_owner AND status <> 'in_stock') THEN
    RAISE EXCEPTION 'لا يمكن إلغاء الفاتورة: بعض أرقامها التسلسلية بيعت أو أُخرجت';
  END IF;

  FOR _old_item IN
    SELECT * FROM public.purchase_invoice_items
     WHERE invoice_id = _invoice_id
  LOOP
    IF _old_item.product_id IS NOT NULL THEN
      SELECT quantity, cost_price
        INTO _cur_stock, _cur_cost
        FROM public.products
       WHERE id = _old_item.product_id AND user_id = _owner
         FOR UPDATE;

      IF FOUND THEN
        IF COALESCE(_cur_stock,0) < COALESCE(_old_item.quantity,0) THEN
          RAISE EXCEPTION 'لا يمكن إلغاء الفاتورة: جزء من كمية "%" بيع أو أُخرج من المخزون', _old_item.product_name;
        END IF;
        _new_stock := COALESCE(_cur_stock, 0) - COALESCE(_old_item.quantity, 0);
        _rem_val := (COALESCE(_cur_stock, 0) * COALESCE(_cur_cost, 0)) - (COALESCE(_old_item.quantity, 0) * COALESCE(_old_item.cost_price, 0));

        IF _new_stock > 0 AND _rem_val > 0 THEN
          _new_cost := round(_rem_val / _new_stock, 8);
        ELSIF _old_item.cost_price_before IS NOT NULL THEN
          _new_cost := _old_item.cost_price_before;
        ELSE
          _new_cost := COALESCE(_cur_cost, 0);
        END IF;

        PERFORM set_config('app.stock_movement_type', 'purchase_reversal', true);
        PERFORM set_config('app.stock_source', 'cancel_purchase_invoice', true);
        UPDATE public.products
           SET quantity = _new_stock,
               cost_price = _new_cost,
               updated_at = now()
         WHERE id = _old_item.product_id;
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,reference_id,note,created_by)
  SELECT user_id,supplier_id,'adjustment',-amount,'purchase_cancel',reference_id,'عكس بسبب إلغاء الفاتورة',_caller
  FROM public.supplier_ledger_entries
  WHERE reference_type='purchase_invoice' AND reference_id=_invoice_id::text AND entry_type IN ('purchase','payment');

  IF COALESCE(_orig_inv.amount_paid,0) > 0 AND _orig_inv.paid_from = 'drawer' THEN
    DECLARE _t record;
    BEGIN
      SELECT currency, currency_amount, exchange_rate INTO _t FROM public.shift_transactions WHERE reference_id = 'purchase:'||_invoice_id::text AND type = 'supplier_payment' LIMIT 1;
      PERFORM public._supplier_drawer_tx(_owner, _orig_inv.paid_shift_id, 'supplier_refund', _orig_inv.amount_paid, _t.currency, _t.currency_amount, _t.exchange_rate, 'purchase_cancel:'||_invoice_id::text, 'إلغاء فاتورة شراء '||COALESCE(_orig_inv.invoice_number,''));
    END;
  END IF;

  UPDATE public.product_serials SET status='returned_to_supplier', updated_at=now() WHERE purchase_invoice_id=_invoice_id AND user_id=_owner AND status='in_stock';

  UPDATE public.purchase_invoices
     SET status = 'cancelled',
         payment_status = 'cancelled',
         notes = concat_ws(E'\n', notes, '[ملغاة] ' || COALESCE(_reason, 'إلغاء الفاتورة')),
         updated_at = now()
   WHERE id = _invoice_id;

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.purchase_return_atomic(_invoice_id uuid, _lines jsonb, _reason text, _operation_id text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _o uuid := public._supplier_owner(); _inv record; _rid uuid; _l jsonb; _it record; _qty numeric; _returned numeric; _stock numeric;
  _total numeric := 0; _num text;
BEGIN
  IF COALESCE(_operation_id,'') = '' THEN RAISE EXCEPTION 'معرّف العملية مطلوب'; END IF;
  SELECT id INTO _rid FROM public.purchase_returns WHERE user_id=_o AND operation_id=_operation_id;
  IF _rid IS NOT NULL THEN RETURN _rid; END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN RAISE EXCEPTION 'لا توجد بنود للمرتجع'; END IF;
  SELECT * INTO _inv FROM public.purchase_invoices WHERE id=_invoice_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'فاتورة الشراء غير موجودة'; END IF;
  IF COALESCE(_inv.payment_status,'') = 'cancelled' OR COALESCE(_inv.status,'') = 'cancelled' THEN RAISE EXCEPTION 'الفاتورة ملغاة'; END IF;
  IF COALESCE(_inv.status, 'draft') NOT IN ('finalized', 'completed') THEN RAISE EXCEPTION 'لا يمكن عمل مرتجع لفاتورة شراء غير معتمدة'; END IF;
  IF _inv.replaced_by IS NOT NULL THEN RAISE EXCEPTION 'الفاتورة استُبدلت بفاتورة معدّلة'; END IF;
  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'مرتجع مشتريات');
  _num := 'PR-' || to_char(now(),'YYYYMMDD') || '-' || substr(gen_random_uuid()::text,1,6);
  INSERT INTO public.purchase_returns(user_id,invoice_id,supplier_id,return_number,total_amount,reason,operation_id,created_by)
  VALUES (_o,_invoice_id,_inv.supplier_id,_num,0,_reason,_operation_id,auth.uid()) RETURNING id INTO _rid;
  PERFORM set_config('app.stock_movement_type','purchase_return',true);
  PERFORM set_config('app.stock_actor_id',auth.uid()::text,true);
  PERFORM set_config('app.stock_source','purchase_return_atomic',true);
  FOR _l IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _qty := (_l->>'quantity')::numeric;
    IF _qty IS NULL OR _qty <= 0 THEN RAISE EXCEPTION 'كمية غير صالحة'; END IF;
    SELECT * INTO _it FROM public.purchase_invoice_items WHERE id=(_l->>'item_id')::uuid AND invoice_id=_invoice_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'بند غير تابع للفاتورة'; END IF;
    SELECT COALESCE(SUM(quantity),0) INTO _returned FROM public.purchase_return_items WHERE invoice_item_id=_it.id;
    IF _returned + _qty > _it.quantity THEN RAISE EXCEPTION 'كمية المرتجع من "%" تتجاوز المشتراة (المتبقي %)', _it.product_name, _it.quantity - _returned; END IF;
    IF _it.product_id IS NOT NULL THEN
      SELECT quantity INTO _stock FROM public.products WHERE id=_it.product_id AND user_id=_o FOR UPDATE;
      IF FOUND THEN
        IF COALESCE(_stock,0) < _qty THEN RAISE EXCEPTION 'مخزون "%" أقل من كمية المرتجع (بيع جزء منه)', _it.product_name; END IF;
        UPDATE public.products SET cost_price = CASE WHEN quantity - _qty > 0 AND (quantity*COALESCE(cost_price,0) - _qty*COALESCE(_it.cost_price,0)) > 0 THEN round((quantity*COALESCE(cost_price,0) - _qty*COALESCE(_it.cost_price,0))/(quantity - _qty),8) ELSE COALESCE(cost_price,0) END, quantity = round(quantity - _qty,3), updated_at=now() WHERE id=_it.product_id;
      END IF;
    END IF;
    IF _it.product_id IS NOT NULL AND (SELECT track_serials FROM public.products WHERE id=_it.product_id) THEN
      DECLARE _ser text[]; _cnt int;
      BEGIN
        SELECT COALESCE(array_agg(x),'{}'::text[]) INTO _ser FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(_l->'serials')='array' THEN _l->'serials' ELSE '[]'::jsonb END) x;
        IF cardinality(_ser) <> _qty THEN RAISE EXCEPTION 'المنتج "%" يتطلب تحديد % رقم تسلسلي للمرتجع', _it.product_name, _qty; END IF;
        UPDATE public.product_serials ps SET status='returned_to_supplier', updated_at=now()
         WHERE ps.user_id=_o AND ps.product_id=_it.product_id AND ps.status='in_stock'
           AND (ps.purchase_invoice_id = _invoice_id OR ps.purchase_invoice_id IS NULL)
           AND lower(ps.serial)=ANY(SELECT lower(trim(y)) FROM unnest(_ser) y);
        GET DIAGNOSTICS _cnt = ROW_COUNT;
        IF _cnt <> cardinality(_ser) THEN RAISE EXCEPTION 'رقم تسلسلي غير متوفر في المخزون أو غير تابع لهذه الفاتورة للمنتج "%"', _it.product_name; END IF;
        INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor)
        SELECT _o, ps.id, 'returned_to_supplier', _num, auth.uid()
          FROM public.product_serials ps
         WHERE ps.user_id=_o AND ps.product_id=_it.product_id AND ps.status='returned_to_supplier'
           AND (ps.purchase_invoice_id = _invoice_id OR ps.purchase_invoice_id IS NULL)
           AND lower(ps.serial)=ANY(SELECT lower(trim(y)) FROM unnest(_ser) y);
      END;
    END IF;
    INSERT INTO public.purchase_return_items(return_id,invoice_item_id,product_id,product_name,quantity,unit_cost,total_cost)
    VALUES (_rid,_it.id,_it.product_id,_it.product_name,_qty,COALESCE(_it.cost_price,0),round(_qty*COALESCE(_it.cost_price,0),4));
    _total := _total + round(_qty*COALESCE(_it.cost_price,0),4);
  END LOOP;
  UPDATE public.purchase_returns SET total_amount=_total WHERE id=_rid;
  IF _inv.supplier_id IS NOT NULL AND _total > 0 THEN
    INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,reference_id,note,operation_id,created_by)
    VALUES (_o,_inv.supplier_id,'purchase_return',-_total,'purchase_return',_rid::text,'مرتجع '||_num||' للفاتورة '||_inv.invoice_number,_operation_id,auth.uid());
  END IF;
  RETURN _rid;
END $function$;

CREATE OR REPLACE FUNCTION public.pay_supplier_atomic(_supplier_id uuid, _amount numeric, _method text, _note text, _operation_id text, _source text DEFAULT 'external'::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT 'USD'::text, _currency_amount numeric DEFAULT NULL::numeric, _rate numeric DEFAULT NULL::numeric)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _o uuid := public._supplier_owner();
  _id uuid;
  _ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  _eff_rate numeric;
  _eff_ccy_amt numeric;
BEGIN
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  IF COALESCE(_operation_id,'') = '' THEN RAISE EXCEPTION 'معرّف العملية مطلوب'; END IF;
  IF _source NOT IN ('drawer','external') THEN RAISE EXCEPTION 'مصدر الدفع غير صالح'; END IF;
  IF _source = 'drawer' AND _shift_id IS NULL THEN RAISE EXCEPTION 'الدفع من الصندوق يتطلب وردية مفتوحة'; END IF;

  IF _ccy = 'USD' THEN
    _eff_rate := 1;
    _eff_ccy_amt := round(_amount, 4);
  ELSE
    _eff_rate := COALESCE(_rate, (SELECT NULLIF((ss.exchange_rates->>_ccy)::numeric, 0) FROM public.store_settings ss WHERE ss.user_id = _o LIMIT 1));
    IF _eff_rate IS NULL OR _eff_rate <= 0 THEN RAISE EXCEPTION 'سعر صرف العملة % غير صالح', _ccy; END IF;
    _eff_ccy_amt := round(COALESCE(NULLIF(_currency_amount, 0), _amount * _eff_rate), 4);
    IF _eff_ccy_amt <= 0 THEN RAISE EXCEPTION 'مبلغ العملة % غير صالح', _ccy; END IF;
  END IF;

  PERFORM 1 FROM public.suppliers WHERE id=_supplier_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'المورد غير موجود'; END IF;
  SELECT id INTO _id FROM public.supplier_ledger_entries WHERE user_id=_o AND operation_id=_operation_id AND entry_type='payment';
  IF _id IS NOT NULL THEN RETURN _id; END IF;
  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'دفعة لمورد');
  IF _amount > COALESCE((SELECT SUM(amount) FROM public.supplier_ledger_entries WHERE supplier_id=_supplier_id),0) + 0.0001 THEN
    RAISE EXCEPTION 'الدفعة أكبر من المستحق للمورد';
  END IF;
  IF _source = 'drawer' THEN
    PERFORM 1 FROM public.cash_shifts WHERE id = _shift_id AND user_id = _o AND closed_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر'; END IF;
    PERFORM public._supplier_drawer_tx(_o,_shift_id,'supplier_payment',_amount,_ccy,_eff_ccy_amt,_eff_rate,_operation_id,'دفعة مورد من الصندوق');
  END IF;
  INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,payment_method,payment_source,shift_id,note,operation_id,created_by)
  VALUES (_o,_supplier_id,'payment',-round(_amount,4),'supplier_payment',_method,_source,CASE WHEN _source='drawer' THEN _shift_id END,_note,_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END $function$;

CREATE OR REPLACE FUNCTION public.supplier_refund_atomic(_supplier_id uuid, _amount numeric, _method text, _note text, _operation_id text, _source text DEFAULT 'external'::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT 'USD'::text, _currency_amount numeric DEFAULT NULL::numeric, _rate numeric DEFAULT NULL::numeric)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _o uuid := public._supplier_owner();
  _id uuid;
  _bal numeric;
  _ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  _eff_rate numeric;
  _eff_ccy_amt numeric;
BEGIN
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  IF COALESCE(_operation_id,'') = '' THEN RAISE EXCEPTION 'معرّف العملية مطلوب'; END IF;
  IF _source NOT IN ('drawer','external') THEN RAISE EXCEPTION 'جهة الاستلام غير صالحة'; END IF;
  IF _source = 'drawer' AND _shift_id IS NULL THEN RAISE EXCEPTION 'الاستلام في الصندوق يتطلب وردية مفتوحة'; END IF;

  IF _ccy = 'USD' THEN
    _eff_rate := 1;
    _eff_ccy_amt := round(_amount, 4);
  ELSE
    _eff_rate := COALESCE(_rate, (SELECT NULLIF((ss.exchange_rates->>_ccy)::numeric, 0) FROM public.store_settings ss WHERE ss.user_id = _o LIMIT 1));
    IF _eff_rate IS NULL OR _eff_rate <= 0 THEN RAISE EXCEPTION 'سعر صرف العملة % غير صالح', _ccy; END IF;
    _eff_ccy_amt := round(COALESCE(NULLIF(_currency_amount, 0), _amount * _eff_rate), 4);
    IF _eff_ccy_amt <= 0 THEN RAISE EXCEPTION 'مبلغ العملة % غير صالح', _ccy; END IF;
  END IF;

  PERFORM 1 FROM public.suppliers WHERE id=_supplier_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'المورد غير موجود'; END IF;
  SELECT id INTO _id FROM public.supplier_ledger_entries WHERE user_id=_o AND operation_id=_operation_id AND entry_type='refund';
  IF _id IS NOT NULL THEN RETURN _id; END IF;
  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'استرداد من مورد');
  SELECT COALESCE(SUM(amount),0) INTO _bal FROM public.supplier_ledger_entries WHERE supplier_id=_supplier_id;
  IF _amount > -_bal + 0.0001 THEN RAISE EXCEPTION 'الاسترداد أكبر من الرصيد الدائن لنا عند المورد (%)', round(-_bal,2); END IF;
  IF _source = 'drawer' THEN
    PERFORM 1 FROM public.cash_shifts WHERE id = _shift_id AND user_id = _o AND closed_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر'; END IF;
    PERFORM public._supplier_drawer_tx(_o,_shift_id,'supplier_refund',_amount,_ccy,_eff_ccy_amt,_eff_rate,_operation_id,'استرداد من مورد إلى الصندوق');
  END IF;
  INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,payment_method,payment_source,shift_id,note,operation_id,created_by)
  VALUES (_o,_supplier_id,'refund',round(_amount,4),'supplier_refund',_method,_source,CASE WHEN _source='drawer' THEN _shift_id END,_note,_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END $function$;

NOTIFY pgrst, 'reload schema';
