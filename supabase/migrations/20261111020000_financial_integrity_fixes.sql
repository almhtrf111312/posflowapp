-- =========================================================================
-- FlowPOS Pro — إصلاحات المنطق المالي (المبيعات، المرتجعات، الشركاء، الديون، المصاريف، الصندوق)
-- مبني على النسخة الحية من الدوال في قاعدة البيانات (تقرير 11 نوفمبر 2026)، وليس على ملفات المشروع القديمة.
-- آمن لإعادة التشغيل. لا يحذف أي جدول أو عمود أو بيانات، ولا يعدّل أرصدة الشركاء القائمة.
-- ينفَّذ كاملاً أو لا شيء (BEGIN/COMMIT).
--
-- مهم: انسخ الملف كما هو (UTF-8). إذا ظهرت النصوص العربية بعد التطبيق كرموز مثل «ط¹ظ…ظٹظ„»
-- فالأداة التي نسختَ بها غيّرت الترميز.
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- 1. normalize_debt_row: الحفاظ على حالة الدين المشطوب أو الملغى
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_debt_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.total_debt := round(coalesce(NEW.total_debt, 0)::numeric, 8);
  NEW.total_paid := round(greatest(coalesce(NEW.total_paid, 0), 0)::numeric, 8);
  NEW.remaining_debt := round(greatest(NEW.total_debt - NEW.total_paid, 0)::numeric, 8);
  -- الحالات النهائية (مشطوب / ملغى): لا مستحق متبقٍ ولا تُعاد الحالة إلى مفتوح
  IF NEW.status IN ('written_off', 'cancelled') THEN
    NEW.remaining_debt := 0;
    RETURN NEW;
  END IF;
  IF NEW.remaining_debt <= 0.00000001 THEN
    NEW.status := 'fully_paid';
    NEW.remaining_debt := 0;
  ELSIF NEW.total_paid > 0 THEN
    NEW.status := 'partially_paid';
  ELSIF NEW.status IS NULL OR NEW.status IN ('fully_paid','partially_paid') THEN
    NEW.status := 'due';
  END IF;
  RETURN NEW;
END $function$;

-- -------------------------------------------------------------------------
-- 2. revert_invoice_partner_profits_atomic: منع العكس المزدوج لأرباح الشركاء
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
          IF round(_amt * (1.0 - _ratio), 8) > 0.00005 THEN
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

    _confirmed_net := GREATEST(round(_orig_share - _pending_now - _already_reverted, 8), 0);
    _confirmed_reverted := CASE WHEN _full THEN _confirmed_net ELSE round(_confirmed_net * _ratio, 8) END;

    IF (_pending_reverted + _confirmed_reverted) > 0 THEN
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
        pending_profit = GREATEST(round(COALESCE(pending_profit, 0) - _pending_reverted, 4), 0),
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
-- 3. record_debt_payment_atomic: منع احتساب أرباح الشريك مرتين في التقارير بعد السداد الكامل
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

