-- Migration: 20261122190000_periods_guards_and_fx_hardening
-- 1. Harden public.assert_period_open__impl: VOLATILE + shared advisory xact lock
CREATE OR REPLACE FUNCTION public.assert_period_open__impl(
  _owner uuid,
  _date date,
  _what text DEFAULT 'العملية'::text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record;
BEGIN
  IF _owner IS NULL OR _date IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock_shared(hashtext('close_accounting_period:' || _owner::text));

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

REVOKE ALL ON FUNCTION public.assert_period_open__impl(uuid, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_period_open__impl(uuid, date, text) TO service_role;

-- 2. Fix point-in-time snapshot accuracy in public.close_accounting_period_atomic
CREATE OR REPLACE FUNCTION public.close_accounting_period_atomic(
  _period_start date,
  _period_end date,
  _timezone text DEFAULT 'UTC'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _tz text := COALESCE(NULLIF(trim(_timezone), ''), 'UTC');
  _rev numeric := 0;
  _cogs numeric := 0;
  _exp numeric := 0;
  _gross numeric := 0;
  _realized numeric := 0;
  _pending numeric := 0;
  _bad_debt numeric := 0;
  _net numeric := 0;
  _partner_summary jsonb := '[]'::jsonb;
  _closure_id uuid;
  p record;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'إقفال الفترة مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  BEGIN
    PERFORM now() AT TIME ZONE _tz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'المنطقة الزمنية غير صحيحة: %', _tz;
  END;

  IF _period_start IS NULL OR _period_end IS NULL OR _period_start > _period_end THEN
    RAISE EXCEPTION 'تواريخ الفترة غير صحيحة';
  END IF;
  IF _period_end >= (now() AT TIME ZONE _tz)::date THEN
    RAISE EXCEPTION 'لا يمكن إقفال فترة لم تنتهِ بعد';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('close_accounting_period:' || _owner::text));

  IF EXISTS (
    SELECT 1 FROM public.accounting_period_closures c
    WHERE c.user_id = _owner
      AND c.period_start <= _period_end
      AND c.period_end >= _period_start
  ) THEN
    RAISE EXCEPTION 'هذه الفترة تتداخل مع فترة مقفلة سابقاً';
  END IF;

  WITH inv AS (
    SELECT i.id, i.invoice_number,
           (i.created_at AT TIME ZONE _tz)::date AS sale_day,
           COALESCE(i.total, 0) AS total,
           COALESCE(i.tax_amount, 0) AS tax,
           COALESCE(i.profit, 0) AS profit,
           i.payment_type, i.status,
           CASE WHEN i.status = 'paid' THEN COALESCE(i.total, 0)
                ELSE LEAST(GREATEST(COALESCE(i.debt_paid, 0), 0), COALESCE(i.total, 0)) END AS paid_by_invoice
      FROM public.invoices i
     WHERE i.user_id = _owner
       AND i.status NOT IN ('refunded', 'cancelled')
       AND COALESCE(i.invoice_type, 'sale') IN ('sale', 'maintenance')
  ),
  credit AS (
    SELECT * FROM inv WHERE payment_type = 'debt' AND total > 0
  ),
  pay_exists AS (
    SELECT DISTINCT c.id AS invoice_id
      FROM credit c
      JOIN public.debts d
        ON d.user_id = _owner
       AND NOT COALESCE(d.is_cash_debt, false)
       AND (d.invoice_id = c.invoice_number OR d.invoice_id = c.id::text)
      JOIN public.debt_payments dp ON dp.debt_id = d.id
     WHERE COALESCE(dp.amount, 0) > 0
  ),
  pay AS (
    SELECT c.id AS invoice_id,
           dp.amount,
           (dp.created_at AT TIME ZONE _tz)::date AS pay_day,
           SUM(dp.amount) OVER (PARTITION BY c.id ORDER BY dp.created_at, dp.id) - dp.amount AS paid_before
      FROM credit c
      JOIN public.debts d
        ON d.user_id = _owner
       AND NOT COALESCE(d.is_cash_debt, false)
       AND (d.invoice_id = c.invoice_number OR d.invoice_id = c.id::text)
      JOIN public.debt_payments dp ON dp.debt_id = d.id
     WHERE COALESCE(dp.amount, 0) > 0
       AND (dp.created_at AT TIME ZONE _tz)::date <= _period_end
  ),
  credit_paid AS (
    SELECT c.*,
           CASE
             WHEN pe.invoice_id IS NOT NULL THEN LEAST(c.total, COALESCE(ds.dated_sum, 0))
             ELSE c.paid_by_invoice
           END AS paid_total,
           COALESCE(ds.dated_sum, 0) AS dated_sum,
           EXISTS (
              SELECT 1 FROM public.debt_writeoffs w
               LEFT JOIN public.debts wd ON wd.id = w.debt_id
              WHERE w.user_id = _owner
                AND (w.written_off_at AT TIME ZONE _tz)::date <= _period_end
                AND COALESCE(wd.invoice_id, w.notes) IN (c.invoice_number, c.id::text)
                AND NOT COALESCE(wd.is_cash_debt, false)
           ) AS is_written_off
      FROM credit c
      LEFT JOIN (SELECT invoice_id, SUM(amount) AS dated_sum FROM pay GROUP BY invoice_id) ds
        ON ds.invoice_id = c.id
      LEFT JOIN pay_exists pe
        ON pe.invoice_id = c.id
  ),
  alloc AS (
    SELECT pm.pay_day,
           GREATEST(0, LEAST(pm.amount, cp.paid_total - pm.paid_before)) AS amount,
           cp.profit, cp.total
      FROM pay pm
      JOIN credit_paid cp ON cp.id = pm.invoice_id
  )
  SELECT
    COALESCE((SELECT SUM(total - tax) FROM inv
               WHERE sale_day BETWEEN _period_start AND _period_end), 0),
    COALESCE((SELECT SUM(profit) FROM inv
               WHERE NOT (payment_type IS NOT DISTINCT FROM 'debt' AND total > 0)
                 AND sale_day BETWEEN _period_start AND _period_end), 0)
    + COALESCE((SELECT SUM(profit * (paid_total - LEAST(dated_sum, paid_total)) / total) FROM credit_paid
                 WHERE sale_day BETWEEN _period_start AND _period_end), 0)
    + COALESCE((SELECT SUM(profit * amount / total) FROM alloc
                 WHERE pay_day BETWEEN _period_start AND _period_end), 0),
    COALESCE((SELECT SUM(profit * (total - paid_total) / total) FROM credit_paid
               WHERE NOT is_written_off AND sale_day <= _period_end), 0)
    INTO _rev, _realized, _pending;

  SELECT
    COALESCE(SUM(COALESCE(ii.cost_price, 0) * COALESCE(ii.quantity, 0)), 0)
    INTO _cogs
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE i.user_id = _owner
     AND i.status NOT IN ('refunded', 'cancelled')
     AND COALESCE(i.invoice_type, 'sale') IN ('sale', 'maintenance')
     AND (i.created_at AT TIME ZONE _tz)::date BETWEEN _period_start AND _period_end;

  SELECT COALESCE(SUM(amount), 0) INTO _exp
    FROM public.expenses
   WHERE user_id = _owner
     AND COALESCE(is_reversed, false) = false
     AND date BETWEEN _period_start AND _period_end;

  SELECT COALESCE(SUM(
           COALESCE(
             w.loss_amount,
             CASE WHEN x.total > 0
                  THEN COALESCE(w.amount, 0) - x.profit * LEAST(COALESCE(w.amount, 0), x.total) / x.total
                  ELSE COALESCE(w.amount, 0) END
           )), 0)
    INTO _bad_debt
    FROM public.debt_writeoffs w
    LEFT JOIN public.debts d ON d.id = w.debt_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(i.total, 0) AS total, COALESCE(i.profit, 0) AS profit, i.status
        FROM public.invoices i
       WHERE i.user_id = _owner
         AND NOT COALESCE(d.is_cash_debt, false)
         AND COALESCE(d.invoice_id, w.notes) IS NOT NULL
         AND (i.invoice_number = COALESCE(d.invoice_id, w.notes) OR i.id::text = COALESCE(d.invoice_id, w.notes))
       ORDER BY i.created_at
       LIMIT 1
    ) x ON true
   WHERE w.user_id = _owner
     AND (w.written_off_at AT TIME ZONE _tz)::date BETWEEN _period_start AND _period_end
     AND COALESCE(x.status, '') NOT IN ('refunded', 'cancelled');

  _rev := round(_rev, 8);
  _cogs := round(_cogs, 8);
  _exp := round(_exp, 8);
  _gross := round(_rev - _cogs, 8);
  _realized := round(_realized, 8);
  _pending := round(_pending, 8);
  _bad_debt := round(_bad_debt, 8);
  _net := round(_realized - _exp - _bad_debt, 8);

  FOR p IN
    SELECT
      pr.id,
      pr.name,
      round(COALESCE(pr.current_balance, 0) - COALESCE(post.d_current_balance, 0), 8) AS current_balance,
      round(COALESCE(pr.confirmed_profit, 0) - COALESCE(post.d_confirmed_profit, 0), 8) AS confirmed_profit,
      round(COALESCE(pr.total_profit_earned, 0) - COALESCE(post.d_total_profit_earned, 0), 8) AS total_profit_earned
    FROM public.partners pr
    LEFT JOIN LATERAL (
      SELECT
        SUM(ple.d_current_balance) AS d_current_balance,
        SUM(ple.d_confirmed_profit) AS d_confirmed_profit,
        SUM(ple.d_total_profit_earned) AS d_total_profit_earned
      FROM public.partner_ledger_entries ple
      WHERE ple.user_id = _owner
        AND ple.partner_id = pr.id
        AND ple.created_at >= ((_period_end + 1)::timestamp AT TIME ZONE _tz)
    ) post ON true
    WHERE pr.user_id = _owner
  LOOP
    _partner_summary := _partner_summary || jsonb_build_object(
      'partner_id', p.id,
      'partner_name', p.name,
      'current_balance', p.current_balance,
      'confirmed_profit', p.confirmed_profit,
      'total_earned', p.total_profit_earned
    );
  END LOOP;

  INSERT INTO public.accounting_period_closures (
    user_id, period_start, period_end, total_revenue, total_cogs,
    gross_profit, total_expenses, net_profit, partner_distributions, closed_by,
    realized_profit, pending_profit, bad_debt_loss, closing_timezone
  ) VALUES (
    _owner, _period_start, _period_end, _rev, _cogs,
    _gross, _exp, _net, _partner_summary, _caller,
    _realized, _pending, _bad_debt, _tz
  ) RETURNING id INTO _closure_id;

  RETURN jsonb_build_object(
    'success', true,
    'closure_id', _closure_id,
    'period_start', _period_start,
    'period_end', _period_end,
    'timezone', _tz,
    'revenue', _rev,
    'cogs', _cogs,
    'gross_profit', _gross,
    'realized_profit', _realized,
    'pending_profit', _pending,
    'expenses', _exp,
    'bad_debt_loss', _bad_debt,
    'net_profit', _net,
    'partners', _partner_summary
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.close_accounting_period_atomic(date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_accounting_period_atomic(date, date, text) TO authenticated, service_role;

-- 3. Closed-period write guard trigger on public.expenses
CREATE OR REPLACE FUNCTION public.trg_expenses_assert_period_open()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.assert_period_open(OLD.user_id, OLD.date, 'تعديل المصروفات');
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.date IS DISTINCT FROM NEW.date THEN
    PERFORM public.assert_period_open(OLD.user_id, OLD.date, 'تعديل المصروفات');
  END IF;

  PERFORM public.assert_period_open(COALESCE(NEW.user_id, OLD.user_id), COALESCE(NEW.date, OLD.date), 'تعديل المصروفات');
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_expenses_assert_period_open() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trg_expenses_assert_period_open() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_expenses_assert_period_open ON public.expenses;
CREATE TRIGGER trg_expenses_assert_period_open
  BEFORE INSERT OR UPDATE OR DELETE ON public.expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_expenses_assert_period_open();

-- 4. Multi-currency cross-check in payout_store_credit_atomic, pay_supplier_atomic, supplier_refund_atomic
CREATE OR REPLACE FUNCTION public.payout_store_credit_atomic(
  _customer_id uuid,
  _amount numeric,
  _shift_id uuid,
  _operation_id text,
  _currency text DEFAULT 'USD'::text,
  _currency_amount numeric DEFAULT NULL::numeric,
  _rate numeric DEFAULT NULL::numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _o uuid := public._credit_actor(true);
  _id uuid;
  _bal numeric;
  _amt numeric := round(COALESCE(_amount, 0), 4);
  _ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  _eff_rate numeric;
  _eff_ccy_amt numeric;
BEGIN
  IF _amt <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  IF _shift_id IS NULL THEN RAISE EXCEPTION 'صرف الرصيد نقداً يتطلب وردية مفتوحة'; END IF;
  IF COALESCE(_operation_id,'') = '' THEN RAISE EXCEPTION 'معرّف العملية مطلوب'; END IF;

  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'صرف رصيد عميل');

  IF _ccy = 'USD' THEN
    _eff_rate := 1;
    _eff_ccy_amt := _amt;
  ELSE
    _eff_rate := COALESCE(_rate, (SELECT NULLIF((ss.exchange_rates->>_ccy)::numeric, 0) FROM public.store_settings ss WHERE ss.user_id = _o LIMIT 1));
    IF _eff_rate IS NULL OR _eff_rate <= 0 THEN
      RAISE EXCEPTION 'سعر صرف العملة % غير صالح', _ccy;
    END IF;
    _eff_ccy_amt := round(COALESCE(NULLIF(_currency_amount, 0), _amt * _eff_rate), 4);
    IF _eff_ccy_amt <= 0 THEN
      RAISE EXCEPTION 'مبلغ العملة % غير صالح', _ccy;
    END IF;
    IF _currency_amount IS NOT NULL AND _currency_amount > 0 THEN
      IF abs(_eff_ccy_amt - (_amount * _eff_rate)) > GREATEST(0.05, (_amount * _eff_rate) * 0.01) THEN
        RAISE EXCEPTION 'مبلغ العملة (%) لا يطابق القيمة المحوّلة (% × %)', _eff_ccy_amt, _amount, _eff_rate;
      END IF;
    END IF;
  END IF;

  PERFORM 1 FROM public.customers WHERE id=_customer_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'العميل غير موجود'; END IF;
  SELECT id INTO _id FROM public.customer_credit_ledger WHERE user_id=_o AND operation_id=_operation_id AND entry_type='payout';
  IF _id IS NOT NULL THEN RETURN _id; END IF;

  SELECT round(COALESCE(SUM(amount),0), 4) INTO _bal FROM public.customer_credit_ledger WHERE customer_id=_customer_id;
  IF _amt > _bal THEN RAISE EXCEPTION 'رصيد العميل (%) أقل من المبلغ المطلوب', round(_bal,2); END IF;

  PERFORM 1 FROM public.cash_shifts WHERE id=_shift_id AND user_id=_o AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'لا توجد وردية مفتوحة'; END IF;

  INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,reference_id,notes,currency,currency_amount,exchange_rate)
  VALUES (_shift_id,_o,'store_credit_refund',_amt,_operation_id,'صرف رصيد عميل نقداً',_ccy,_eff_ccy_amt,_eff_rate);

  UPDATE public.cash_shifts
     SET expected_balance = round(COALESCE(expected_balance, 0) - _amt, 2),
         updated_at = now()
   WHERE id = _shift_id AND user_id = _o AND closed_at IS NULL;

  INSERT INTO public.customer_credit_ledger(user_id,customer_id,entry_type,amount,shift_id,reason,operation_id,created_by)
  VALUES (_o,_customer_id,'payout',-_amt,_shift_id,'صرف رصيد نقداً',_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END
$function$;

REVOKE ALL ON FUNCTION public.payout_store_credit_atomic(uuid, numeric, uuid, text, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.payout_store_credit_atomic(uuid, numeric, uuid, text, text, numeric, numeric) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pay_supplier_atomic(
  _supplier_id uuid,
  _amount numeric,
  _method text,
  _note text,
  _operation_id text,
  _source text DEFAULT 'external'::text,
  _shift_id uuid DEFAULT NULL::uuid,
  _currency text DEFAULT 'USD'::text,
  _currency_amount numeric DEFAULT NULL::numeric,
  _rate numeric DEFAULT NULL::numeric
)
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
    IF _currency_amount IS NOT NULL AND _currency_amount > 0 THEN
      IF abs(_eff_ccy_amt - (_amount * _eff_rate)) > GREATEST(0.05, (_amount * _eff_rate) * 0.01) THEN
        RAISE EXCEPTION 'مبلغ العملة (%) لا يطابق القيمة المحوّلة (% × %)', _eff_ccy_amt, _amount, _eff_rate;
      END IF;
    END IF;
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
END
$function$;

REVOKE ALL ON FUNCTION public.pay_supplier_atomic(uuid, numeric, text, text, text, text, uuid, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_supplier_atomic(uuid, numeric, text, text, text, text, uuid, text, numeric, numeric) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.supplier_refund_atomic(
  _supplier_id uuid,
  _amount numeric,
  _method text,
  _note text,
  _operation_id text,
  _source text DEFAULT 'external'::text,
  _shift_id uuid DEFAULT NULL::uuid,
  _currency text DEFAULT 'USD'::text,
  _currency_amount numeric DEFAULT NULL::numeric,
  _rate numeric DEFAULT NULL::numeric
)
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
    IF _currency_amount IS NOT NULL AND _currency_amount > 0 THEN
      IF abs(_eff_ccy_amt - (_amount * _eff_rate)) > GREATEST(0.05, (_amount * _eff_rate) * 0.01) THEN
        RAISE EXCEPTION 'مبلغ العملة (%) لا يطابق القيمة المحوّلة (% × %)', _eff_ccy_amt, _amount, _eff_rate;
      END IF;
    END IF;
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
END
$function$;

REVOKE ALL ON FUNCTION public.supplier_refund_atomic(uuid, numeric, text, text, text, text, uuid, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supplier_refund_atomic(uuid, numeric, text, text, text, text, uuid, text, numeric, numeric) TO authenticated, service_role;
