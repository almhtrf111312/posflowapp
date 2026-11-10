-- =========================================================================
-- FlowPOS Pro — قفل الفترات المغلقة + تحمّل الشريك نسبته من الخسارة في أصنافه
-- مبني على النسخ الحية من الدوال (بما فيها ملف الإصلاحات المالية السابق).
-- آمن لإعادة التشغيل. لا يحذف بيانات، ولا يغيّر أرصدة الشركاء الحالية بأثر رجعي:
-- قاعدة الخسارة تُطبَّق على المبيعات الجديدة فقط.
-- انسخ الملف كما هو (UTF-8).
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- A1. دالة مساعدة: رفض أي تعديل بتاريخ يقع داخل فترة محاسبية مغلقة
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_period_open(_owner uuid, _date date, _what text DEFAULT 'العملية')
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
BEGIN
  IF _owner IS NULL OR _date IS NULL THEN
    RETURN;
  END IF;
  SELECT c.period_start, c.period_end INTO r
    FROM public.accounting_period_closures c
   WHERE c.user_id = _owner
     AND _date BETWEEN c.period_start AND c.period_end
   ORDER BY c.period_end DESC
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '% مرفوضة: التاريخ % ضمن فترة محاسبية مغلقة (من % إلى %)', _what, _date, r.period_start, r.period_end;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_period_open(uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_period_open(uuid, date, text) TO authenticated;

-- -------------------------------------------------------------------------
-- A2. refund_invoice_atomic: منع الاسترداد داخل فترة مغلقة
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refund_invoice_atomic(_invoice_number text, _source text DEFAULT 'online'::text)
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
  _row record;
  _main constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _owner := public.get_owner_id(_caller);

  SELECT i.* INTO _invoice 
  FROM public.invoices i 
  WHERE i.invoice_number = _invoice_number AND i.user_id = _owner 
  FOR UPDATE;

  IF NOT FOUND THEN 
    RETURN QUERY SELECT false, false, NULL::uuid, _invoice_number, 0::numeric, NULL::text, 0, 0::numeric, 0::numeric, NULL::text; 
    RETURN; 
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.stock_movements sm 
    WHERE sm.user_id = _owner AND sm.invoice_id = _invoice.id AND sm.movement_type = 'refund'
  ) INTO _has_refund;

  IF _invoice.status = 'refunded' OR _has_refund THEN 
    RETURN QUERY SELECT false, true, _invoice.id, _invoice.invoice_number, COALESCE(_invoice.total, 0)::numeric, _invoice.currency::text, 0, 0::numeric, 0::numeric, _invoice.customer_name::text; 
    RETURN; 
  END IF;

  -- لا يُسترد بيع يقع داخل فترة محاسبية مغلقة
  PERFORM public.assert_period_open(_owner, _invoice.date, 'استرداد الفاتورة');

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.refund_items(
    product_id uuid NOT NULL, 
    warehouse_key uuid NOT NULL, 
    quantity numeric(14,3) NOT NULL,
    PRIMARY KEY(product_id, warehouse_key)
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.refund_items;

  -- 🎯 تصحيح الكرتونة: ضرب الكمية في معامل التحويل conversion_factor إذا كانت الوحدة bulk
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
  SELECT COALESCE(SUM(d.remaining_debt), 0)::numeric INTO _deleted_debt FROM public.debts d WHERE d.user_id = _owner AND (d.invoice_id = _invoice.invoice_number OR d.invoice_id = _invoice.id::text);
  
  DELETE FROM public.debts d WHERE d.user_id = _owner AND (d.invoice_id = _invoice.invoice_number OR d.invoice_id = _invoice.id::text);

  IF _invoice.customer_id IS NOT NULL THEN
    UPDATE public.customers c SET total_purchases = s.total_purchases, total_debt = s.total_debt, invoice_count = s.invoice_count
    FROM (
      SELECT 
        COALESCE(SUM(i.total) FILTER(WHERE i.id <> _invoice.id AND i.status <> 'refunded'), 0)::numeric AS total_purchases,
        COALESCE(SUM(i.debt_remaining) FILTER(WHERE i.id <> _invoice.id AND i.status <> 'refunded' AND i.payment_type = 'debt' AND i.status <> 'paid'), 0)::numeric AS total_debt,
        COUNT(*) FILTER(WHERE i.id <> _invoice.id AND i.status <> 'refunded')::integer AS invoice_count 
      FROM public.invoices i 
      WHERE i.user_id = _owner AND i.customer_id = _invoice.customer_id
    ) s
    WHERE c.id = _invoice.customer_id AND c.user_id = _owner;
  END IF;

  UPDATE public.invoice_items SET profit = 0 WHERE invoice_id = _invoice.id;

  UPDATE public.invoices 
  SET status = 'refunded', 
      profit = 0,
      notes = concat_ws(E'\n', NULLIF(_invoice.notes, ''), 'Refunded at ' || now()::text), 
      updated_at = now() 
  WHERE id = _invoice.id;

  -- 🎯 عكس أرباح الشركاء ذرياً بنسبة 100% داخل السيرفر
  PERFORM public.revert_invoice_partner_profits_atomic(_invoice.id, 1.0);

  INSERT INTO public.activity_log(user_id, actor_id, actor_name, actor_role, action_type, entity_type, entity_id, entity_name, description, metadata)
  SELECT 
    _owner, _caller, COALESCE(p.full_name, _invoice.cashier_name, 'مستخدم'), ur.role::text, 
    'invoice_refunded', 'invoice', _invoice.id::text, _invoice.invoice_number, 
    'تم استرداد الفاتورة ' || _invoice.invoice_number, 
    jsonb_build_object('invoice_number', _invoice.invoice_number, 'invoice_total', COALESCE(_invoice.total, 0), 'invoice_currency', _invoice.currency, 'restored_items', _restored_items, 'restored_units', _restored_units, 'deleted_debt_amount', _deleted_debt, 'source', CASE WHEN _source = 'offline-sync' THEN 'offline-sync' ELSE 'online' END)
  FROM (SELECT 1) seed 
  LEFT JOIN public.profiles p ON p.user_id = _caller 
  LEFT JOIN public.user_roles ur ON ur.user_id = _caller 
  LIMIT 1;

  RETURN QUERY SELECT true, false, _invoice.id, _invoice.invoice_number, COALESCE(_invoice.total, 0)::numeric, _invoice.currency::text, _restored_items, _restored_units, _deleted_debt, _invoice.customer_name::text;
END;
$function$;

-- -------------------------------------------------------------------------
-- A3+B4. refund_invoice_partial_atomic: منع الاسترداد داخل فترة مغلقة + عكس حصص الخسارة
-- -------------------------------------------------------------------------
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
$function$;

-- -------------------------------------------------------------------------
-- A4. delete_expense_atomic: منع حذف مصروف داخل فترة مغلقة
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_expense_atomic(_expense_id uuid, _reason text DEFAULT 'إلغاء مصروف'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _exp public.expenses%ROWTYPE;
  _item jsonb;
  _partner_id uuid;
  _part_amount numeric;
  _active_shift_id uuid;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  SELECT * INTO _exp FROM public.expenses WHERE id = _expense_id AND user_id = _owner FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'المصروف غير موجود');
  END IF;

  IF COALESCE(_exp.is_reversed, false) = true THEN
    RETURN jsonb_build_object('success', true, 'already_reversed', true);
  END IF;

  -- لا يُحذف مصروف بتاريخ يقع داخل فترة محاسبية مغلقة
  PERFORM public.assert_period_open(_owner, _exp.date, 'حذف المصروف');

  -- 1) إعادة المبالغ المستقطعة إلى أرصدة الشركاء
  IF _exp.distributions IS NOT NULL AND jsonb_array_length(_exp.distributions) > 0 THEN
    FOR _item IN SELECT * FROM jsonb_array_elements(_exp.distributions) LOOP
      _partner_id := (_item->>'partnerId')::uuid;
      _part_amount := COALESCE((_item->>'amount')::numeric, 0);

      IF _partner_id IS NOT NULL AND _part_amount > 0 THEN
        UPDATE public.partners SET
          current_balance = round(COALESCE(current_balance, 0) + _part_amount, 2),
          expense_history = (
            SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
            FROM jsonb_array_elements(COALESCE(expense_history, '[]'::jsonb)) elem
            WHERE elem->>'expenseId' <> _expense_id::text
          ),
          updated_at = now()
        WHERE id = _partner_id AND user_id = _owner;
      END IF;
    END LOOP;
  END IF;

  -- 2) توثيق حركة تسوية في الوردية النشطة لإرجاع المبلغ للصندوق
  SELECT id INTO _active_shift_id
  FROM public.cash_shifts
  WHERE user_id = _owner 
    AND closed_at IS NULL
  ORDER BY opened_at DESC
  LIMIT 1;

  IF _active_shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions(
      shift_id, user_id, type, amount, reference_id, notes
    ) VALUES (
      _active_shift_id, _owner, 'expense_refund', _exp.amount, _expense_id::text, 
      'إلغاء واسترجاع مصروف: ' || COALESCE(_reason, '')
    );
  END IF;

  -- 3) وسم المصروف كمعكوس
  UPDATE public.expenses SET
    is_reversed = true,
    reversed_at = now(),
    reversed_reason = _reason
  WHERE id = _expense_id;

  RETURN jsonb_build_object('success', true, 'expense_id', _expense_id);