-- -------------------------------------------------------------------------
-- 4. refund_invoice_partial_atomic: الكرتونة، الربح دون ضريبة، منع التكرار
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
  IF COALESCE(_inv.profit, 0) > 0 THEN
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
-- 5. cancel_debt_atomic: إصلاح عمود customer_id غير الموجود ومنع تحويل الدين إلى بيع نقدي
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_debt_atomic(_debt_id uuid, _reason text DEFAULT 'إلغاء الدين'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_owner uuid := public.get_owner_id(auth.uid());
  v_debt public.debts%ROWTYPE;
BEGIN
  IF v_caller IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  SELECT * INTO v_debt FROM public.debts WHERE id = _debt_id FOR UPDATE;
  IF NOT FOUND OR v_debt.user_id <> v_owner THEN
    RAISE EXCEPTION 'الدين غير موجود';
  END IF;

  IF v_debt.status IN ('cancelled', 'written_off') THEN
    RETURN jsonb_build_object('success', true, 'already_closed', true, 'debt_id', _debt_id);
  END IF;

  -- الدين المرتبط بفاتورة بيع لا يُلغى مباشرة حتى لا تبقى الفاتورة وأرباح الشركاء معلقة
  IF v_debt.invoice_id IS NOT NULL AND NOT COALESCE(v_debt.is_cash_debt, false)
     AND EXISTS (SELECT 1 FROM public.invoices i
                  WHERE i.user_id = v_owner
                    AND (i.invoice_number = v_debt.invoice_id OR i.id::text = v_debt.invoice_id)
                    AND COALESCE(i.status, '') NOT IN ('refunded', 'cancelled')) THEN
    RAISE EXCEPTION 'هذا الدين مرتبط بالفاتورة %: استخدم «تسديد» إذا دفع العميل، أو «استرداد الفاتورة» إذا أُلغي البيع، أو «شطب الدين» إذا تعذر التحصيل', v_debt.invoice_id;
  END IF;

  -- تخفيض رصيد العميل بالمتبقي
  IF COALESCE(v_debt.remaining_debt, 0) > 0 AND v_debt.customer_name IS NOT NULL THEN
    UPDATE public.customers
       SET total_debt = GREATEST(0, round(COALESCE(total_debt, 0) - COALESCE(v_debt.remaining_debt, 0), 8)),
           updated_at = now()
     WHERE user_id = v_owner
       AND (name = v_debt.customer_name OR (v_debt.customer_phone IS NOT NULL AND phone = v_debt.customer_phone));
  END IF;

  -- وسم الدين كملغى مع الاحتفاظ بالسجل
  UPDATE public.debts
     SET status = 'cancelled',
         notes = concat_ws(E'\n', notes, '[ملغى] ' || COALESCE(_reason, 'إلغاء الدين')),
         updated_at = now()
   WHERE id = _debt_id;

  RETURN jsonb_build_object('success', true, 'debt_id', _debt_id, 'cancelled_amount', COALESCE(v_debt.remaining_debt, 0));
END;
$function$;

-- -------------------------------------------------------------------------
-- 6. writeoff_debt_atomic: توثيق مبلغ الشطب في سجل الديون المعدومة
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
       WHERE user_id = _owner AND pending_profit > 0 
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

-- -------------------------------------------------------------------------
-- 7. add_expense_atomic: منع خصم المصروف من الوردية مرتين
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_expense_atomic(_operation_id text, _expense_type text, _amount numeric, _description text DEFAULT NULL::text, _date date DEFAULT CURRENT_DATE, _notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _owner uuid;
  _op_uuid uuid;
  _amt numeric := round(coalesce(_amount, 0), 2);
  _dist jsonb := '[]'::jsonb;
  p record;
  _pct numeric;
  _part numeric;
  _active_shift_id uuid;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF _amt <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;

  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN RAISE EXCEPTION 'لم يتم العثور على حساب المالك'; END IF;

  -- تحويل المعرف إلى UUID بأمان
  BEGIN
    _op_uuid := _operation_id::uuid;
  EXCEPTION WHEN OTHERS THEN
    _op_uuid := gen_random_uuid();
  END;

  -- منع التكرار (Idempotency)
  IF EXISTS (SELECT 1 FROM public.expenses WHERE id = _op_uuid) THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'id', _op_uuid);
  END IF;

  -- استقطاع حصص الشركاء المشاركين في المصاريف
  FOR p IN 
    SELECT * FROM public.partners 
    WHERE user_id = _owner 
    FOR UPDATE 
  LOOP
    -- استخدام نسبة المصاريف إن وُجدت، أو النسبة العامة
    _pct := coalesce(p.expense_share_percentage, p.share_percentage, 0);

    IF _pct > 0 THEN
      -- حساب حصة الشريك: القيمة * (النسبة / 100)
      _part := round(_amt * (_pct / 100.0), 2);

      IF _part > 0 THEN
        _dist := _dist || jsonb_build_object(
          'partnerId', p.id,
          'partnerName', p.name,
          'amount', _part,
          'percentage', _pct
        );

        -- خصم الحصة من رصيد الشريك وتسجيلها في مصفوفة تاريخ المصاريف
        UPDATE public.partners SET
          current_balance = round(coalesce(current_balance, 0) - _part, 2),
          expense_history = coalesce(expense_history, '[]'::jsonb) || jsonb_build_object(
            'expenseId', _op_uuid::text,
            'type', _expense_type,
            'amount', _part,
            'date', coalesce(_date, CURRENT_DATE),
            'notes', coalesce(_notes, _description, ''),
            'createdAt', now()
          ),
          updated_at = now()
        WHERE id = p.id;
      END IF;
    END IF;
  END LOOP;

  -- إدراج سجل المصروف بتوزيعاته
  INSERT INTO public.expenses(
    id, user_id, expense_type, amount, description, date, notes, distributions, cashier_id
  ) VALUES (
    _op_uuid, _owner, _expense_type, _amt, _description, coalesce(_date, CURRENT_DATE), _notes, _dist, _uid
  );

  -- حركة الصندوق تسجلها الواجهة مرة واحدة بعملة المصروف الأصلية (منع الخصم المزدوج من الوردية)

  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'id', _op_uuid,
    'distributions', _dist
  );
