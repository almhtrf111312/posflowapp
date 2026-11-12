-- cancel_purchase_invoice_atomic(_invoice_id uuid, _reason text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

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
$function$
;
