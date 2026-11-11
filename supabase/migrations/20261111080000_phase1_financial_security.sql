-- =====================================================================
-- المرحلة 1 من خطة إصلاح المنظومة الحسابية: الأمان والصلاحيات
-- مبنية على التعريفات الحية بتاريخ 2026-11-11 (supabase/live-snapshots/2026-11-11).
-- كل دالة معدّلة هي نسختها الحية حرفياً مع إضافة فحوص الصلاحية المعلّمة بـ "المرحلة 1".
-- لا تغيّر أي بيانات. آمنة لإعادة التشغيل. التراجع: ROLLBACK_phase1.sql في مجلد اللقطة.
--
-- 1. إعادة حساب ربح الفاتورة وعكس أرباح الشركاء: لم تعودا قابلتين للاستدعاء من التطبيق
--    (تبقيان مستخدمتين داخلياً من دوال البيع والمرتجع).
-- 2. توزيع أرباح الشركاء: يتحقق أن الفاتورة لمتجر المتصل، ولا يوزّع فاتورة قديمة.
-- 3. شطب الدين وإقفال الفترة: لمالك المتجر فقط. لا شطب بتحديث مباشر للجدول.
-- 4. قيود الإقفال: قراءة فقط من التطبيق، ولا فترات متداخلة.
-- 5. صلاحية الاسترداد لكل كاشير (الافتراضي: مغلقة).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1) دوال داخلية فقط
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.recalc_pos_invoice_profit(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.revert_invoice_partner_profits_atomic(uuid, numeric) FROM PUBLIC, anon, authenticated;

-- دالة الـ trigger التي تعيد حساب الربح عند إدراج بنود الفاتورة يجب أن تعمل بصلاحية المالك،
-- حتى يبقى إدراج البنود من التطبيق يعمل بعد سحب صلاحية الاستدعاء المباشر أعلاه.
DO $do$
DECLARE
  _fn regprocedure;
BEGIN
  FOR _fn IN
    SELECT t.tgfoid::regprocedure
    FROM pg_trigger t
    WHERE t.tgrelid = 'public.invoice_items'::regclass
      AND t.tgname = 'recalc_pos_invoice_profit_trigger'
      AND NOT t.tgisinternal
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path = public', _fn);
  END LOOP;
END
$do$;

-- ---------------------------------------------------------------------
-- 2) صلاحية الاسترداد لكل كاشير
-- ---------------------------------------------------------------------
ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS can_refund boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.can_refund_invoices(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    _user_id IS NOT NULL
    AND (
      public.get_owner_id(_user_id) = _user_id      -- مالك المتجر
      OR public.is_boss(_user_id)
      OR EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = _user_id AND ur.can_refund = true
      )
    );
$$;

REVOKE EXECUTE ON FUNCTION public.can_refund_invoices(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_refund_invoices(uuid) TO authenticated, service_role;

-- هل المتصل مالك المتجر نفسه (لا كاشير)؟
CREATE OR REPLACE FUNCTION public.is_store_owner(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user_id IS NOT NULL
     AND (public.get_owner_id(_user_id) = _user_id OR public.is_boss(_user_id));
$$;

REVOKE EXECUTE ON FUNCTION public.is_store_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_store_owner(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3) توزيع أرباح الشركاء
-- ---------------------------------------------------------------------
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

  -- المرحلة 1: الفاتورة يجب أن تكون لمتجر المتصل
  IF auth.uid() IS NOT NULL AND public.get_owner_id(auth.uid()) IS DISTINCT FROM _owner THEN
    RAISE EXCEPTION 'غير مصرح' USING ERRCODE = '42501';
  END IF;
  _is_debt := (_inv.payment_type = 'debt' AND COALESCE(_inv.debt_remaining, 0) > 0);

  -- 2. التحقق من عدم التوزيع المسبق لنفس الفاتورة (Idempotency)
  IF EXISTS (
    SELECT 1 FROM public.partners p,
    jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb)) ph
    WHERE p.user_id = _owner AND ph->>'invoiceId' = _inv.invoice_number
  ) THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'invoice_number', _inv.invoice_number);
  END IF;

  -- المرحلة 1: التوزيع يتم لحظة البيع فقط. فاتورة قديمة بلا توزيع لا تُوزَّع لاحقاً بشركاء اليوم
  IF COALESCE(_inv.created_at, now()) < now() - interval '1 hour' THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'invoice_number', _inv.invoice_number, 'skipped', 'stale_invoice');
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

-- ---------------------------------------------------------------------
-- 4) المرتجع الكامل والجزئي
-- ---------------------------------------------------------------------
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

  -- المرحلة 1: الاسترداد لمالك المتجر أو لكاشير منحه المالك الصلاحية
  IF NOT public.can_refund_invoices(auth.uid()) THEN
    RAISE EXCEPTION 'ليست لديك صلاحية الاسترداد. اطلبها من مالك المتجر' USING ERRCODE = '42501';
  END IF;

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
$function$;

