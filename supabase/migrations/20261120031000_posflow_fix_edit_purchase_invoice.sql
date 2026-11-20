-- إصلاح edit_purchase_invoice_atomic: كانت تشير لأعمدة غير موجودة (total_amount, total_items, total_quantity,
-- original_currency, exchange_rate) فتفشل عند أي تنفيذ. + حارس مخزون سالب + ربط replaced_by/edit_reason.
-- التراجع: ROLLBACK_stage_1_2b.sql
CREATE OR REPLACE FUNCTION public.edit_purchase_invoice_atomic(_invoice_id uuid, _new_lines jsonb, _op_id text, _reason text DEFAULT 'Purchase invoice edit')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  _caller uuid := auth.uid(); _owner uuid; _orig_inv record; _existing_id uuid; _new_invoice_id uuid;
  _old_item record; _line jsonb; _prod_id uuid; _prod_qty numeric; _prod_cost numeric;
  _prod_name text; _prod_barcode text; _prod_cat text;
  _cur_stock numeric; _cur_cost numeric; _new_stock numeric; _new_cost numeric;
  _items_count int := 0; _total_qty numeric := 0; _grand_total numeric := 0;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN RAISE EXCEPTION 'owner not found'; END IF;

  SELECT id INTO _existing_id FROM public.purchase_invoices WHERE operation_id = _op_id AND user_id = _owner;
  IF _existing_id IS NOT NULL THEN RETURN _existing_id; END IF;

  SELECT * INTO _orig_inv FROM public.purchase_invoices WHERE id = _invoice_id AND user_id = _owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original invoice not found'; END IF;
  IF COALESCE(_orig_inv.payment_status,'') = 'cancelled' OR _orig_inv.replaced_by IS NOT NULL THEN
    RAISE EXCEPTION 'الفاتورة ملغاة أو سبق استبدالها';
  END IF;
  PERFORM public.assert_period_open(_owner, _orig_inv.invoice_date::date, 'تعديل فاتورة الشراء');
  PERFORM set_config('app.stock_movement_type','purchase_edit',true);
  PERFORM set_config('app.stock_actor_id',_caller::text,true);
  PERFORM set_config('app.stock_source','edit_purchase_invoice_atomic',true);

  -- 1) عكس أثر الفاتورة القديمة (ممنوع أن ينزل المخزون تحت الصفر: يعني أن جزءاً منه بيع)
  FOR _old_item IN SELECT * FROM public.purchase_invoice_items WHERE invoice_id = _invoice_id LOOP
    SELECT quantity, cost_price INTO _cur_stock, _cur_cost FROM public.products WHERE id = _old_item.product_id AND user_id = _owner FOR UPDATE;
    IF FOUND THEN
      IF COALESCE(_cur_stock,0) < COALESCE(_old_item.quantity,0) THEN
        RAISE EXCEPTION 'لا يمكن تعديل الفاتورة: جزء من كمية "%" بيع أو أُخرج من المخزون', _old_item.product_name;
      END IF;
      _new_stock := COALESCE(_cur_stock,0) - COALESCE(_old_item.quantity,0);
      IF _old_item.cost_price_before IS NOT NULL THEN _new_cost := _old_item.cost_price_before;
      ELSIF _new_stock > 0 THEN
        _new_cost := GREATEST(0, ((COALESCE(_cur_stock,0)*COALESCE(_cur_cost,0)) - (COALESCE(_old_item.quantity,0)*COALESCE(_old_item.cost_price,0))) / _new_stock);
      ELSE _new_cost := COALESCE(_cur_cost,0); END IF;
      UPDATE public.products SET quantity=_new_stock, cost_price=_new_cost, updated_at=now() WHERE id=_old_item.product_id;
    END IF;
  END LOOP;

  -- 2) الفاتورة الجديدة
  INSERT INTO public.purchase_invoices (user_id, invoice_number, supplier_name, supplier_company, invoice_date, status, notes,
      payment_status, payment_method, operation_id, edit_reason)
  VALUES (_owner, _orig_inv.invoice_number||'-E', _orig_inv.supplier_name, _orig_inv.supplier_company, now(), COALESCE(_orig_inv.status,'completed'),
      COALESCE(_reason,'تعديل الفاتورة '||_orig_inv.invoice_number), _orig_inv.payment_status, _orig_inv.payment_method, _op_id, _reason)
  RETURNING id INTO _new_invoice_id;

  -- 3) البنود الجديدة + WAC
  FOR _line IN SELECT * FROM jsonb_array_elements(_new_lines) LOOP
    _prod_id := (_line->>'product_id')::uuid;
    _prod_qty := GREATEST(0,(_line->>'quantity')::numeric);
    _prod_cost := GREATEST(0,(_line->>'cost_price')::numeric);
    _prod_name := COALESCE(_line->>'product_name','صنف'); _prod_barcode := _line->>'barcode'; _prod_cat := _line->>'category';
    SELECT quantity, cost_price INTO _cur_stock, _cur_cost FROM public.products WHERE id=_prod_id AND user_id=_owner FOR UPDATE;
    IF FOUND THEN
      _new_stock := COALESCE(_cur_stock,0) + _prod_qty;
      _new_cost := CASE WHEN _new_stock > 0 THEN ((COALESCE(_cur_stock,0)*COALESCE(_cur_cost,0)) + (_prod_qty*_prod_cost)) / _new_stock ELSE _prod_cost END;
      UPDATE public.products SET quantity=_new_stock, cost_price=_new_cost, updated_at=now() WHERE id=_prod_id;
      INSERT INTO public.purchase_invoice_items(invoice_id, product_id, product_name, barcode, category, quantity, cost_price, cost_price_before, sale_price, total_cost)
      VALUES (_new_invoice_id, _prod_id, _prod_name, _prod_barcode, _prod_cat, _prod_qty, _prod_cost, _cur_cost, (_line->>'sale_price')::numeric, _prod_qty*_prod_cost);
      _items_count := _items_count + 1; _total_qty := _total_qty + _prod_qty; _grand_total := _grand_total + (_prod_qty*_prod_cost);
    END IF;
  END LOOP;

  UPDATE public.purchase_invoices SET actual_items_count=_items_count, actual_total_quantity=_total_qty, actual_grand_total=_grand_total,
         expected_items_count=_items_count, expected_total_quantity=_total_qty, expected_grand_total=_grand_total, updated_at=now()
   WHERE id=_new_invoice_id;
  UPDATE public.purchase_invoices SET payment_status='cancelled', replaced_by=_new_invoice_id, edit_reason=_reason, updated_at=now(),
         notes=COALESCE(notes,'')||' [تم استبدالها بـ '||_orig_inv.invoice_number||'-E]' WHERE id=_invoice_id;
  RETURN _new_invoice_id;
END $function$;
REVOKE ALL ON FUNCTION public.edit_purchase_invoice_atomic(uuid,jsonb,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_purchase_invoice_atomic(uuid,jsonb,text,text) TO authenticated, service_role;

SELECT (pg_get_functiondef('public.edit_purchase_invoice_atomic'::regproc) NOT LIKE '%total_amount%') AS check_edit_purchase_columns;