END;
$function$;

-- -------------------------------------------------------------------------
-- A5. cancel_purchase_invoice_atomic: منع الإلغاء داخل فترة مغلقة
-- -------------------------------------------------------------------------
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
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  -- 1) قفل الفاتورة والتحقق من التبعية للمتجر
  SELECT * INTO _orig_inv
    FROM public.purchase_invoices
   WHERE id = _invoice_id AND user_id = _owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'فاتورة المشتريات غير موجودة';
  END IF;

  -- الحماية من التكرار (Idempotency)
  IF _orig_inv.status = 'cancelled' OR _orig_inv.payment_status = 'cancelled' THEN
    RETURN true;
  END IF;

  -- لا تُلغى فاتورة شراء بتاريخ يقع داخل فترة محاسبية مغلقة
  PERFORM public.assert_period_open(_owner, _orig_inv.invoice_date, 'إلغاء فاتورة الشراء');

  -- 2) عكس أثر المخزون والتكلفة المرجحة لكل صنف (WAC Reversal)
  FOR _old_item IN
    SELECT * FROM public.purchase_invoice_items
     WHERE invoice_id = _invoice_id
  LOOP
    IF _old_item.product_id IS NOT NULL THEN
      -- استخدام عمود quantity الفعلي المعتمد في مخطط النظام
      SELECT quantity, cost_price
        INTO _cur_stock, _cur_cost
        FROM public.products
       WHERE id = _old_item.product_id AND user_id = _owner
         FOR UPDATE;

      IF FOUND THEN
        _new_stock := GREATEST(0, COALESCE(_cur_stock, 0) - COALESCE(_old_item.quantity, 0));

        -- استعادة التكلفة السابقة الموثقة إن وجدت، أو حساب التكلفة التراجعية
        IF _old_item.cost_price_before IS NOT NULL THEN
          _new_cost := _old_item.cost_price_before;
        ELSIF _new_stock > 0 THEN
          _new_cost := GREATEST(0, round(((COALESCE(_cur_stock, 0) * COALESCE(_cur_cost, 0)) - (COALESCE(_old_item.quantity, 0) * COALESCE(_old_item.cost_price, 0))) / _new_stock, 8));
        ELSE
          _new_cost := COALESCE(_cur_cost, 0);
        END IF;

        -- تحديث المنتج بالكمية والتكلفة الصحيحة
        UPDATE public.products
           SET quantity = _new_stock,
               cost_price = _new_cost,
               updated_at = now()
         WHERE id = _old_item.product_id;

        -- قيد حركة المخزون العكسية
        INSERT INTO public.stock_movements (
          user_id, product_id, movement_type, quantity, reference_id, notes, created_at
        ) VALUES (
          _owner, _old_item.product_id, 'purchase_reversal', -COALESCE(_old_item.quantity, 0),
          _invoice_id::text, 'عكس مخزون لإلغاء فاتورة شراء: ' || COALESCE(_orig_inv.invoice_number, ''), now()
        );
      END IF;
    END IF;
  END LOOP;

  -- 3) وسم الفاتورة كملغاة مع توثيق السبب
  UPDATE public.purchase_invoices
     SET status = 'cancelled',
         payment_status = 'cancelled',
         notes = concat_ws(E'\n', notes, '[ملغاة] ' || COALESCE(_reason, 'إلغاء الفاتورة')),
         updated_at = now()
   WHERE id = _invoice_id;

  RETURN true;
