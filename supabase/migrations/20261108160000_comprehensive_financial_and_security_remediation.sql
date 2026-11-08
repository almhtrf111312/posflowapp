-- =============================================================================
-- Migration: 20261108160000_comprehensive_financial_and_security_remediation.sql
-- Description: حزمة الإصلاحات الجذرية للثوابت المالية وعمليات الاسترداد وسداد الديون والمصاريف وإغلاق الفترة (EGM Remediation)
-- Target Issues:
--   1. P0-4: منع العكس المزدوج لأرباح الشركاء وتأمين revert_invoice_partner_profits_atomic
--   2. P1-5: تصحيح استرداد الكرتونة (ضرب الكمية في conversion_factor عند unit = 'bulk') في refund_invoice_atomic
--   3. P0-5: منع قلب isDebt: false في الدفعات الجزئية في record_debt_payment_atomic وحماية أرصدة الشركاء من النزيف
--   4. P1-25: تصحيح احتساب تكلفة البضاعة المباعة (COGS) في close_accounting_period_atomic من invoice_items مباشرة
--   5. P1-23: دالة خادم ذرية delete_expense_atomic لعكس المصاريف وإعادة أرصدة الشركاء بأمان تام
--   6. Data Backfill: تنظيف الديون الوهمية الناتجة عن الفواتير النقدية (35 ديناً) وإعادة احتساب ديون العملاء
-- =============================================================================