END;
$function$;

-- -------------------------------------------------------------------------
-- 8. close_cash_shift_atomic: احتساب المصاريف الملغاة كمبالغ عائدة للصندوق
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_cash_shift_atomic(_shift_id uuid, _actual_balance numeric, _variance_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _shift record;
  _calc_expected numeric := 0;
  _inflow numeric := 0;
  _outflow numeric := 0;
  _variance numeric := 0;
  _status text := 'matched';
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  -- 1) قفل سجل الوردية
  SELECT * INTO _shift 
    FROM public.cash_shifts 
   WHERE id = _shift_id AND user_id = _owner 
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'الوردية غير موجودة أو لا تتبع للمتجر';
  END IF;

  IF _shift.closed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true, 
      'already_closed', true, 
      'shift_id', _shift_id
    );
  END IF;

  -- 2) حساب التدفقات المالية الداخلة (Sales, Deposits, Debt Payments, Surplus)
  SELECT COALESCE(SUM(amount), 0) INTO _inflow
    FROM public.shift_transactions
   WHERE shift_id = _shift_id 
     AND type IN ('sale', 'deposit_capital', 'deposit_revenue', 'deposit_purchase_cover', 'debt_payment', 'surplus', 'expense_refund');

  -- 3) حساب التدفقات المالية الخارجة (Expenses, Refunds, Withdrawals, Shortage)
  SELECT COALESCE(SUM(amount), 0) INTO _outflow
    FROM public.shift_transactions
   WHERE shift_id = _shift_id 
     AND type IN ('expense', 'refund', 'withdrawal', 'shortage');

  -- 4) احتساب الرصيد المتوقع والفارق
  _calc_expected := round(COALESCE(_shift.opening_balance, 0) + _inflow - _outflow, 2);
  _variance := round(COALESCE(_actual_balance, 0) - _calc_expected, 2);

  IF abs(_variance) >= 0.01 THEN
    _status := CASE WHEN _variance_reason IS NOT NULL AND length(trim(_variance_reason)) > 0 THEN 'matched' ELSE 'unmatched' END;
    
    -- تسجيل حركة تسوية بالصندوق لتوثيق الفارق في سجل الحركات
    IF _variance > 0 THEN
      INSERT INTO public.shift_transactions (
        shift_id, user_id, type, amount, notes, created_at
      ) VALUES (
        _shift_id, _owner, 'surplus', _variance, 
        'فائض صندوق عند الإقفال: ' || COALESCE(_variance_reason, ''), now()
      );
    ELSE
      INSERT INTO public.shift_transactions (
        shift_id, user_id, type, amount, notes, created_at
      ) VALUES (
        _shift_id, _owner, 'shortage', abs(_variance), 
        'عجز صندوق عند الإقفال: ' || COALESCE(_variance_reason, ''), now()
      );
    END IF;
  END IF;

  -- 5) إقفال الوردية وتحديث الرصيد الفعلي والمتوقع والحالة
  UPDATE public.cash_shifts
     SET closed_at = now(),
         expected_balance = _calc_expected,
         actual_balance = round(COALESCE(_actual_balance, 0), 2),
         variance = _variance,
         variance_reason = _variance_reason,
         reconciliation_status = _status,
         updated_at = now()
   WHERE id = _shift_id;

  RETURN jsonb_build_object(
    'success', true,
    'shift_id', _shift_id,
    'opening_balance', _shift.opening_balance,
    'expected_balance', _calc_expected,
    'actual_balance', _actual_balance,
    'variance', _variance,
    'status', _status
  );