-- ---------------------------------------------------------------------
-- 5) شطب الدين
-- ---------------------------------------------------------------------
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

  -- المرحلة 1: شطب الدين لمالك المتجر فقط
  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'شطب الدين مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
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

  -- المرحلة 1: علامة داخلية يتحقق منها حارس جدول الديون
  PERFORM set_config('app.debt_writeoff_internal', '1', true);

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

-- لا شطب بتحديث مباشر لجدول الديون من التطبيق
CREATE OR REPLACE FUNCTION public.guard_debt_writeoff_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'written_off'
     AND OLD.status IS DISTINCT FROM 'written_off'
     AND auth.uid() IS NOT NULL
     AND COALESCE(current_setting('app.debt_writeoff_internal', true), '') <> '1' THEN
    RAISE EXCEPTION 'شطب الدين يتم من شاشة الديون بصلاحية مالك المتجر فقط' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS b_guard_debt_writeoff_status ON public.debts;
CREATE TRIGGER b_guard_debt_writeoff_status
  BEFORE UPDATE OF status ON public.debts
  FOR EACH ROW EXECUTE FUNCTION public.guard_debt_writeoff_status();

-- ---------------------------------------------------------------------
-- 6) إقفال الفترة
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_accounting_period_atomic(_period_start date, _period_end date)
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

  -- المرحلة 1: إقفال الفترة لمالك المتجر فقط، بتواريخ صحيحة، ودون تداخل مع إقفال سابق
  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'إقفال الفترة مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  IF _period_start IS NULL OR _period_end IS NULL OR _period_start > _period_end THEN
    RAISE EXCEPTION 'تواريخ الفترة غير صحيحة';
  END IF;

  IF _period_end > CURRENT_DATE THEN
    RAISE EXCEPTION 'لا يمكن إقفال فترة لم تنتهِ بعد';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.accounting_period_closures c
    WHERE c.user_id = _owner
      AND c.period_start <= _period_end
      AND c.period_end >= _period_start
  ) THEN
    RAISE EXCEPTION 'هذه الفترة تتداخل مع فترة مقفلة سابقاً';
  END IF;

  -- 1) حساب إجمالي الإيرادات
  SELECT 
    COALESCE(SUM(COALESCE(i.total, 0) - COALESCE(i.tax_amount, 0)), 0)
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
  -- الديون المعدومة (المشطوبة) خلال الفترة تُخصم من صافي الربح
  _exp := _exp + COALESCE((SELECT SUM(w.amount) FROM public.debt_writeoffs w
                            WHERE w.user_id = _owner
                              AND w.written_off_at::date BETWEEN _period_start AND _period_end), 0);
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

-- قيود الإقفال: قراءة فقط من التطبيق (الإدراج يتم داخل دالة الإقفال)
DROP POLICY IF EXISTS "Store isolation closures" ON public.accounting_period_closures;
DROP POLICY IF EXISTS "Store members read closures" ON public.accounting_period_closures;
CREATE POLICY "Store members read closures" ON public.accounting_period_closures
  FOR SELECT TO authenticated
  USING (user_id = public.get_owner_id(auth.uid()));

COMMIT;

-- ---------------------------------------------------------------------
-- تحقق بعد التطبيق (قراءة فقط). المتوقع: كل الأعمدة true
-- ---------------------------------------------------------------------
SELECT
  NOT has_function_privilege('authenticated', 'public.recalc_pos_invoice_profit(uuid)', 'EXECUTE') AS recalc_internal_only,
  NOT has_function_privilege('authenticated', 'public.revert_invoice_partner_profits_atomic(uuid,numeric)', 'EXECUTE') AS revert_internal_only,
  position('get_owner_id(auth.uid())' in pg_get_functiondef('public.distribute_invoice_partner_profits_atomic(uuid)'::regprocedure)) > 0 AS distribute_checks_owner,
  position('can_refund_invoices' in pg_get_functiondef('public.refund_invoice_atomic(text,text)'::regprocedure)) > 0 AS refund_checks_permission,
  position('is_store_owner' in pg_get_functiondef('public.writeoff_debt_atomic(uuid,text,text)'::regprocedure)) > 0 AS writeoff_owner_only,
  position('is_store_owner' in pg_get_functiondef('public.close_accounting_period_atomic(date,date)'::regprocedure)) > 0 AS close_owner_only,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'b_guard_debt_writeoff_status') AS writeoff_guard_installed,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_roles' AND column_name = 'can_refund') AS can_refund_column,
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'accounting_period_closures' AND cmd <> 'SELECT') AS closures_read_only;