END;
$function$;

-- -------------------------------------------------------------------------
-- A6. edit_purchase_invoice_atomic: منع التعديل داخل فترة مغلقة
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.edit_purchase_invoice_atomic(_invoice_id uuid, _new_lines jsonb, _op_id text, _reason text DEFAULT 'Purchase invoice edit'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller UUID := auth.uid();
  _owner UUID;
  _orig_inv RECORD;
  _existing_id UUID;
  _new_invoice_id UUID;
  _old_item RECORD;
  _line JSONB;
  _prod_id UUID;
  _prod_qty NUMERIC;
  _prod_cost NUMERIC;
  _prod_name TEXT;
  _prod_barcode TEXT;
  _prod_cat TEXT;
  _cur_stock NUMERIC;
  _cur_cost NUMERIC;
  _new_stock NUMERIC;
  _new_cost NUMERIC;
  _items_count INT := 0;
  _total_qty NUMERIC := 0;
  _grand_total NUMERIC := 0;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _owner := public.get_owner_id(_caller);

  -- منع التكرار (Idempotency)
  SELECT id INTO _existing_id FROM public.purchase_invoices WHERE operation_id = _op_id;
  IF _existing_id IS NOT NULL THEN
    RETURN _existing_id;
  END IF;

  SELECT * INTO _orig_inv FROM public.purchase_invoices WHERE id = _invoice_id AND user_id = _owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original invoice not found'; END IF;
  -- لا تُعدّل فاتورة شراء بتاريخ يقع داخل فترة محاسبية مغلقة
  PERFORM public.assert_period_open(_owner, _orig_inv.invoice_date, 'تعديل فاتورة الشراء');

  -- 1) عكس أثر الكميات والتكلفة القديمة
  FOR _old_item IN SELECT * FROM public.purchase_invoice_items WHERE invoice_id = _invoice_id LOOP
    SELECT quantity, cost_price INTO _cur_stock, _cur_cost FROM public.products WHERE id = _old_item.product_id AND user_id = _owner FOR UPDATE;
    IF FOUND THEN
      _new_stock := GREATEST(0, COALESCE(_cur_stock, 0) - COALESCE(_old_item.quantity, 0));
      IF _old_item.cost_price_before IS NOT NULL THEN
        _new_cost := _old_item.cost_price_before;
      ELSIF _new_stock > 0 THEN
        _new_cost := GREATEST(0, ((COALESCE(_cur_stock, 0) * COALESCE(_cur_cost, 0)) - (COALESCE(_old_item.quantity, 0) * COALESCE(_old_item.cost_price, 0))) / _new_stock);
      ELSE
        _new_cost := COALESCE(_cur_cost, 0);
      END IF;

      UPDATE public.products SET quantity = _new_stock, cost_price = _new_cost, updated_at = NOW() WHERE id = _old_item.product_id;
    END IF;
  END LOOP;

  -- 2) إنشاء الفاتورة الجديدة المعدلة
  INSERT INTO public.purchase_invoices (
    user_id, invoice_number, supplier_name, invoice_date, total_amount, notes,
    payment_status, payment_method, original_currency, exchange_rate, operation_id
  ) VALUES (
    _owner, _orig_inv.invoice_number || '-E', _orig_inv.supplier_name, NOW(), 0,
    COALESCE(_reason, 'تعديل الفاتورة ' || _orig_inv.invoice_number),
    _orig_inv.payment_status, _orig_inv.payment_method, _orig_inv.original_currency, _orig_inv.exchange_rate, _op_id
  ) RETURNING id INTO _new_invoice_id;

  -- 3) إدراج البنود الجديدة وتطبيق WAC الجديد
  FOR _line IN SELECT * FROM jsonb_array_elements(_new_lines) LOOP
    _prod_id := (_line->>'product_id')::UUID;
    _prod_qty := GREATEST(0, (_line->>'quantity')::NUMERIC);
    _prod_cost := GREATEST(0, (_line->>'cost_price')::NUMERIC);
    _prod_name := COALESCE(_line->>'product_name', 'صنف');
    _prod_barcode := _line->>'barcode';
    _prod_cat := _line->>'category';

    SELECT quantity, cost_price INTO _cur_stock, _cur_cost FROM public.products WHERE id = _prod_id AND user_id = _owner FOR UPDATE;
    IF FOUND THEN
      _new_stock := COALESCE(_cur_stock, 0) + _prod_qty;
      IF _new_stock > 0 THEN
        _new_cost := ((COALESCE(_cur_stock, 0) * COALESCE(_cur_cost, 0)) + (_prod_qty * _prod_cost)) / _new_stock;
      ELSE
        _new_cost := _prod_cost;
      END IF;

      UPDATE public.products SET quantity = _new_stock, cost_price = _new_cost, updated_at = NOW() WHERE id = _prod_id;

      INSERT INTO public.purchase_invoice_items (
        invoice_id, product_id, product_name, barcode, category,
        quantity, cost_price, cost_price_before, sale_price, total_cost
      ) VALUES (
        _new_invoice_id, _prod_id, _prod_name, _prod_barcode, _prod_cat,
        _prod_qty, _prod_cost, _cur_cost, (_line->>'sale_price')::NUMERIC, (_prod_qty * _prod_cost)
      );

      _items_count := _items_count + 1;
      _total_qty := _total_qty + _prod_qty;
      _grand_total := _grand_total + (_prod_qty * _prod_cost);
    END IF;
  END LOOP;

  -- تحديث إجمالي الفاتورة الجديدة
  UPDATE public.purchase_invoices SET total_amount = _grand_total, total_items = _items_count, total_quantity = _total_qty WHERE id = _new_invoice_id;

  -- أرشفة الفاتورة القديمة وإلغاؤها
  UPDATE public.purchase_invoices SET payment_status = 'cancelled', notes = COALESCE(notes, '') || ' [تم استبدالها بـ ' || _orig_inv.invoice_number || '-E]' WHERE id = _invoice_id;

  RETURN _new_invoice_id;
