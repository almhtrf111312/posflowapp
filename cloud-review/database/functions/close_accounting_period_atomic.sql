-- close_accounting_period_atomic(_period_start date, _period_end date, _timezone text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.close_accounting_period_atomic(_period_start date, _period_end date, _timezone text DEFAULT 'UTC'::text)
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

  -- المرحلة 1: إقفال الفترة لمالك المتجر فقط، بتواريخ صحيحة، ودون تداخل مع إقفال سابق
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

  IF _period_end > (now() AT TIME ZONE _tz)::date THEN
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

  -- 1) المبيعات والربح المحقق والمعلّق بالتعريف الموحّد
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
  ),
  credit_paid AS (
    SELECT c.*,
           GREATEST(c.paid_by_invoice, LEAST(c.total, COALESCE(ds.dated_sum, 0))) AS paid_total,
           COALESCE(ds.dated_sum, 0) AS dated_sum,
           (c.status = 'written_off' OR EXISTS (
              SELECT 1 FROM public.debt_writeoffs w
               LEFT JOIN public.debts wd ON wd.id = w.debt_id
              WHERE w.user_id = _owner
                AND COALESCE(wd.invoice_id, w.notes) IN (c.invoice_number, c.id::text)
                AND NOT COALESCE(wd.is_cash_debt, false)
           )) AS is_written_off
      FROM credit c
      LEFT JOIN (SELECT invoice_id, SUM(amount) AS dated_sum FROM pay GROUP BY invoice_id) ds
        ON ds.invoice_id = c.id
  ),
  alloc AS (
    -- الدفعات المؤرخة تُحتسب بالترتيب ولا تتجاوز ما حُصّل فعلاً
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

  -- 2) تكلفة البضاعة المباعة (للعرض: مجمل الربح = المبيعات − التكلفة)
  SELECT
    COALESCE(SUM(COALESCE(ii.cost_price, 0) * COALESCE(ii.quantity, 0)), 0)
    INTO _cogs
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE i.user_id = _owner
     AND i.status NOT IN ('refunded', 'cancelled')
     AND COALESCE(i.invoice_type, 'sale') IN ('sale', 'maintenance')
     AND (i.created_at AT TIME ZONE _tz)::date BETWEEN _period_start AND _period_end;

  -- 3) المصاريف التشغيلية للفترة (بدون الديون المعدومة: لها سطر مستقل)
  SELECT COALESCE(SUM(amount), 0) INTO _exp
    FROM public.expenses
   WHERE user_id = _owner
     AND COALESCE(is_reversed, false) = false
     AND date BETWEEN _period_start AND _period_end;

  -- 4) خسارة الديون المعدومة في الفترة = المبلغ المعدوم − ربحه المعلّق
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

  -- 5) تجميع أرصدة الشركاء لحظة الإقفال
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

  -- 6) تسجيل قيد الإقفال في السجل التاريخي المحمي
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
$function$
;