END;
$function$;

-- -------------------------------------------------------------------------
-- 9. partner_withdrawal_atomic: إزالة تحديث أعمدة غير موجودة كانت تُفشل السحب عند فتح وردية
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_withdrawal_atomic(_partner_id uuid, _amount numeric, _withdrawal_type text, _notes text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT 'USD'::text, _original_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT 1.0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_owner uuid := public.get_owner_id(v_caller);
  v_partner public.partners%ROWTYPE;
  v_amt numeric := round(COALESCE(_amount, 0)::numeric, 2);
  v_orig_amt numeric := round(COALESCE(_original_amount, v_amt)::numeric, 2);
  v_rate numeric := COALESCE(_exchange_rate, 1.0);
  v_withdrawal_record jsonb;
  v_capital_record jsonb;
  v_note_text text;
BEGIN
  IF v_caller IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF v_amt <= 0 THEN
    RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر';
  END IF;

  SELECT * INTO v_partner FROM public.partners WHERE id = _partner_id FOR UPDATE;
  IF NOT FOUND OR v_partner.user_id <> v_owner THEN
    RAISE EXCEPTION 'الشريك غير موجود أو غير تابع للمتجر';
  END IF;

  v_note_text := COALESCE(_notes, '');
  IF _currency <> 'USD' AND v_orig_amt IS NOT NULL THEN
    v_note_text := v_note_text || ' (' || v_orig_amt::text || ' ' || _currency || ')';
  END IF;

  v_withdrawal_record := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'amount', v_amt,
    'currency', _currency,
    'originalAmount', v_orig_amt,
    'exchangeRate', v_rate,
    'type', _withdrawal_type,
    'date', now()::text,
    'notes', v_note_text
  );

  IF _withdrawal_type = 'profit' THEN
    IF v_amt > COALESCE(v_partner.current_balance, 0) THEN
      RAISE EXCEPTION 'رصيد أرباح الشريك لا يكفي (المتاح: %)', v_partner.current_balance;
    END IF;

    UPDATE public.partners
       SET current_balance = round(current_balance - v_amt, 2),
           total_withdrawn = round(COALESCE(total_withdrawn, 0) + v_amt, 2),
           withdrawal_history = COALESCE(withdrawal_history, '[]'::jsonb) || v_withdrawal_record,
           updated_at = now()
     WHERE id = _partner_id;

  ELSIF _withdrawal_type = 'capital' THEN
    IF v_amt > COALESCE(v_partner.current_capital, 0) THEN
      RAISE EXCEPTION 'رأس مال الشريك لا يكفي (المتاح: %)', v_partner.current_capital;
    END IF;

    v_capital_record := jsonb_build_object(
      'id', gen_random_uuid()::text || '_cap',
      'amount', v_amt,
      'currency', _currency,
      'originalAmount', v_orig_amt,
      'exchangeRate', v_rate,
      'type', 'withdrawal',
      'date', now()::text,
      'notes', v_note_text
    );

    UPDATE public.partners
       SET current_capital = round(current_capital - v_amt, 2),
           total_withdrawn = round(COALESCE(total_withdrawn, 0) + v_amt, 2),
           withdrawal_history = COALESCE(withdrawal_history, '[]'::jsonb) || v_withdrawal_record,
           capital_history = COALESCE(capital_history, '[]'::jsonb) || v_capital_record,
           updated_at = now()
     WHERE id = _partner_id;
  ELSE
    RAISE EXCEPTION 'نوع السحب غير صالح: %', _withdrawal_type;
  END IF;

  -- تسجيل حركة السحب في الوردية النقدية بالعملة المناسبة
  IF _shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions (
      shift_id,
      user_id,
      type,
      amount,
      currency_amount,
      currency,
      exchange_rate,
      notes,
      reference_id
    ) VALUES (
      _shift_id,
      v_owner,
      'withdrawal',
      v_amt,
      v_orig_amt,
      _currency,
      v_rate,
      'سحب ' || CASE WHEN _withdrawal_type = 'capital' THEN 'رأس مال' ELSE 'أرباح' END || ' للشريك: ' || v_partner.name || CASE WHEN v_note_text <> '' THEN ' - ' || v_note_text ELSE '' END,
      _partner_id::text
    );

    -- الرصيد المتوقع للوردية يُحسب عند الإقفال من حركات الوردية (أعمدة expected_cash/try/syp غير موجودة)
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'partner_id', _partner_id,
    'amount', v_amt,
    'currency', _currency,
    'original_amount', v_orig_amt,
    'withdrawal_type', _withdrawal_type,
    'new_balance', CASE WHEN _withdrawal_type = 'profit' THEN round(v_partner.current_balance - v_amt, 2) ELSE v_partner.current_balance END,
    'new_capital', CASE WHEN _withdrawal_type = 'capital' THEN round(v_partner.current_capital - v_amt, 2) ELSE v_partner.current_capital END
  );