END;
$function$;

-- -------------------------------------------------------------------------
-- B1. distribute_invoice_partner_profits_atomic: توزيع الربح والخسارة لكل صنف على شركائه فقط
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.distribute_invoice_partner_profits_atomic(_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE;
  _owner uuid;
  _is_debt boolean;
  _cat_profit record;
  _remaining_profit numeric;
  _partner record;
  _partner_share numeric;
  _cat_share jsonb;
  _pct numeric;
  _profit_record jsonb;
  _pending_detail jsonb;
  _total_distributed numeric := 0;
  _distributions jsonb := '[]'::jsonb;
BEGIN
  -- 1. جلب الفاتورة والتحقق من وجودها
  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  _owner := _inv.user_id;
  _is_debt := (_inv.payment_type = 'debt' AND COALESCE(_inv.debt_remaining, 0) > 0);

  -- 2. التحقق من عدم التوزيع المسبق لنفس الفاتورة (Idempotency)
  IF EXISTS (
    SELECT 1 FROM public.partners p,
    jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb)) ph
    WHERE p.user_id = _owner AND ph->>'invoiceId' = _inv.invoice_number
  ) THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'invoice_number', _inv.invoice_number);
  END IF;

  -- 3. تجميع الأرباح الصافية لكل تصنيف مباشرة من بنود الفاتورة الحقيقية
  FOR _cat_profit IN
    SELECT 
      COALESCE(NULLIF(trim(p.category), ''), 'عام') AS category_name,
      round(SUM(COALESCE(ii.profit, 0)), 8) AS total_category_profit
    FROM public.invoice_items ii
    LEFT JOIN public.products p ON p.id = ii.product_id AND p.user_id = _owner
    WHERE ii.invoice_id = _invoice_id
    GROUP BY COALESCE(NULLIF(trim(p.category), ''), 'عام')
    -- الأصناف الخاسرة تُوزَّع أيضاً: الشريك يتحمل نسبته من خسارة صنفه
    HAVING SUM(COALESCE(ii.profit, 0)) <> 0
  LOOP
    _remaining_profit := _cat_profit.total_category_profit;

    -- ======= المرحلة أ: الشركاء المتخصصون في هذا التصنيف بعينه =======
    FOR _partner IN
      SELECT * FROM public.partners
      WHERE user_id = _owner 
        AND COALESCE(access_all, false) = false
        AND category_shares IS NOT NULL
      FOR UPDATE -- 🔒 قفل السجل لمنع أي Race Condition
    LOOP
      -- البحث عن نسبة الصنف لهذا الشريك
      SELECT cs INTO _cat_share
      FROM jsonb_array_elements(_partner.category_shares) cs
      WHERE (cs->>'enabled')::boolean = true 
        AND cs->>'categoryName' = _cat_profit.category_name
      LIMIT 1;

      IF _cat_share IS NOT NULL AND COALESCE((_cat_share->>'percentage')::numeric, 0) > 0 THEN
        _pct := (_cat_share->>'percentage')::numeric;
        _partner_share := round((_cat_profit.total_category_profit * _pct / 100.0), 4);
        
        IF _partner_share <> 0 THEN
          _remaining_profit := _remaining_profit - _partner_share;
          _total_distributed := _total_distributed + _partner_share;

          _profit_record := jsonb_build_object(
            'id', extract(epoch from now())::text || _partner.id::text || _cat_profit.category_name,
            'invoiceId', _inv.invoice_number,
            'amount', _partner_share,
            'category', _cat_profit.category_name,
            'isDebt', _is_debt,
            'createdAt', now()
          );

          IF _is_debt THEN
            _pending_detail := jsonb_build_object(
              'invoiceId', _inv.invoice_number,
              'amount', _partner_share,
              'customerName', COALESCE(_inv.customer_name, 'عميل بيع مؤجل'),
              'createdAt', now()
            );

            UPDATE public.partners SET
              pending_profit = round(COALESCE(pending_profit, 0) + _partner_share, 4),
              pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || _pending_detail,
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          ELSE
            UPDATE public.partners SET
              confirmed_profit = round(COALESCE(confirmed_profit, 0) + _partner_share, 4),
              current_balance = round(COALESCE(current_balance, 0) + _partner_share, 4),
              total_profit_earned = round(COALESCE(total_profit_earned, 0) + _partner_share, 4),
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          END IF;

          _distributions := _distributions || jsonb_build_object(
            'partnerId', _partner.id,
            'partnerName', _partner.name,
            'amount', _partner_share,
            'category', _cat_profit.category_name
          );
        END IF;
      END IF;
    END LOOP;

    -- ======= المرحلة ب: الشركاء العامون على ما تبقى من ربح التصنيف =======
    IF _remaining_profit <> 0 THEN
      FOR _partner IN
        SELECT * FROM public.partners
        WHERE user_id = _owner 
          AND COALESCE(access_all, false) = true
          AND COALESCE(share_percentage, 0) > 0
        FOR UPDATE -- 🔒 قفل السجل لمنع أي Race Condition
      LOOP
        _partner_share := round((_remaining_profit * _partner.share_percentage / 100.0), 4);
        
        IF _partner_share <> 0 THEN
          _total_distributed := _total_distributed + _partner_share;

          _profit_record := jsonb_build_object(
            'id', extract(epoch from now())::text || _partner.id::text || _cat_profit.category_name,
            'invoiceId', _inv.invoice_number,
            'amount', _partner_share,
            'category', _cat_profit.category_name,
            'isDebt', _is_debt,
            'createdAt', now()
          );

          IF _is_debt THEN
            _pending_detail := jsonb_build_object(
              'invoiceId', _inv.invoice_number,
              'amount', _partner_share,
              'customerName', COALESCE(_inv.customer_name, 'عميل بيع مؤجل'),
              'createdAt', now()
            );

            UPDATE public.partners SET
              pending_profit = round(COALESCE(pending_profit, 0) + _partner_share, 4),
              pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || _pending_detail,
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          ELSE
            UPDATE public.partners SET
              confirmed_profit = round(COALESCE(confirmed_profit, 0) + _partner_share, 4),
              current_balance = round(COALESCE(current_balance, 0) + _partner_share, 4),
              total_profit_earned = round(COALESCE(total_profit_earned, 0) + _partner_share, 4),
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          END IF;

          _distributions := _distributions || jsonb_build_object(
            'partnerId', _partner.id,
            'partnerName', _partner.name,
            'amount', _partner_share,
            'category', _cat_profit.category_name
          );
        END IF;
      END LOOP;
    END IF;

  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', _invoice_id,
    'total_distributed', _total_distributed,
    'distributions', _distributions
  );
