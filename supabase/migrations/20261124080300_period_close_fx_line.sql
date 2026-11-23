-- AUDIT FINDING F4 (2026-11-24): the period closing ignored the debt FX difference.
--  * accounting_period_closures gets fx_difference (FX of debt collections in the period) and net_after_fx (net + FX).
--  * net_profit keeps its meaning (operating net, no FX), so earlier closings are unchanged.
-- Written by the implementing agent; NOT applied. The owner pastes it into the SQL editor.

ALTER TABLE public.accounting_period_closures ADD COLUMN IF NOT EXISTS fx_difference numeric NOT NULL DEFAULT 0;
ALTER TABLE public.accounting_period_closures ADD COLUMN IF NOT EXISTS net_after_fx numeric NOT NULL DEFAULT 0;

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
  _inventory_valuation numeric := 0;
  _fx numeric := 0;
  _net_after_fx numeric := 0;
  _range_start timestamptz;
  _range_end timestamptz;
  _installed_at timestamptz;
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

  _range_start := _period_start::timestamp AT TIME ZONE _tz;
  _range_end := (_period_end + 1)::timestamp AT TIME ZONE _tz;
  SELECT installed_at INTO _installed_at FROM public.invoice_accounting_cutover;
  IF _range_start < _installed_at AND EXISTS (
    SELECT 1 FROM public.invoice_accounting_events
     WHERE user_id = _owner AND is_opening
  ) THEN
    RAISE EXCEPTION 'تحتاج الفترة إلى تسوية موثقة لأنها تبدأ قبل تفعيل سجل حركات الفواتير';
  END IF;

  SELECT COALESCE(SUM(revenue_delta), 0), COALESCE(SUM(cogs_delta), 0), COALESCE(SUM(realized_delta), 0)
    INTO _rev, _cogs, _realized
    FROM public.invoice_accounting_events
   WHERE user_id = _owner AND NOT is_opening
     AND posted_at >= _range_start AND posted_at < _range_end;

  SELECT COALESCE(SUM(e.pending_profit), 0) INTO _pending
    FROM (
      SELECT DISTINCT ON (invoice_id) pending_profit
        FROM public.invoice_accounting_events
       WHERE user_id = _owner AND posted_at < _range_end
       ORDER BY invoice_id, posted_at DESC, id DESC
    ) e;

  IF EXISTS (
    SELECT 1 FROM public.expenses
     WHERE user_id = _owner AND is_reversed AND reversed_at IS NULL
       AND date BETWEEN _period_start AND _period_end
  ) THEN
    RAISE EXCEPTION 'تحتاج مصاريف الفترة المعكوسة بدون تاريخ انعكاس إلى تسوية موثقة';
  END IF;
  SELECT COALESCE(SUM(
    CASE WHEN date BETWEEN _period_start AND _period_end THEN amount ELSE 0 END
    - CASE WHEN is_reversed AND reversed_at >= _range_start AND reversed_at < _range_end
           THEN amount ELSE 0 END
  ), 0) INTO _exp
    FROM public.expenses
   WHERE user_id = _owner
     AND (date BETWEEN _period_start AND _period_end
          OR (is_reversed AND reversed_at >= _range_start AND reversed_at < _range_end));

  IF EXISTS (
    SELECT 1 FROM public.debt_writeoffs
     WHERE user_id = _owner AND loss_amount IS NULL
       AND written_off_at >= _range_start AND written_off_at < _range_end
  ) THEN
    RAISE EXCEPTION 'تحتاج قيود الشطب بدون قيمة خسارة موثقة إلى تسوية قبل الإقفال';
  END IF;
  SELECT COALESCE(SUM(loss_amount), 0) INTO _bad_debt
    FROM public.debt_writeoffs
   WHERE user_id = _owner AND written_off_at >= _range_start AND written_off_at < _range_end;

  _inventory_valuation := public._inventory_valuation_for_period(_owner, _period_start, _period_end, _tz);

  _rev := round(_rev, 8);
  _cogs := round(_cogs, 8);
  _exp := round(_exp, 8);
  _gross := round(_rev - _cogs, 8);
  _realized := round(_realized, 8);
  _pending := round(_pending, 8);
  _bad_debt := round(_bad_debt, 8);
  _net := round(_realized - _exp - _bad_debt + _inventory_valuation, 8);

  -- F4 (audit 2026-11-24): the FX difference of debt collections in the period is its own line below the net result
  -- (never sales profit, never shared with partners).
  SELECT COALESCE(SUM(dp.fx_difference_usd), 0) INTO _fx
    FROM public.debt_payments dp
   WHERE dp.user_id = _owner
     AND dp.created_at >= _range_start AND dp.created_at < _range_end;
  _fx := round(_fx, 8);
  _net_after_fx := round(_net + _fx, 8);

  FOR p IN
    SELECT balances.partner_id AS id, COALESCE(pr.name, '') AS name,
           round(balances.current_balance, 8) AS current_balance,
           round(balances.confirmed_profit, 8) AS confirmed_profit,
           round(balances.total_profit_earned, 8) AS total_profit_earned
      FROM (
        SELECT le.partner_id,
               SUM(le.d_current_balance) AS current_balance,
               SUM(le.d_confirmed_profit) AS confirmed_profit,
               SUM(le.d_total_profit_earned) AS total_profit_earned
          FROM public.partner_ledger_entries le
         WHERE le.user_id = _owner AND le.created_at < _range_end
         GROUP BY le.partner_id
        HAVING BOOL_OR(le.entry_type = 'opening')
      ) balances
      LEFT JOIN public.partners pr ON pr.id = balances.partner_id AND pr.user_id = _owner
     ORDER BY balances.partner_id
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
    realized_profit, pending_profit, bad_debt_loss, closing_timezone, inventory_valuation_adjustment, fx_difference, net_after_fx
  ) VALUES (
    _owner, _period_start, _period_end, _rev, _cogs,
    _gross, _exp, _net, _partner_summary, _caller,
    _realized, _pending, _bad_debt, _tz, _inventory_valuation, _fx, _net_after_fx
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
    'inventory_valuation_adjustment', _inventory_valuation,
    'net_profit', _net,
    'fx_difference', _fx,
    'net_after_fx', _net_after_fx,
    'partners', _partner_summary
  );
END;
$function$;
