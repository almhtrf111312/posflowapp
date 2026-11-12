-- refund_invoice_partial_atomic(_invoice_number text, _items jsonb, _operation_id text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.refund_invoice_partial_atomic(_invoice_number text, _items jsonb, _operation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE; _owner uuid; _item jsonb; _pid uuid; _pname text; _qty numeric; _avail numeric;
  _line record; _take numeric; _factor numeric;
  _gross numeric := 0; _refund numeric := 0; _cogs numeric := 0; _restored numeric := 0;
  _new_sub numeric; _new_disc numeric; _new_tax numeric; _new_total numeric; _new_profit numeric;
  _remaining_units numeric; _full boolean; _debt_red numeric := 0; _cash numeric := 0; _new_debt numeric;
  _profit_ratio numeric := 0;
  _f numeric := 1;
  _disc_ratio numeric := 0;
  _profit_red numeric := 0;
  _unit_factor numeric := 1;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _owner := public.get_owner_id(auth.uid());

  -- المرحلة 1: الاسترداد لمالك المتجر أو لكاشير منحه المالك الصلاحية
  IF NOT public.can_refund_invoices(auth.uid()) THEN
    RAISE EXCEPTION 'ليست لديك صلاحية الاسترداد. اطلبها من مالك المتجر' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO _inv FROM public.invoices WHERE invoice_number=_invoice_number AND user_id=_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','invoice_not_found'); END IF;
  IF _inv.status='refunded' THEN
    RETURN jsonb_build_object('success',true,'already_refunded',true,'invoice_id',_inv.id,'invoice_number',_inv.invoice_number,'new_total',_inv.total);
  END IF;
  IF _operation_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.activity_log WHERE user_id=_owner AND action_type='partial_refund' AND metadata->>'operation_id'=_operation_id) THEN
    RETURN jsonb_build_object('success',true,'already_processed',true,'invoice_id',_inv.id,'invoice_number',_inv.invoice_number,'new_total',_inv.total,'new_profit',_inv.profit,'new_debt_remaining',_inv.debt_remaining);
  END IF;

  -- لا يُسترد بيع يقع داخل فترة محاسبية مغلقة
  PERFORM public.assert_period_open(_owner, _inv.date, 'الاسترداد الجزئي');

  _factor := CASE WHEN COALESCE(_inv.subtotal,0) > 0 THEN COALESCE(_inv.total,0)/_inv.subtotal ELSE 1 END;
  -- الضريبة ليست ربحاً: معامل استخراج صافي الإيراد في وضع الضريبة الشاملة
  IF COALESCE(_inv.tax_inclusive, false) AND COALESCE(_inv.tax_rate, 0) > 0 THEN
    _f := 1 / (1 + _inv.tax_rate / 100);
  END IF;
  -- نسبة الخصم على الفاتورة توزَّع تناسبياً على البنود
  IF COALESCE(_inv.subtotal,0) > 0 THEN
    _disc_ratio := LEAST(GREATEST(COALESCE(_inv.discount,0) / _inv.subtotal, 0), 1);
  END IF;

  PERFORM set_config('app.stock_movement_type','partial_refund',true);
  PERFORM set_config('app.stock_invoice_id',_inv.id::text,true);
  PERFORM set_config('app.stock_invoice_number',_inv.invoice_number,true);
  PERFORM set_config('app.stock_actor_id',auth.uid()::text,true);
  PERFORM set_config('app.stock_source','partial_refund',true);

  FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_items,'[]'::jsonb)) LOOP
    _pid := NULLIF(_item->>'product_id','')::uuid;
    _pname := NULLIF(regexp_replace(trim(COALESCE(_item->>'product_name','')),'\s+',' ','g'),'');
    _qty := round(COALESCE(NULLIF(_item->>'quantity','')::numeric,0),3);
    IF _qty <= 0 THEN CONTINUE; END IF;

    SELECT COALESCE(SUM(quantity),0) INTO _avail FROM public.invoice_items ii
    WHERE ii.invoice_id=_inv.id AND ((_pid IS NOT NULL AND ii.product_id=_pid) OR (_pid IS NULL AND regexp_replace(trim(ii.product_name),'\s+',' ','g')=_pname));
    IF _avail < _qty THEN RAISE EXCEPTION 'Refund quantity % exceeds remaining % for %',_qty,_avail,COALESCE(_pname,'item'); END IF;

    FOR _line IN SELECT * FROM public.invoice_items ii
      WHERE ii.invoice_id=_inv.id AND ii.quantity>0 AND ((_pid IS NOT NULL AND ii.product_id=_pid) OR (_pid IS NULL AND regexp_replace(trim(ii.product_name),'\s+',' ','g')=_pname))
      ORDER BY ii.id FOR UPDATE
    LOOP
      EXIT WHEN _qty <= 0;
      _take := LEAST(_qty, _line.quantity);
      UPDATE public.invoice_items SET quantity=quantity-_take,
        amount_original=round(COALESCE(unit_price,0)*(quantity-_take),8),
        amount_usd=round(COALESCE(unit_price,0)*(quantity-_take),8),
        profit=round(COALESCE(unit_price,0)*(quantity-_take)*(1-_disc_ratio)*_f - COALESCE(cost_price,0)*(quantity-_take),8)
      WHERE id=_line.id;
      -- الكرتونة: تُعاد إلى المخزون بعدد القطع (الكمية × معامل التحويل)
      _unit_factor := CASE WHEN COALESCE(_line.unit,'piece') = 'bulk' THEN GREATEST(COALESCE(_line.conversion_factor,1),1) ELSE 1 END;
      _gross := _gross + _take*COALESCE(_line.unit_price,0);
      _cogs := _cogs + _take*COALESCE(_line.cost_price,0);
      IF _line.product_id IS NOT NULL THEN
        IF _line.stock_warehouse_id IS NOT NULL THEN
          UPDATE public.warehouse_stock SET quantity=COALESCE(quantity,0)+_take*_unit_factor,last_updated=now()
          WHERE warehouse_id=_line.stock_warehouse_id AND product_id=_line.product_id;
          IF NOT FOUND THEN
            UPDATE public.products SET quantity=COALESCE(quantity,0)+_take*_unit_factor WHERE id=_line.product_id AND user_id=_owner;
          END IF;
        ELSE
          UPDATE public.products SET quantity=COALESCE(quantity,0)+_take*_unit_factor WHERE id=_line.product_id AND user_id=_owner;
        END IF;
      END IF;
      _restored := _restored + _take;
      _qty := _qty - _take;
    END LOOP;
  END LOOP;

  IF _restored <= 0 THEN RAISE EXCEPTION 'No items selected for refund'; END IF;

  _refund := round(_gross*_factor,8);
  -- الربح المعكوس = صافي الإيراد المرتجع (بعد الخصم ودون الضريبة) − تكلفته
  _profit_red := round(_gross*(1-_disc_ratio)*_f - _cogs, 8);
  _new_sub := GREATEST(round(COALESCE(_inv.subtotal,0)-_gross,8),0);
  IF COALESCE(_inv.subtotal,0) > 0 THEN
    _new_disc := round(COALESCE(_inv.discount,0)*_new_sub/_inv.subtotal,8);
    _new_tax := round(COALESCE(_inv.tax_amount,0)*_new_sub/_inv.subtotal,8);
  ELSE _new_disc := 0; _new_tax := 0; END IF;
  _new_total := GREATEST(round(COALESCE(_inv.total,0)-_refund,8),0);
  _new_profit := round(COALESCE(_inv.profit,0)-_profit_red,8);

  SELECT COALESCE(SUM(quantity),0) INTO _remaining_units FROM public.invoice_items WHERE invoice_id=_inv.id;
  _full := _remaining_units <= 0;
  IF _full THEN _new_total := 0; _new_profit := 0; _new_sub := 0; _new_disc := 0; _new_tax := 0; END IF;

  -- نسبة الربح المعكوس مقارنة بإجمالي ربح الفاتورة الأصلي
  IF COALESCE(_inv.profit, 0) <> 0 THEN
    -- يعمل للربح والخسارة معاً (النسبة موجبة في الحالتين)
    _profit_ratio := LEAST(GREATEST(_profit_red / _inv.profit, 0.0), 1.0);
  ELSE
    _profit_ratio := CASE WHEN _full THEN 1.0 ELSE LEAST(GREATEST(_refund / GREATEST(COALESCE(_inv.total, 1), 1), 0.0), 1.0) END;
  END IF;

  IF _inv.payment_type='debt' THEN
    _debt_red := LEAST(_refund, GREATEST(COALESCE(_inv.debt_remaining,0),0));
    _cash := round(_refund-_debt_red,8);
  ELSE
    _cash := _refund;
  END IF;
  _new_debt := CASE WHEN _inv.payment_type='debt' THEN GREATEST(round(COALESCE(_inv.debt_remaining,0)-_debt_red,8),0) ELSE COALESCE(_inv.debt_remaining,0) END;

  IF _full THEN PERFORM set_config('app.refund_context','allowed',true); END IF;
  UPDATE public.invoices SET subtotal=_new_sub, discount=_new_disc, tax_amount=_new_tax, total=_new_total, profit=_new_profit,
    debt_remaining=_new_debt,
    status=CASE WHEN _full THEN 'refunded' WHEN payment_type='debt' AND _new_debt<=0 THEN 'paid' ELSE status END,
    notes=concat_ws(E'\n',NULLIF(notes,''),'Partial refund '||_refund::text||' at '||now()::text),
    updated_at=now()
  WHERE id=_inv.id;

  -- ✅ عكس أرباح الشركاء جزئياً بنسبة المرتجع الفعلي ذرياً
  IF _profit_ratio > 0 THEN
    PERFORM public.revert_invoice_partner_profits_atomic(_inv.id, _profit_ratio);
  END IF;

  IF _inv.payment_type='debt' THEN
    IF _full THEN
      DELETE FROM public.debts WHERE user_id=_owner AND (invoice_id=_inv.invoice_number OR invoice_id=_inv.id::text);
    ELSIF _debt_red > 0 THEN
      UPDATE public.debts SET total_debt=GREATEST(round(COALESCE(total_debt,0)-_debt_red,8),0),
        remaining_debt=GREATEST(round(COALESCE(remaining_debt,0)-_debt_red,8),0),
        status=CASE WHEN GREATEST(round(COALESCE(remaining_debt,0)-_debt_red,8),0)<=0 THEN 'fully_paid' ELSE status END,
        updated_at=now()
      WHERE user_id=_owner AND (invoice_id=_inv.invoice_number OR invoice_id=_inv.id::text);
    END IF;
  END IF;

  IF _inv.customer_id IS NOT NULL THEN
    UPDATE public.customers c SET total_purchases=s.tp,total_debt=s.td,invoice_count=s.ic,updated_at=now()
    FROM (SELECT COALESCE(SUM(i.total) FILTER (WHERE i.status NOT IN ('refunded','cancelled')),0)::numeric tp,
      COALESCE(SUM(i.debt_remaining) FILTER (WHERE i.status NOT IN ('refunded','cancelled','paid') AND i.payment_type='debt'),0)::numeric td,
      COUNT(*) FILTER (WHERE i.status NOT IN ('refunded','cancelled'))::int ic
      FROM public.invoices i WHERE i.user_id=_owner AND i.customer_id=_inv.customer_id) s
    WHERE c.id=_inv.customer_id AND c.user_id=_owner;
  END IF;

  -- سجل العملية: يمنع تكرار نفس الاسترداد الجزئي عند إعادة المزامنة
  INSERT INTO public.activity_log(user_id, actor_id, actor_name, actor_role, action_type, entity_type, entity_id, entity_name, description, metadata)
  SELECT _owner, auth.uid(), COALESCE(p.full_name, 'مستخدم'), ur.role::text,
    'partial_refund', 'invoice', _inv.id::text, _inv.invoice_number,
    'استرداد جزئي للفاتورة ' || _inv.invoice_number,
    jsonb_build_object('operation_id', _operation_id, 'invoice_number', _inv.invoice_number, 'refund_amount', _refund,
                       'profit_reduction', _profit_red, 'cash_to_refund', _cash, 'debt_reduced', _debt_red, 'restored_units', _restored)
  FROM (SELECT 1) seed
  LEFT JOIN public.profiles p ON p.user_id = auth.uid()
  LEFT JOIN public.user_roles ur ON ur.user_id = auth.uid()
  LIMIT 1;

  RETURN jsonb_build_object('success',true,'invoice_id',_inv.id,'invoice_number',_inv.invoice_number,'refund_amount',_refund,'restored_units',_restored,'new_total',_new_total,'new_profit',_new_profit,'new_debt_remaining',_new_debt,'cash_to_refund',_cash,'debt_reduced',_debt_red,'is_fully_refunded',_full);
END;
$function$
;