END;
$function$;

-- -------------------------------------------------------------------------
-- B2. record_debt_payment_atomic: تحرير حصص الخسارة المعلقة مع السداد أيضاً
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_debt_payment_atomic(_debt_id uuid, _amount numeric, _operation_id text, _shift_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid := public.get_owner_id(auth.uid());
  v_debt public.debts%ROWTYPE;
  v_amount numeric := round(COALESCE(_amount, 0)::numeric, 2);
  v_prev_remaining numeric;
  v_new_remaining numeric;
  v_installment_ratio numeric := 1.0;
  p record;
  _updated_details jsonb;
  _updated_history jsonb;
  _total_confirmed numeric := 0;
  _item jsonb;
  _item_amt numeric;
  _confirm_amt numeric;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN 
    RAISE EXCEPTION 'غير مصرح'; 
  END IF;
  
  IF _operation_id IS NULL OR length(_operation_id) < 8 THEN 
    RAISE EXCEPTION 'رقم العملية غير صالح'; 
  END IF;

  SELECT * INTO v_debt FROM public.debts WHERE id = _debt_id FOR UPDATE;
  IF NOT FOUND OR v_debt.user_id <> v_owner THEN 
    RAISE EXCEPTION 'الدين غير موجود أو لا يتبع للمتجر'; 
  END IF;

  IF EXISTS (SELECT 1 FROM public.debt_payments WHERE user_id = v_owner AND operation_id = _operation_id) THEN
    RETURN jsonb_build_object(
      'success', true, 
      'already_processed', true,
      'total_debt', v_debt.total_debt, 
      'total_paid', v_debt.total_paid,
      'remaining_debt', v_debt.remaining_debt, 
      'status', v_debt.status, 
      'amount', 0
    );
  END IF;

  IF v_amount <= 0 THEN 
    RAISE EXCEPTION 'أدخل مبلغًا صحيحًا أكبر من الصفر'; 
  END IF;

  v_prev_remaining := round(COALESCE(v_debt.remaining_debt, v_debt.total_debt - COALESCE(v_debt.total_paid, 0))::numeric, 2);
  
  IF v_amount > v_prev_remaining THEN
    RAISE EXCEPTION 'المبلغ المدخل (%) أكبر من المتبقي (%)', v_amount, v_prev_remaining;
  END IF;

  v_new_remaining := GREATEST(round(v_prev_remaining - v_amount, 2), 0);

  UPDATE public.debts 
     SET total_paid = round(COALESCE(total_paid, 0) + v_amount, 2),
         remaining_debt = v_new_remaining,
         status = CASE WHEN v_new_remaining <= 0 THEN 'fully_paid' ELSE 'partially_paid' END,
         updated_at = now()
   WHERE id = _debt_id 
  RETURNING * INTO v_debt;

  INSERT INTO public.debt_payments(user_id, debt_id, operation_id, amount, paid_by, shift_id)
  VALUES (v_owner, _debt_id, _operation_id, v_amount, auth.uid(), _shift_id);

  IF _shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions(shift_id, user_id, type, amount, reference_id, notes)
    VALUES (_shift_id, v_owner, 'debt_payment', v_amount, _operation_id, 'تسديد دين للعميل: ' || COALESCE(v_debt.customer_name, ''))
    ON CONFLICT (shift_id, type, reference_id) DO NOTHING;

    UPDATE public.cash_shifts 
       SET expected_balance = round(expected_balance + v_amount, 2),
           updated_at = now()
     WHERE id = _shift_id AND closed_at IS NULL;
  END IF;

  IF v_debt.invoice_id IS NOT NULL AND NOT COALESCE(v_debt.is_cash_debt, false) THEN
    UPDATE public.invoices i
       SET debt_paid = v_debt.total_paid,
           debt_remaining = v_debt.remaining_debt,
           status = CASE 
             WHEN i.status IN ('refunded', 'cancelled') THEN i.status
             WHEN v_debt.remaining_debt <= 0 THEN 'paid' 
             ELSE 'pending' 
           END,
           updated_at = now()
     WHERE i.user_id = v_owner
       AND (i.invoice_number = v_debt.invoice_id OR i.id::text = v_debt.invoice_id);

    -- 🎯 تحرير أرباح الشركاء بنسبة الدفعة من المتبقي
    IF v_prev_remaining > 0 THEN
      IF v_new_remaining <= 0 THEN
        v_installment_ratio := 1.0;
      ELSE
        v_installment_ratio := LEAST(1.0, round(v_amount / v_prev_remaining, 6));
      END IF;

      FOR p IN 
        SELECT * FROM public.partners 
         WHERE user_id = v_owner
           AND pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', v_debt.invoice_id))
         FOR UPDATE
      LOOP
        _updated_details := '[]'::jsonb;
        _total_confirmed := 0;

        FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.pending_profit_details, '[]'::jsonb))
        LOOP
          IF (_item->>'invoiceId') = v_debt.invoice_id THEN
            _item_amt := (_item->>'amount')::numeric;

            IF v_new_remaining <= 0 THEN
              _confirm_amt := _item_amt;
            ELSE
              _confirm_amt := round(_item_amt * v_installment_ratio, 2);
              IF abs(_item_amt - _confirm_amt) > 0.001 THEN
                _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_item_amt - _confirm_amt, 2)));
              END IF;
            END IF;

            _total_confirmed := _total_confirmed + _confirm_amt;
          ELSE
            _updated_details := _updated_details || _item;
          END IF;
        END LOOP;

        IF _total_confirmed <> 0 THEN
          _updated_history := '[]'::jsonb;
          -- 🎯 التعديل الجذري: لا نقلب isDebt لكامل السجل إلا إذا كان السداد تاماً 100%
          FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb))
          LOOP
            IF (_item->>'invoiceId') = v_debt.invoice_id AND (_item->>'isDebt')::boolean = true AND v_new_remaining <= 0 THEN
              _updated_history := _updated_history || jsonb_set(_item, '{isDebt}', 'false'::jsonb);
            ELSIF (_item->>'invoiceId') = v_debt.invoice_id AND v_new_remaining <= 0
                  AND (COALESCE((_item->>'isRelease')::boolean, false) OR COALESCE(_item->>'id', '') LIKE '%-rel')
                  AND NOT COALESCE((_item->>'superseded')::boolean, false) THEN
              -- دفعات التحرير السابقة أصبحت مشمولة بالقيد الأصلي المؤكد: تُعلَّم كمستبدلة حتى لا تُحسب مرتين في التقارير
              _updated_history := _updated_history || jsonb_set(_item, '{superseded}', 'true'::jsonb);
            ELSE
              _updated_history := _updated_history || _item;
            END IF;
          END LOOP;

          -- تسجيل دفعة التحرير صراحة في التاريخ المالي
          IF v_new_remaining > 0 THEN
            _updated_history := _updated_history || jsonb_build_object(
              'id', extract(epoch from now())::text || p.id::text || '-rel',
              'invoiceId', v_debt.invoice_id,
              'amount', _total_confirmed,
              'category', 'تحرير دفعة دين',
              'isRelease', true,
              'isDebt', false,
              'createdAt', now()
            );
          END IF;

          UPDATE public.partners
             SET pending_profit = round((SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(_updated_details) x), 4),
                 confirmed_profit = round(COALESCE(confirmed_profit, 0) + _total_confirmed, 2),
                 current_balance = round(COALESCE(current_balance, 0) + _total_confirmed, 2),
                 total_profit_earned = round(COALESCE(total_profit_earned, 0) + _total_confirmed, 2),
                 pending_profit_details = _updated_details,
                 profit_history = _updated_history,
                 updated_at = now()
           WHERE id = p.id;
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF v_debt.customer_name IS NOT NULL THEN
    UPDATE public.customers
       SET total_debt = GREATEST(round(COALESCE(total_debt, 0) - v_amount, 2), 0),
           updated_at = now()
     WHERE user_id = v_owner
       AND (name = v_debt.customer_name OR (v_debt.customer_phone IS NOT NULL AND phone = v_debt.customer_phone));
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'total_debt', v_debt.total_debt,
    'total_paid', v_debt.total_paid,
    'remaining_debt', v_debt.remaining_debt,
    'status', v_debt.status,
    'amount', v_amount,
    'confirmed_profit', _total_confirmed
  );