END;
$function$;

-- -------------------------------------------------------------------------
-- 10.1. partner_deposit_atomic: إزالة تحديث أعمدة غير موجودة كانت تُفشل الإيداع عند فتح وردية
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_deposit_atomic(_partner_id uuid, _amount_usd numeric, _deposit_target text DEFAULT 'capital'::text, _notes text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT 'USD'::text, _original_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT 1.0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _owner uuid;
  _partner record;
  _tx_id text := gen_random_uuid()::text;
  _amt_usd numeric := round(COALESCE(_amount_usd, 0), 2);
  _orig_amt numeric := round(COALESCE(_original_amount, _amt_usd), 2);
  _rate numeric := COALESCE(_exchange_rate, 1.0);
  _cap_record jsonb;
  _tx_note text;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير مسجل الدخول';
  END IF;

  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'لم يتم العثور على حساب المالك';
  END IF;

  IF _amt_usd <= 0 THEN
    RAISE EXCEPTION 'مبلغ الإيداع يجب أن يكون أكبر من الصفر';
  END IF;

  -- قفل سجل الشريك لمنع تضارب العمليات المتزامنة
  SELECT * INTO _partner
  FROM public.partners
  WHERE id = _partner_id AND user_id = _owner
  FOR UPDATE;

  IF _partner IS NULL THEN
    RAISE EXCEPTION 'الشريك غير موجود أو غير تابع لهذا المتجر';
  END IF;

  _tx_note := COALESCE(_notes, CASE WHEN _deposit_target = 'balance' THEN 'إيداع رصيد للشريك' ELSE 'إيداع رأس مال' END);
  IF _currency <> 'USD' AND _orig_amt IS NOT NULL THEN
    _tx_note := _tx_note || ' (' || _orig_amt::text || ' ' || _currency || ')';
  END IF;

  _cap_record := jsonb_build_object(
    'id', _tx_id,
    'amount', _amt_usd,
    'type', 'deposit',
    'target', _deposit_target,
    'currency', _currency,
    'originalAmount', _orig_amt,
    'exchangeRate', _rate,
    'date', now(),
    'notes', _tx_note
  );

  -- تحديث سجل الشريك بحسب وجهة الإيداع
  IF _deposit_target = 'balance' THEN
    UPDATE public.partners SET
      current_balance = round(COALESCE(current_balance, 0) + _amt_usd, 2),
      capital_history = COALESCE(capital_history, '[]'::jsonb) || _cap_record,
      updated_at = now()
    WHERE id = _partner_id;
  ELSE
    UPDATE public.partners SET
      initial_capital = round(COALESCE(initial_capital, 0) + _amt_usd, 2),
      current_capital = round(COALESCE(current_capital, 0) + _amt_usd, 2),
      capital_history = COALESCE(capital_history, '[]'::jsonb) || _cap_record,
      updated_at = now()
    WHERE id = _partner_id;
  END IF;

  -- قيد الحركة النقدية في وردية الصندوق المفتوحة إن وجدت
  IF _shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions (
      shift_id,
      user_id,
      type,
      amount,
      currency_amount,
      currency,
      exchange_rate,
      notes,
      reference_id
    ) VALUES (
      _shift_id,
      _owner,
      'deposit',
      _amt_usd,
      _orig_amt,
      _currency,
      _rate,
      _tx_note || ' - الشريك: ' || _partner.name,
      _partner_id::text
    );

    -- تعديل رصيد الصندوق المتوقع حسب العملة
    -- الرصيد المتوقع للوردية يُحسب عند الإقفال من حركات الوردية (أعمدة expected_cash/try/syp غير موجودة)
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'partner_id', _partner_id,
    'amount_usd', _amt_usd,
    'currency', _currency,
    'original_amount', _orig_amt,
    'deposit_target', _deposit_target,
    'new_balance', CASE WHEN _deposit_target = 'balance' THEN round(COALESCE(_partner.current_balance, 0) + _amt_usd, 2) ELSE _partner.current_balance END,
    'new_capital', CASE WHEN _deposit_target = 'capital' THEN round(COALESCE(_partner.current_capital, 0) + _amt_usd, 2) ELSE _partner.current_capital END
  );