-- =============================================================================
-- 1. دالة ذرية موحدة لعكس أرباح الشركاء (Atomic Partner Profit Reversal)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.revert_invoice_partner_profits_atomic(
  _invoice_id uuid,
  _revert_ratio numeric DEFAULT 1.0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _inv public.invoices%ROWTYPE;
  _owner uuid;
  _partner record;
  _ratio numeric := LEAST(GREATEST(COALESCE(_revert_ratio, 1.0), 0.0), 1.0);
  _updated_details jsonb;
  _revert_record jsonb;
  _pending_reverted numeric;
  _confirmed_reverted numeric;
  _item jsonb;
  _total_reverted numeric := 0;
BEGIN
  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  _owner := _inv.user_id;

  FOR _partner IN
    SELECT p.* FROM public.partners p
    WHERE p.user_id = _owner
      AND (
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb)) ph
          WHERE ph->>'invoiceId' = _inv.invoice_number
            AND COALESCE((ph->>'isReversal')::boolean, false) = false
        )
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p.pending_profit_details, '[]'::jsonb)) pd
          WHERE pd->>'invoiceId' = _inv.invoice_number
        )
      )
    FOR UPDATE
  LOOP
    _pending_reverted   := 0;
    _confirmed_reverted := 0;
    _updated_details    := '[]'::jsonb;

    -- أ) معالجة الأرباح المعلقة (Pending)
    IF _partner.pending_profit_details IS NOT NULL THEN
      FOR _item IN SELECT * FROM jsonb_array_elements(_partner.pending_profit_details)
      LOOP
        IF _item->>'invoiceId' = _inv.invoice_number THEN
          IF _ratio >= 0.9999 THEN
            _pending_reverted := _pending_reverted + COALESCE((_item->>'amount')::numeric, 0);
          ELSE
            _pending_reverted := _pending_reverted + round(COALESCE((_item->>'amount')::numeric, 0) * _ratio, 4);
            IF round(COALESCE((_item->>'amount')::numeric, 0) * (1.0 - _ratio), 4) > 0.0001 THEN
              _updated_details := _updated_details || jsonb_set(
                _item, '{amount}',
                to_jsonb(round(COALESCE((_item->>'amount')::numeric, 0) * (1.0 - _ratio), 4))
              );
            END IF;
          END IF;
        ELSE
          _updated_details := _updated_details || _item;
        END IF;
      END LOOP;
    END IF;

    -- ب) احتساب الأرباح المؤكدة الواجب عكسها
    IF _partner.profit_history IS NOT NULL THEN
      SELECT COALESCE(SUM(round(COALESCE((elem->>'amount')::numeric, 0) * _ratio, 4)), 0)
      INTO _confirmed_reverted
      FROM jsonb_array_elements(_partner.profit_history) elem
      WHERE elem->>'invoiceId' = _inv.invoice_number
        AND COALESCE((elem->>'isDebt')::boolean, false) = false
        AND COALESCE((elem->>'isReversal')::boolean, false) = false;
    END IF;

    IF (_pending_reverted + _confirmed_reverted) > 0 THEN
      -- ج) قيد العكس في سجل الأرباح
      _revert_record := jsonb_build_object(
        'id',         extract(epoch from now())::text || '-' || _partner.id::text || '-rev',
        'invoiceId',  _inv.invoice_number,
        'amount',     -(_pending_reverted + _confirmed_reverted),
        'category',   'مرتجع فاتورة',
        'isReversal', true,
        'createdAt',  now()
      );

      -- النزاهة المحاسبية: تحديث الأرصدة بدقة
      UPDATE public.partners SET
        pending_profit        = GREATEST(round(COALESCE(pending_profit, 0) - _pending_reverted, 4), 0),
        confirmed_profit      = round(COALESCE(confirmed_profit, 0) - _confirmed_reverted, 4),
        current_balance       = round(COALESCE(current_balance, 0) - _confirmed_reverted, 4),
        total_profit_earned   = round(COALESCE(total_profit_earned, 0) - _confirmed_reverted, 4),
        pending_profit_details = _updated_details,
        profit_history        = COALESCE(profit_history, '[]'::jsonb) || _revert_record,
        updated_at            = now()
      WHERE id = _partner.id;

      _total_reverted := _total_reverted + _pending_reverted + _confirmed_reverted;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success',         true,
    'invoice_number',  _inv.invoice_number,
    'total_reverted',  _total_reverted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.revert_invoice_partner_profits_atomic(uuid, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.revert_invoice_partner_profits_atomic(uuid, numeric) TO authenticated, service_role;


-- =============================================================================
-- 2. المرحلة 2: دالة استرداد الفواتير وإعادة الكرتونة والمخزون (refund_invoice_atomic)
-- =============================================================================
-- إسقاط النسخ السابقة بكافة التواقيع لتفادي خطأ 42P13
DROP FUNCTION IF EXISTS public.refund_invoice_atomic(text, text);
DROP FUNCTION IF EXISTS public.refund_invoice_atomic(text);

CREATE OR REPLACE FUNCTION public.refund_invoice_atomic(
  _invoice_number text,
  _source text DEFAULT 'online'::text
)
RETURNS TABLE(
  success boolean,
  already_refunded boolean,
  invoice_id uuid,
  invoice_number text,
  invoice_total numeric,
  invoice_currency text,
  restored_item_count integer,
  restored_unit_count numeric,
  deleted_debt_amount numeric,
  customer_name text
)
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

  -- 🎯 عكس أرباح الشركاء ذرياً بنسبة 100% داخل السيرفر لمنع أي ازدواجية
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

REVOKE ALL ON FUNCTION public.refund_invoice_atomic(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.refund_invoice_atomic(text, text) TO authenticated, service_role;


-- =============================================================================
-- 3. المرحلة 3: دالة سداد الديون وتحرير الأرباح الذري (record_debt_payment_atomic)
-- =============================================================================
-- إسقاط النسخ السابقة لتفادي تضارب التواقيع
DROP FUNCTION IF EXISTS public.record_debt_payment_atomic(uuid, numeric, text, uuid);
DROP FUNCTION IF EXISTS public.record_debt_payment_atomic(uuid, numeric, text);

CREATE OR REPLACE FUNCTION public.record_debt_payment_atomic(
  _debt_id uuid,
  _amount numeric,
  _operation_id text,
  _shift_id uuid DEFAULT NULL::uuid
)
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
         WHERE user_id = v_owner AND pending_profit > 0 
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
              IF (_item_amt - _confirm_amt) > 0.001 THEN
                _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_item_amt - _confirm_amt, 2)));
              END IF;
            END IF;

            _total_confirmed := _total_confirmed + _confirm_amt;
          ELSE
            _updated_details := _updated_details || _item;
          END IF;
        END LOOP;

        IF _total_confirmed > 0 THEN
          _updated_history := '[]'::jsonb;
          -- 🎯 التعديل الجذري: لا نقلب isDebt لكامل السجل إلا إذا كان السداد تاماً 100%
          FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb))
          LOOP
            IF (_item->>'invoiceId') = v_debt.invoice_id AND (_item->>'isDebt')::boolean = true AND v_new_remaining <= 0 THEN
              _updated_history := _updated_history || jsonb_set(_item, '{isDebt}', 'false'::jsonb);
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
              'isDebt', false,
              'createdAt', now()
            );
          END IF;

          UPDATE public.partners
             SET pending_profit = GREATEST(0, round(COALESCE(pending_profit, 0) - _total_confirmed, 2)),
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