END;
$function$;

-- -------------------------------------------------------------------------
-- B3. revert_invoice_partner_profits_atomic: عكس حصص الخسارة عند المرتجع
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revert_invoice_partner_profits_atomic(_invoice_id uuid, _revert_ratio numeric DEFAULT 1.0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE;
  _owner uuid;
  _partner record;
  _ratio numeric := LEAST(GREATEST(COALESCE(_revert_ratio, 1.0), 0.0), 1.0);
  _full boolean;
  _updated_details jsonb;
  _revert_record jsonb;
  _pending_reverted numeric;
  _confirmed_reverted numeric;
  _orig_share numeric;
  _pending_now numeric;
  _already_reverted numeric;
  _confirmed_net numeric;
  _item jsonb;
  _amt numeric;
  _total_reverted numeric := 0;
BEGIN
  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  _owner := _inv.user_id;
  _full := _ratio >= 0.9999;

  FOR _partner IN
    SELECT * FROM public.partners
    WHERE user_id = _owner
      AND (
        profit_history @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
        OR pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
      )
    FOR UPDATE
  LOOP
    _pending_reverted := 0;
    _updated_details := '[]'::jsonb;

    -- أ) الأرباح المعلقة: تُعكس بالنسبة من الرصيد المعلق الحالي للفاتورة
    FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb)) LOOP
      IF _item->>'invoiceId' = _inv.invoice_number THEN
        _amt := COALESCE((_item->>'amount')::numeric, 0);
        IF _full THEN
          _pending_reverted := _pending_reverted + _amt;
        ELSE
          _pending_reverted := _pending_reverted + round(_amt * _ratio, 8);
          IF abs(round(_amt * (1.0 - _ratio), 8)) > 0.00005 THEN
            _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_amt * (1.0 - _ratio), 8)));
          END IF;
        END IF;
      ELSE
        _updated_details := _updated_details || _item;
      END IF;
    END LOOP;

    -- ب) الأرباح المؤكدة المتبقية فعلياً لهذه الفاتورة:
    --    الحصة الأصلية − ما زال معلقاً − ما عُكس سابقاً
    --    (تستبعد قيود تحرير دفعات الدين وقيود العكس السابقة حتى لا يُعكس المبلغ نفسه مرتين)
    SELECT COALESCE(SUM(COALESCE((x->>'amount')::numeric, 0)), 0) INTO _pending_now
      FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb)) x
     WHERE x->>'invoiceId' = _inv.invoice_number;

    SELECT COALESCE(SUM(COALESCE((x->>'amount')::numeric, 0)), 0) INTO _orig_share
      FROM jsonb_array_elements(COALESCE(_partner.profit_history, '[]'::jsonb)) x
     WHERE x->>'invoiceId' = _inv.invoice_number
       AND COALESCE((x->>'isReversal')::boolean, false) = false
       AND COALESCE((x->>'isRelease')::boolean, false) = false
       AND COALESCE(x->>'id', '') NOT LIKE '%-rel'
       AND COALESCE(x->>'category', '') <> 'تحرير دفعة دين';

    SELECT COALESCE(SUM(-COALESCE((x->>'amount')::numeric, 0)), 0) INTO _already_reverted
      FROM jsonb_array_elements(COALESCE(_partner.profit_history, '[]'::jsonb)) x
     WHERE x->>'invoiceId' = _inv.invoice_number
       AND COALESCE((x->>'isReversal')::boolean, false) = true;

    _confirmed_net := round(_orig_share - _pending_now - _already_reverted, 8);
    -- لا يتجاوز العكس اتجاه الحصة الأصلية (ربح أو خسارة)
    _confirmed_net := CASE WHEN _orig_share >= 0 THEN GREATEST(_confirmed_net, 0) ELSE LEAST(_confirmed_net, 0) END;
    _confirmed_reverted := CASE WHEN _full THEN _confirmed_net ELSE round(_confirmed_net * _ratio, 8) END;

    IF _pending_reverted <> 0 OR _confirmed_reverted <> 0 THEN
      _revert_record := jsonb_build_object(
        'id', extract(epoch from now())::text || _partner.id::text || '-rev',
        'invoiceId', _inv.invoice_number,
        'amount', -round(_pending_reverted + _confirmed_reverted, 8),
        'pendingReverted', round(_pending_reverted, 8),
        'confirmedReverted', round(_confirmed_reverted, 8),
        'category', 'مرتجع فاتورة',
        'isReversal', true,
        'createdAt', now()
      );

      UPDATE public.partners SET
        pending_profit = round((SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(_updated_details) x), 4),
        confirmed_profit = round(COALESCE(confirmed_profit, 0) - _confirmed_reverted, 4),
        current_balance = round(COALESCE(current_balance, 0) - _confirmed_reverted, 4),
        total_profit_earned = round(COALESCE(total_profit_earned, 0) - _confirmed_reverted, 4),
        pending_profit_details = _updated_details,
        profit_history = COALESCE(profit_history, '[]'::jsonb) || _revert_record,
        updated_at = now()
      WHERE id = _partner.id;

      _total_reverted := _total_reverted + _pending_reverted + _confirmed_reverted;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_number', _inv.invoice_number,
    'total_reverted', round(_total_reverted, 8)
  );