END;
$function$;

-- -------------------------------------------------------------------------
-- 10.2. partner_deposit_atomic: إزالة تحديث أعمدة غير موجودة كانت تُفشل الإيداع عند فتح وردية
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_deposit_atomic(_partner_id uuid, _amount_usd numeric, _deposit_target text DEFAULT 'capital'::text, _notes text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT 'USD'::text, _original_amount numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _owner uuid;
  _partner record;
  _tx_id text := gen_random_uuid()::text;
  _orig_amt numeric := COALESCE(_original_amount, _amount_usd);
  _cap_record jsonb;
  _tx_note text;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير مسجل الدخول';
  END IF;

  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'لم يتم العثور على حساب المالك';
  END IF;

  IF _amount_usd IS NULL OR _amount_usd <= 0 THEN
    RAISE EXCEPTION 'مبلغ الإيداع يجب أن يكون أكبر من الصفر';
  END IF;

  -- قفل سجل الشريك للحماية من تضارب المعاملات
  SELECT * INTO _partner
  FROM public.partners
  WHERE id = _partner_id AND user_id = _owner
  FOR UPDATE;

  IF _partner IS NULL THEN
    RAISE EXCEPTION 'الشريك غير موجود أو غير تابع لهذا المتجر';
  END IF;

  _tx_note := COALESCE(_notes, CASE WHEN _deposit_target = 'balance' THEN 'إيداع رصيد للشريك' ELSE 'إيداع رأس مال' END);
  IF _currency <> 'USD' AND _orig_amt IS NOT NULL THEN
    _tx_note := _tx_note || ' (' || _orig_amt::text || ' ' || _currency || ')';
  END IF;

  _cap_record := jsonb_build_object(
    'id', _tx_id,
    'amount', round(_amount_usd, 2),
    'type', 'deposit',
    'target', _deposit_target,
    'currency', _currency,
    'originalAmount', _orig_amt,
    'date', now(),
    'notes', _tx_note
  );

  -- 1) تحديث سجل الشريك بحسب وجهة الإيداع
  IF _deposit_target = 'balance' THEN
    UPDATE public.partners SET
      current_balance = round(COALESCE(current_balance, 0) + _amount_usd, 2),
      capital_history = COALESCE(capital_history, '[]'::jsonb) || _cap_record,
      updated_at = now()
    WHERE id = _partner_id;
  ELSE
    UPDATE public.partners SET
      initial_capital = round(COALESCE(initial_capital, 0) + _amount_usd, 2),
      current_capital = round(COALESCE(current_capital, 0) + _amount_usd, 2),
      capital_history = COALESCE(capital_history, '[]'::jsonb) || _cap_record,
      updated_at = now()
    WHERE id = _partner_id;
  END IF;

  -- 2) تسجيل الحركة في وردية الصندوق المفتوحة إن وجدت
  IF _shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions (
      shift_id,
      type,
      amount,
      amount_usd,
      currency,
      notes,
      reference_id,
      created_by
    ) VALUES (
      _shift_id,
      'deposit',
      round(_orig_amt, 2),
      round(_amount_usd, 2),
      _currency,
      _tx_note || ' - الشريك: ' || _partner.name,
      _partner_id::text,
      _uid
    );

    -- تحديث رصيد الصندوق بالعملة المناسبة
    -- الرصيد المتوقع للوردية يُحسب عند الإقفال من حركات الوردية (أعمدة expected_cash/try/syp غير موجودة)
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'partner_id', _partner_id,
    'amount_usd', round(_amount_usd, 2),
    'deposit_target', _deposit_target,
    'new_balance', CASE WHEN _deposit_target = 'balance' THEN round(COALESCE(_partner.current_balance, 0) + _amount_usd, 2) ELSE _partner.current_balance END,
    'new_capital', CASE WHEN _deposit_target = 'capital' THEN round(COALESCE(_partner.current_capital, 0) + _amount_usd, 2) ELSE _partner.current_capital END
  );