REVOKE ALL ON FUNCTION public.record_debt_payment_atomic(uuid, numeric, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.record_debt_payment_atomic(uuid, numeric, text, uuid) TO authenticated, service_role;


-- =============================================================================
-- 4. المرحلة 4: دالة إغلاق الفترة المحاسبية (close_accounting_period_atomic)
-- =============================================================================
-- إسقاط النسخ السابقة لتفادي تضارب التواقيع
DROP FUNCTION IF EXISTS public.close_accounting_period_atomic(date, date);
DROP FUNCTION IF EXISTS public.close_accounting_period_atomic(timestamp with time zone, timestamp with time zone);

CREATE OR REPLACE FUNCTION public.close_accounting_period_atomic(
  _period_start date,
  _period_end date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _rev numeric := 0;
  _cogs numeric := 0;
  _exp numeric := 0;
  _gross numeric := 0;
  _net numeric := 0;
  _partner_summary jsonb := '[]'::jsonb;
  _closure_id uuid;
  p record;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN 
    RAISE EXCEPTION 'غير مصرح'; 
  END IF;

  -- 1) حساب إجمالي الإيرادات
  SELECT 
    COALESCE(SUM(i.subtotal - COALESCE(i.discount, 0)), 0)
    INTO _rev
    FROM public.invoices i
   WHERE i.user_id = _owner
     AND i.status NOT IN ('refunded', 'cancelled')
     AND i.date BETWEEN _period_start AND _period_end;

  -- 🎯 حساب تكلفة البضاعة المباعة COGS مباشرة من بنود الفواتير (بدلاً من عمود total_cost غير الموجود)
  SELECT 
    COALESCE(SUM(COALESCE(ii.cost_price, 0) * COALESCE(ii.quantity, 0)), 0)
    INTO _cogs
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE i.user_id = _owner
     AND i.status NOT IN ('refunded', 'cancelled')
     AND i.date BETWEEN _period_start AND _period_end;

  -- 2) حساب المصاريف لنفس الفترة
  SELECT COALESCE(SUM(amount), 0) INTO _exp
    FROM public.expenses
   WHERE user_id = _owner
     AND COALESCE(is_reversed, false) = false
     AND date BETWEEN _period_start AND _period_end;

  _gross := round(_rev - _cogs, 2);
  _net := round(_gross - _exp, 2);

  -- 3) تجميع توزيعات الشركاء للفترة
  FOR p IN 
    SELECT id, name, confirmed_profit, current_balance, total_profit_earned 
      FROM public.partners 
     WHERE user_id = _owner 
  LOOP
    _partner_summary := _partner_summary || jsonb_build_object(
      'partner_id', p.id,
      'partner_name', p.name,
      'current_balance', p.current_balance,
      'confirmed_profit', p.confirmed_profit,
      'total_earned', p.total_profit_earned
    );
  END LOOP;

  -- 4) تسجيل قيد الإقفال في السجل التاريخي المحمي
  INSERT INTO public.accounting_period_closures (
    user_id, period_start, period_end, total_revenue, total_cogs,
    gross_profit, total_expenses, net_profit, partner_distributions, closed_by
  ) VALUES (
    _owner, _period_start, _period_end, _rev, _cogs,
    _gross, _exp, _net, _partner_summary, _caller
  ) RETURNING id INTO _closure_id;

  RETURN jsonb_build_object(
    'success', true,
    'closure_id', _closure_id,
    'period_start', _period_start,
    'period_end', _period_end,
    'revenue', _rev,
    'cogs', _cogs,
    'gross_profit', _gross,
    'expenses', _exp,
    'net_profit', _net,
    'partners', _partner_summary
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.close_accounting_period_atomic(date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.close_accounting_period_atomic(date, date) TO authenticated, service_role;


-- =============================================================================
-- 5. المرحلة 5: دالة خادم ذرية لحذف وعكس المصروف (delete_expense_atomic)
-- =============================================================================
DROP FUNCTION IF EXISTS public.delete_expense_atomic(uuid, text);
DROP FUNCTION IF EXISTS public.delete_expense_atomic(uuid);

CREATE OR REPLACE FUNCTION public.delete_expense_atomic(
  _expense_id uuid,
  _reason text DEFAULT 'إلغاء مصروف'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _exp public.expenses%ROWTYPE;
  _dist jsonb;
  _item jsonb;
  _partner_id uuid;
  _part_amount numeric;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN 
    RAISE EXCEPTION 'غير مصرح'; 
  END IF;

  SELECT * INTO _exp FROM public.expenses WHERE id = _expense_id AND user_id = _owner FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'المصروف غير موجود');
  END IF;

  IF COALESCE(_exp.is_reversed, false) = true THEN
    RETURN jsonb_build_object('success', true, 'already_reversed', true);
  END IF;

  -- إعادة المبالغ المستقطعة إلى أرصدة الشركاء ذرياً
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

  -- وسم المصروف كمعكوس دون حذفه تدميرياً (Audit Trail Preservation)
  UPDATE public.expenses SET
    is_reversed = true,
    reversed_at = now(),
    reversed_reason = _reason
  WHERE id = _expense_id;

  RETURN jsonb_build_object('success', true, 'expense_id', _expense_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_expense_atomic(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.delete_expense_atomic(uuid, text) TO authenticated, service_role;


-- =============================================================================
-- 6. المرحلة 6: تنظيف الديون الوهمية الناتجة عن الفواتير النقدية (Data Backfill)
-- =============================================================================
WITH deleted_fake_debts AS (
  DELETE FROM public.debts d
  USING public.invoices i
  WHERE d.invoice_id = i.invoice_number
    AND i.payment_type = 'cash'
  RETURNING d.user_id, i.customer_id
)
UPDATE public.customers c
SET total_debt = COALESCE((
  SELECT SUM(d.remaining_debt)
  FROM public.debts d
  WHERE d.user_id = c.user_id
    AND d.customer_name = c.name
    AND d.status NOT IN ('fully_paid', 'cancelled')
), 0)
WHERE c.id IN (SELECT customer_id FROM deleted_fake_debts WHERE customer_id IS NOT NULL);