END;
$function$;

-- -------------------------------------------------------------------------
-- B5. writeoff_debt_atomic: إزالة الحصص المعلقة للفاتورة المشطوبة ربحاً كانت أو خسارة
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.writeoff_debt_atomic(_debt_id uuid, _reason text, _operation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _debt public.debts%ROWTYPE;
  _partner record;
  _clean_details jsonb;
  _item jsonb;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF _operation_id IS NULL OR length(_operation_id) < 8 THEN
    RAISE EXCEPTION 'معرف العملية غير صالح';
  END IF;

  -- قفل سجل الدين
  SELECT * INTO _debt 
    FROM public.debts 
   WHERE id = _debt_id AND user_id = _owner 
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'الدين غير موجود أو لا يتبع لهذا المتجر';
  END IF;

  -- الحماية من التكرار
  IF _debt.status = 'written_off' THEN
    RETURN jsonb_build_object('success', true, 'already_written_off', true, 'debt_id', _debt_id);
  END IF;

  -- 1) تعديل حالة الدين إلى مشطوب وتوثيق السبب
  UPDATE public.debts
     SET status = 'written_off',
         notes = concat_ws(E'\n', notes, '[شطب دين]: ' || COALESCE(_reason, 'شطب إداري')),
         updated_at = now()
   WHERE id = _debt_id;

  -- 2) تعديل الفاتورة المرتبطة إن وجدت
  IF _debt.invoice_id IS NOT NULL AND NOT COALESCE(_debt.is_cash_debt, false) THEN
    UPDATE public.invoices
       SET status = 'written_off',
           notes = concat_ws(E'\n', notes, '[دين مشطوب]: ' || COALESCE(_reason, '')),
           updated_at = now()
     WHERE user_id = _owner
       AND (invoice_number = _debt.invoice_id OR id::text = _debt.invoice_id);
  END IF;

  -- 3) خصم رصيد الدين المشطوب من إجمالي ديون العميل
  IF _debt.customer_name IS NOT NULL THEN
    UPDATE public.customers
       SET total_debt = GREATEST(COALESCE(total_debt, 0) - COALESCE(_debt.remaining_debt, 0), 0),
           updated_at = now()
     WHERE user_id = _owner
       AND (name = _debt.customer_name OR (phone IS NOT NULL AND phone = _debt.customer_phone));
  END IF;

  -- 4) تصفير وحذف الأرباح المعلقة المرتبطة بالفاتورة لدى جميع الشركاء
  IF _debt.invoice_id IS NOT NULL THEN
    FOR _partner IN 
      SELECT * FROM public.partners 
       WHERE user_id = _owner
         AND pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', _debt.invoice_id)) 
       FOR UPDATE 
    LOOP
      _clean_details := '[]'::jsonb;

      FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb))
      LOOP
        -- استبعاد أرباح الفاتورة المشطوبة
        IF (_item->>'invoiceId') <> _debt.invoice_id THEN
          _clean_details := _clean_details || _item;
        END IF;
      END LOOP;

      UPDATE public.partners
         SET pending_profit_details = _clean_details,
             pending_profit = (
               SELECT COALESCE(SUM((x->>'amount')::numeric), 0)
                 FROM jsonb_array_elements(_clean_details) AS x
             ),
             updated_at = now()
       WHERE id = _partner.id;
    END LOOP;
  END IF;

  -- 5) توثيق مبلغ الشطب كخسارة ديون معدومة (للتقارير وإقفال الفترة)
  BEGIN
    INSERT INTO public.debt_writeoffs(user_id, debt_id, customer_name, amount, reason, written_off_at, written_off_by, notes)
    VALUES (_owner, _debt_id, _debt.customer_name, COALESCE(_debt.remaining_debt, 0), COALESCE(_reason, 'شطب إداري'), now(), _caller, _debt.invoice_id);
  EXCEPTION WHEN OTHERS THEN
    -- لا يُفشل الشطب بسبب سجل التوثيق
    NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'debt_id', _debt_id,
    'written_off_amount', _debt.remaining_debt,
    'status', 'written_off'
  );
END;
$function$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- =========================================================================
-- التحقق بعد التنفيذ: يجب أن تكون كل القيم true
-- =========================================================================
SELECT
  to_regprocedure('public.assert_period_open(uuid,date,text)') IS NOT NULL AS period_lock_ready,
  position('assert_period_open' in pg_get_functiondef('public.refund_invoice_atomic(text,text)'::regprocedure)) > 0 AS refund_locked,
  position('<> 0' in pg_get_functiondef('public.distribute_invoice_partner_profits_atomic(uuid)'::regprocedure)) > 0 AS partner_loss_sharing,
  position('pending_profit_details @>' in pg_get_functiondef('public.record_debt_payment_atomic(uuid,numeric,text,uuid)'::regprocedure)) > 0 AS debt_release_fixed;