END;
$function$;

-- -------------------------------------------------------------------------
-- 11. close_accounting_period_atomic: الإيراد دون الضريبة وخصم الديون المعدومة
-- -------------------------------------------------------------------------
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

NOTIFY pgrst, 'reload schema';

COMMIT;

-- =========================================================================
-- التحقق بعد التنفيذ: يجب أن تكون كل القيم true
-- =========================================================================
SELECT
  position('pendingReverted' in pg_get_functiondef('public.revert_invoice_partner_profits_atomic(uuid,numeric)'::regprocedure)) > 0 AS revert_fixed,
  position('_unit_factor' in pg_get_functiondef('public.refund_invoice_partial_atomic(text,jsonb,text)'::regprocedure)) > 0 AS partial_refund_fixed,
  position('customer_id' in pg_get_functiondef('public.cancel_debt_atomic(uuid,text)'::regprocedure)) = 0 AS cancel_debt_fixed,
  position('expected_cash' in pg_get_functiondef('public.partner_withdrawal_atomic(uuid,numeric,text,text,uuid,text,numeric,numeric)'::regprocedure)) = 0 AS withdrawal_fixed,
  position('written_off' in pg_get_functiondef('public.normalize_debt_row()'::regprocedure)) > 0 AS debt_status_fixed,
  position('عميل نقدي' in pg_get_functiondef('public.process_pos_sale_atomic(text,text,text,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text,uuid,jsonb,numeric,numeric,text)'::regprocedure)) > 0 AS sale_function_arabic_ok;

-- =========================================================================
-- استعلام تشخيصي (قراءة فقط) — أرباح شركاء يُشتبه أنها سُجلت مرتين في الماضي
-- كانت نقطة البيع توزّع الأرباح من التطبيق برقم فاتورة محلي (مثل INV-2026-001)
-- إضافة إلى التوزيع الذي يقوم به الخادم برقم الفاتورة الحقيقي.
-- هذا الاستعلام لا يغيّر شيئاً؛ راجع النتيجة قبل أي تصحيح للأرصدة.
-- =========================================================================
SELECT p.name AS partner_name,
       count(*) AS suspected_records,
       round(sum((x->>'amount')::numeric) FILTER (WHERE NOT COALESCE((x->>'isDebt')::boolean, false)), 2) AS suspected_confirmed_amount,
       round(sum((x->>'amount')::numeric) FILTER (WHERE COALESCE((x->>'isDebt')::boolean, false)), 2) AS suspected_pending_amount,
       min(x->>'createdAt') AS first_seen,
       max(x->>'createdAt') AS last_seen
FROM public.partners p
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb)) x
WHERE COALESCE((x->>'isReversal')::boolean, false) = false
  AND COALESCE(x->>'id', '') NOT LIKE '%-rel'
  AND x->>'invoiceId' ~ '^INV-[0-9]{4}-[0-9]+$'
  AND NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.user_id = p.user_id AND i.invoice_number = x->>'invoiceId')
GROUP BY p.name
ORDER BY suspected_confirmed_amount DESC NULLS LAST;
