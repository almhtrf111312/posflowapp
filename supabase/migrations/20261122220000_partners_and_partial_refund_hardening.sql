-- ============================================================================
-- Migration: 20261122220000_partners_and_partial_refund_hardening
-- ============================================================================

-- 1. Partner share <= 100% validation trigger
CREATE OR REPLACE FUNCTION public.validate_partner_shares()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _total_pct numeric := 0;
  _other_pct numeric := 0;
  _cat record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.access_all IS NOT DISTINCT FROM OLD.access_all
     AND NEW.share_percentage IS NOT DISTINCT FROM OLD.share_percentage
     AND NEW.category_shares IS NOT DISTINCT FROM OLD.category_shares THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('partner_shares:' || NEW.user_id::text));

  IF COALESCE(NEW.access_all, false) = true THEN
    IF COALESCE(NEW.share_percentage, 0) < 0 THEN
      RAISE EXCEPTION 'نسبة الشريك لا يمكن أن تكون سالبة'
        USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(SUM(COALESCE(share_percentage, 0)), 0)
      INTO _total_pct
    FROM public.partners
    WHERE user_id = NEW.user_id
      AND COALESCE(access_all, false) = true
      AND (TG_OP = 'INSERT' OR id <> OLD.id);

    IF round(_total_pct + COALESCE(NEW.share_percentage, 0), 4) > 100 THEN
      RAISE EXCEPTION 'إجمالي نسب الشركاء العامين يتجاوز 100%% (الإجمالي: %%%)',
        round(_total_pct + COALESCE(NEW.share_percentage, 0), 2)
        USING ERRCODE = '22023';
    END IF;
  ELSIF NEW.category_shares IS NOT NULL AND jsonb_typeof(NEW.category_shares) = 'array' THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.category_shares) cs
      WHERE COALESCE((cs->>'enabled')::boolean, false) = true
        AND COALESCE((cs->>'percentage')::numeric, 0) < 0
    ) THEN
      RAISE EXCEPTION 'نسبة الشريك في الفئة لا يمكن أن تكون سالبة'
        USING ERRCODE = '22023';
    END IF;

    FOR _cat IN
      SELECT
        trim(cs->>'categoryName') AS category_name,
        SUM(COALESCE((cs->>'percentage')::numeric, 0)) AS new_pct
      FROM jsonb_array_elements(NEW.category_shares) cs
      WHERE COALESCE((cs->>'enabled')::boolean, false) = true
        AND NULLIF(trim(COALESCE(cs->>'categoryName', '')), '') IS NOT NULL
        AND COALESCE((cs->>'percentage')::numeric, 0) > 0
      GROUP BY trim(cs->>'categoryName')
    LOOP
      SELECT COALESCE(SUM(COALESCE((cs->>'percentage')::numeric, 0)), 0)
        INTO _other_pct
      FROM public.partners p,
           jsonb_array_elements(
             CASE
               WHEN p.category_shares IS NOT NULL AND jsonb_typeof(p.category_shares) = 'array'
               THEN p.category_shares
               ELSE '[]'::jsonb
             END
           ) cs
      WHERE p.user_id = NEW.user_id
        AND COALESCE(p.access_all, false) = false
        AND (TG_OP = 'INSERT' OR p.id <> OLD.id)
        AND COALESCE((cs->>'enabled')::boolean, false) = true
        AND trim(COALESCE(cs->>'categoryName', '')) = _cat.category_name
        AND COALESCE((cs->>'percentage')::numeric, 0) > 0;

      IF round(_other_pct + _cat.new_pct, 4) > 100 THEN
        RAISE EXCEPTION 'إجمالي نسب الشركاء للفئة "%" يتجاوز 100%% (الإجمالي: %%%)',
          _cat.category_name,
          round(_other_pct + _cat.new_pct, 2)
          USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_partners_validate_shares ON public.partners;
CREATE TRIGGER trg_partners_validate_shares
  BEFORE INSERT OR UPDATE ON public.partners
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_partner_shares();

-- 2. Direct financial write guard trigger on public.partners
CREATE OR REPLACE FUNCTION public.guard_partners_financial_direct_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NULLIF(current_setting('app.partner_source', true), '') IS NULL
     AND current_user IN ('authenticated', 'anon') THEN
    IF NEW.current_balance IS DISTINCT FROM OLD.current_balance
       OR NEW.pending_profit IS DISTINCT FROM OLD.pending_profit
       OR NEW.confirmed_profit IS DISTINCT FROM OLD.confirmed_profit
       OR NEW.total_profit_earned IS DISTINCT FROM OLD.total_profit_earned
       OR NEW.total_withdrawn IS DISTINCT FROM OLD.total_withdrawn
       OR NEW.initial_capital IS DISTINCT FROM OLD.initial_capital
       OR NEW.current_capital IS DISTINCT FROM OLD.current_capital
       OR NEW.profit_history IS DISTINCT FROM OLD.profit_history
       OR NEW.expense_history IS DISTINCT FROM OLD.expense_history
       OR NEW.withdrawal_history IS DISTINCT FROM OLD.withdrawal_history
       OR NEW.capital_history IS DISTINCT FROM OLD.capital_history
       OR NEW.pending_profit_details IS DISTINCT FROM OLD.pending_profit_details THEN
      RAISE EXCEPTION 'لا يُسمح بتعديل الحقول المالية للشركاء مباشرة؛ استخدم الدوال المخصصة لذلك'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_partners_financial_direct_write ON public.partners;
CREATE TRIGGER guard_partners_financial_direct_write
  BEFORE UPDATE ON public.partners
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_partners_financial_direct_write();

-- 3. Hardened distribute_invoice_partner_profits_atomic
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
  _eff_pct numeric;
  _cat_pct_used numeric;
  _all_pct_used numeric;
  _profit_record jsonb;
  _pending_detail jsonb;
  _total_distributed numeric := 0;
  _distributions jsonb := '[]'::jsonb;
BEGIN
  PERFORM set_config('app.partner_source', 'distribute_invoice_partner_profits_atomic', true);
  PERFORM pg_advisory_xact_lock(hashtext('partner_dist:' || _invoice_id::text));

  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  _owner := _inv.user_id;

  IF auth.uid() IS NOT NULL AND public.get_owner_id(auth.uid()) IS DISTINCT FROM _owner THEN
    RAISE EXCEPTION 'غير مصرح' USING ERRCODE = '42501';
  END IF;
  _is_debt := (_inv.payment_type = 'debt' AND COALESCE(_inv.debt_remaining, 0) > 0);

  IF EXISTS (
    SELECT 1 FROM public.partners p,
    jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb)) ph
    WHERE p.user_id = _owner AND ph->>'invoiceId' = _inv.invoice_number
  ) THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'invoice_number', _inv.invoice_number);
  END IF;

  IF COALESCE(_inv.created_at, now()) < now() - interval '1 hour' THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'invoice_number', _inv.invoice_number, 'skipped', 'stale_invoice');
  END IF;

  FOR _cat_profit IN
    SELECT
      COALESCE(NULLIF(trim(p.category), ''), 'عام') AS category_name,
      round(SUM(COALESCE(ii.profit, 0)), 8) AS total_category_profit
    FROM public.invoice_items ii
    LEFT JOIN public.products p ON p.id = ii.product_id AND p.user_id = _owner
    WHERE ii.invoice_id = _invoice_id
    GROUP BY COALESCE(NULLIF(trim(p.category), ''), 'عام')
    HAVING SUM(COALESCE(ii.profit, 0)) <> 0
  LOOP
    _remaining_profit := _cat_profit.total_category_profit;
    _cat_pct_used := 0;

    FOR _partner IN
      SELECT * FROM public.partners
      WHERE user_id = _owner
        AND COALESCE(access_all, false) = false
        AND category_shares IS NOT NULL
      ORDER BY id
      FOR UPDATE
    LOOP
      SELECT cs INTO _cat_share
      FROM jsonb_array_elements(_partner.category_shares) cs
      WHERE (cs->>'enabled')::boolean = true
        AND trim(COALESCE(cs->>'categoryName', '')) = _cat_profit.category_name
      LIMIT 1;

      IF _cat_share IS NOT NULL AND COALESCE((_cat_share->>'percentage')::numeric, 0) > 0 THEN
        _pct := (_cat_share->>'percentage')::numeric;
        _eff_pct := LEAST(_pct, GREATEST(100.0 - _cat_pct_used, 0.0));
        IF _eff_pct <= 0 THEN
          CONTINUE;
        END IF;
        _cat_pct_used := _cat_pct_used + _eff_pct;
        _partner_share := round((_cat_profit.total_category_profit * _eff_pct / 100.0), 4);

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

    IF (_cat_profit.total_category_profit > 0 AND _remaining_profit > 0)
       OR (_cat_profit.total_category_profit < 0 AND _remaining_profit < 0) THEN
      _all_pct_used := 0;
      FOR _partner IN
        SELECT * FROM public.partners
        WHERE user_id = _owner
          AND COALESCE(access_all, false) = true
          AND COALESCE(share_percentage, 0) > 0
        ORDER BY id
        FOR UPDATE
      LOOP
        _eff_pct := LEAST(_partner.share_percentage, GREATEST(100.0 - _all_pct_used, 0.0));
        IF _eff_pct <= 0 THEN
          CONTINUE;
        END IF;
        _all_pct_used := _all_pct_used + _eff_pct;
        _partner_share := round((_remaining_profit * _eff_pct / 100.0), 4);

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

-- 4. Extended revert_invoice_partner_profits_atomic
DROP FUNCTION IF EXISTS public.revert_invoice_partner_profits_atomic(uuid, numeric);

CREATE OR REPLACE FUNCTION public.revert_invoice_partner_profits_atomic(
  _invoice_id uuid,
  _revert_ratio numeric DEFAULT 1.0,
  _category_profits jsonb DEFAULT NULL
)
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
  _use_cat_map boolean;
  _updated_details jsonb;
  _revert_record jsonb;
  _rev_entries jsonb;
  _pending_reverted numeric;
  _confirmed_reverted numeric;
  _orig_share numeric;
  _pending_now numeric;
  _already_reverted numeric;
  _confirmed_net numeric;
  _avail_total numeric;
  _target_rev numeric;
  _pending_scale numeric;
  _item jsonb;
  _amt numeric;
  _total_reverted numeric := 0;
  _rem_by_cat jsonb;
  _cat_entry record;
  _cat_share jsonb;
  _pct numeric;
  _cat_amt numeric;
  _orig_cat_profit numeric;
  _cat_rev_list jsonb;
  _rev_item jsonb;
  _scale numeric;
  _idx int;
BEGIN
  PERFORM set_config('app.partner_source', 'revert_invoice_partner_profits_atomic', true);
  PERFORM pg_advisory_xact_lock(hashtext('partner_dist:' || _invoice_id::text));

  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  _owner := _inv.user_id;
  _full := _ratio >= 0.9999;
  _use_cat_map := (_category_profits IS NOT NULL AND jsonb_typeof(_category_profits) = 'object' AND _category_profits <> '{}'::jsonb);

  IF _use_cat_map THEN
    _rem_by_cat := _category_profits;

    FOR _partner IN
      SELECT * FROM public.partners
      WHERE user_id = _owner
        AND COALESCE(access_all, false) = false
        AND (
          profit_history @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
          OR pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
        )
      ORDER BY id
      FOR UPDATE
    LOOP
      _target_rev := 0;
      _cat_rev_list := '[]'::jsonb;

      IF _partner.category_shares IS NOT NULL AND jsonb_typeof(_partner.category_shares) = 'array' THEN
        FOR _cat_entry IN
          SELECT key AS cat_name, COALESCE(NULLIF(value, '')::numeric, 0) AS cat_profit
          FROM jsonb_each_text(_category_profits)
        LOOP
          IF _cat_entry.cat_profit = 0 THEN
            CONTINUE;
          END IF;

          SELECT cs INTO _cat_share
          FROM jsonb_array_elements(_partner.category_shares) cs
          WHERE COALESCE((cs->>'enabled')::boolean, false) = true
            AND trim(COALESCE(cs->>'categoryName', '')) = trim(_cat_entry.cat_name)
          LIMIT 1;

          IF _cat_share IS NOT NULL AND COALESCE((_cat_share->>'percentage')::numeric, 0) > 0 THEN
            _pct := (_cat_share->>'percentage')::numeric;
            _cat_amt := round((_cat_entry.cat_profit * _pct / 100.0), 4);
            IF _cat_amt <> 0 THEN
              _target_rev := _target_rev + _cat_amt;
              _rem_by_cat := jsonb_set(
                _rem_by_cat,
                ARRAY[_cat_entry.cat_name],
                to_jsonb(round(COALESCE((_rem_by_cat->>_cat_entry.cat_name)::numeric, 0) - _cat_amt, 8)),
                true
              );
              _cat_rev_list := _cat_rev_list || jsonb_build_object('category', _cat_entry.cat_name, 'amount', _cat_amt);
            END IF;
          END IF;
        END LOOP;
      END IF;

      IF _target_rev = 0 THEN
        CONTINUE;
      END IF;

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
      _confirmed_net := CASE WHEN _orig_share >= 0 THEN GREATEST(_confirmed_net, 0) ELSE LEAST(_confirmed_net, 0) END;
      _avail_total := round(_pending_now + _confirmed_net, 8);

      IF _orig_share >= 0 AND _target_rev > 0 THEN
        _target_rev := LEAST(_target_rev, GREATEST(_avail_total, 0));
      ELSIF _orig_share < 0 AND _target_rev < 0 THEN
        _target_rev := GREATEST(_target_rev, LEAST(_avail_total, 0));
      END IF;

      IF _target_rev = 0 THEN
        CONTINUE;
      END IF;

      _pending_reverted := 0;
      IF _pending_now <> 0 AND ((_target_rev > 0 AND _pending_now > 0) OR (_target_rev < 0 AND _pending_now < 0)) THEN
        IF abs(_target_rev) >= abs(_pending_now) THEN
          _pending_reverted := _pending_now;
        ELSE
          _pending_reverted := round(_target_rev, 8);
        END IF;
      END IF;

      _confirmed_reverted := round(_target_rev - _pending_reverted, 8);
      IF _orig_share >= 0 AND _confirmed_reverted > 0 THEN
        _confirmed_reverted := LEAST(_confirmed_reverted, GREATEST(_confirmed_net, 0));
      ELSIF _orig_share < 0 AND _confirmed_reverted < 0 THEN
        _confirmed_reverted := GREATEST(_confirmed_reverted, LEAST(_confirmed_net, 0));
      END IF;

      _updated_details := '[]'::jsonb;
      _pending_scale := CASE WHEN _pending_now <> 0 THEN 1.0 - (_pending_reverted / _pending_now) ELSE 1.0 END;
      FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb)) LOOP
        IF _item->>'invoiceId' = _inv.invoice_number THEN
          _amt := COALESCE((_item->>'amount')::numeric, 0);
          IF abs(round(_amt * _pending_scale, 8)) > 0.00005 THEN
            _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_amt * _pending_scale, 8)));
          END IF;
        ELSE
          _updated_details := _updated_details || _item;
        END IF;
      END LOOP;

      IF _pending_reverted <> 0 OR _confirmed_reverted <> 0 THEN
        _rev_entries := '[]'::jsonb;
        _scale := CASE WHEN _target_rev <> 0 THEN (_pending_reverted + _confirmed_reverted) / _target_rev ELSE 1.0 END;
        _idx := 0;
        FOR _rev_item IN SELECT * FROM jsonb_array_elements(_cat_rev_list) LOOP
          _idx := _idx + 1;
          _cat_amt := round((_rev_item->>'amount')::numeric * _scale, 8);
          IF _cat_amt <> 0 THEN
            _rev_entries := _rev_entries || jsonb_build_array(jsonb_build_object(
              'id', extract(epoch from now())::text || _partner.id::text || '-rev-' || _idx::text,
              'invoiceId', _inv.invoice_number,
              'amount', -_cat_amt,
              'pendingReverted', round(_pending_reverted * (_cat_amt / NULLIF(_pending_reverted + _confirmed_reverted, 0)), 8),
              'confirmedReverted', round(_confirmed_reverted * (_cat_amt / NULLIF(_pending_reverted + _confirmed_reverted, 0)), 8),
              'category', _rev_item->>'category',
              'isReversal', true,
              'createdAt', now()
            ));
          END IF;
        END LOOP;

        UPDATE public.partners SET
          pending_profit = round((SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(_updated_details) x), 4),
          confirmed_profit = round(COALESCE(confirmed_profit, 0) - _confirmed_reverted, 4),
          current_balance = round(COALESCE(current_balance, 0) - _confirmed_reverted, 4),
          total_profit_earned = round(COALESCE(total_profit_earned, 0) - _confirmed_reverted, 4),
          pending_profit_details = _updated_details,
          profit_history = COALESCE(profit_history, '[]'::jsonb) || _rev_entries,
          updated_at = now()
        WHERE id = _partner.id;

        _total_reverted := _total_reverted + _pending_reverted + _confirmed_reverted;
      END IF;
    END LOOP;

    FOR _partner IN
      SELECT * FROM public.partners
      WHERE user_id = _owner
        AND COALESCE(access_all, false) = true
        AND COALESCE(share_percentage, 0) > 0
        AND (
          profit_history @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
          OR pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
        )
      ORDER BY id
      FOR UPDATE
    LOOP
      _target_rev := 0;
      _cat_rev_list := '[]'::jsonb;

      FOR _cat_entry IN
        SELECT key AS cat_name, COALESCE(NULLIF(value, '')::numeric, 0) AS rem_profit
        FROM jsonb_each_text(_rem_by_cat)
      LOOP
        _orig_cat_profit := COALESCE((_category_profits->>_cat_entry.cat_name)::numeric, 0);
        IF (_orig_cat_profit > 0 AND _cat_entry.rem_profit > 0)
           OR (_orig_cat_profit < 0 AND _cat_entry.rem_profit < 0) THEN
          _cat_amt := round((_cat_entry.rem_profit * _partner.share_percentage / 100.0), 4);
          IF _cat_amt <> 0 THEN
            _target_rev := _target_rev + _cat_amt;
            _cat_rev_list := _cat_rev_list || jsonb_build_object('category', _cat_entry.cat_name, 'amount', _cat_amt);
          END IF;
        END IF;
      END LOOP;

      IF _target_rev = 0 THEN
        CONTINUE;
      END IF;

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
      _confirmed_net := CASE WHEN _orig_share >= 0 THEN GREATEST(_confirmed_net, 0) ELSE LEAST(_confirmed_net, 0) END;
      _avail_total := round(_pending_now + _confirmed_net, 8);

      IF _orig_share >= 0 AND _target_rev > 0 THEN
        _target_rev := LEAST(_target_rev, GREATEST(_avail_total, 0));
      ELSIF _orig_share < 0 AND _target_rev < 0 THEN
        _target_rev := GREATEST(_target_rev, LEAST(_avail_total, 0));
      END IF;

      IF _target_rev = 0 THEN
        CONTINUE;
      END IF;

      _pending_reverted := 0;
      IF _pending_now <> 0 AND ((_target_rev > 0 AND _pending_now > 0) OR (_target_rev < 0 AND _pending_now < 0)) THEN
        IF abs(_target_rev) >= abs(_pending_now) THEN
          _pending_reverted := _pending_now;
        ELSE
          _pending_reverted := round(_target_rev, 8);
        END IF;
      END IF;

      _confirmed_reverted := round(_target_rev - _pending_reverted, 8);
      IF _orig_share >= 0 AND _confirmed_reverted > 0 THEN
        _confirmed_reverted := LEAST(_confirmed_reverted, GREATEST(_confirmed_net, 0));
      ELSIF _orig_share < 0 AND _confirmed_reverted < 0 THEN
        _confirmed_reverted := GREATEST(_confirmed_reverted, LEAST(_confirmed_net, 0));
      END IF;

      _updated_details := '[]'::jsonb;
      _pending_scale := CASE WHEN _pending_now <> 0 THEN 1.0 - (_pending_reverted / _pending_now) ELSE 1.0 END;
      FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb)) LOOP
        IF _item->>'invoiceId' = _inv.invoice_number THEN
          _amt := COALESCE((_item->>'amount')::numeric, 0);
          IF abs(round(_amt * _pending_scale, 8)) > 0.00005 THEN
            _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_amt * _pending_scale, 8)));
          END IF;
        ELSE
          _updated_details := _updated_details || _item;
        END IF;
      END LOOP;

      IF _pending_reverted <> 0 OR _confirmed_reverted <> 0 THEN
        _rev_entries := '[]'::jsonb;
        _scale := CASE WHEN _target_rev <> 0 THEN (_pending_reverted + _confirmed_reverted) / _target_rev ELSE 1.0 END;
        _idx := 0;
        FOR _rev_item IN SELECT * FROM jsonb_array_elements(_cat_rev_list) LOOP
          _idx := _idx + 1;
          _cat_amt := round((_rev_item->>'amount')::numeric * _scale, 8);
          IF _cat_amt <> 0 THEN
            _rev_entries := _rev_entries || jsonb_build_array(jsonb_build_object(
              'id', extract(epoch from now())::text || _partner.id::text || '-rev-' || _idx::text,
              'invoiceId', _inv.invoice_number,
              'amount', -_cat_amt,
              'pendingReverted', round(_pending_reverted * (_cat_amt / NULLIF(_pending_reverted + _confirmed_reverted, 0)), 8),
              'confirmedReverted', round(_confirmed_reverted * (_cat_amt / NULLIF(_pending_reverted + _confirmed_reverted, 0)), 8),
              'category', _rev_item->>'category',
              'isReversal', true,
              'createdAt', now()
            ));
          END IF;
        END LOOP;

        UPDATE public.partners SET
          pending_profit = round((SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(_updated_details) x), 4),
          confirmed_profit = round(COALESCE(confirmed_profit, 0) - _confirmed_reverted, 4),
          current_balance = round(COALESCE(current_balance, 0) - _confirmed_reverted, 4),
          total_profit_earned = round(COALESCE(total_profit_earned, 0) - _confirmed_reverted, 4),
          pending_profit_details = _updated_details,
          profit_history = COALESCE(profit_history, '[]'::jsonb) || _rev_entries,
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
  END IF;

  FOR _partner IN
    SELECT * FROM public.partners
    WHERE user_id = _owner
      AND (
        profit_history @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
        OR pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
      )
    ORDER BY id
    FOR UPDATE
  LOOP
    _pending_reverted := 0;
    _updated_details := '[]'::jsonb;

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
        profit_history = COALESCE(profit_history, '[]'::jsonb) || public._split_reversal_by_category(_revert_record, profit_history, _inv.invoice_number),
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

-- 5. Extended refund_invoice_partial_atomic
DROP FUNCTION IF EXISTS public.refund_invoice_partial_atomic(text, jsonb, text);

CREATE OR REPLACE FUNCTION public.refund_invoice_partial_atomic(
  _invoice_number text,
  _items jsonb,
  _operation_id text,
  _shift_id uuid DEFAULT NULL,
  _currency text DEFAULT NULL,
  _currency_amount numeric DEFAULT NULL,
  _exchange_rate numeric DEFAULT NULL
)
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
  _remaining_units numeric; _full boolean; _debt_red numeric := 0; _cash numeric := 0; _paid_red numeric := 0; _new_debt numeric;
  _profit_ratio numeric := 0;
  _f numeric := 1;
  _disc_ratio numeric := 0;
  _profit_red numeric := 0;
  _unit_factor numeric := 1;
  _track_inventory boolean := true;
  _store_type text;
  _category_profits jsonb := '{}'::jsonb;
  _line_cat text;
  _line_profit_red numeric;
  _prev_meta jsonb;
  _prev_cash numeric := 0;
  _ccy text;
  _rate numeric;
  _ccy_amt numeric;
  _shift_ref text;
  _inserted int := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _owner := public.get_owner_id(auth.uid());

  IF NOT public.can_refund_invoices(auth.uid()) THEN
    RAISE EXCEPTION 'ليست لديك صلاحية الاسترداد. اطلبها من مالك المتجر' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO _inv FROM public.invoices WHERE invoice_number=_invoice_number AND user_id=_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','invoice_not_found'); END IF;
  IF COALESCE(_inv.status, '') IN ('cancelled', 'written_off') THEN
    RAISE EXCEPTION 'لا يمكن استرداد فاتورة ملغاة أو مشطوبة';
  END IF;
  IF _inv.status='refunded' THEN
    SELECT COALESCE((al.metadata->>'cash_to_refund')::numeric, 0)
      INTO _prev_cash
    FROM public.activity_log al
    WHERE al.user_id = _owner
      AND al.action_type = 'partial_refund'
      AND al.entity_id = _inv.id::text
    ORDER BY al.created_at DESC
    LIMIT 1;
    RETURN jsonb_build_object(
      'success', true,
      'already_refunded', true,
      'invoice_id', _inv.id,
      'invoice_number', _inv.invoice_number,
      'new_total', _inv.total,
      'cash_to_refund', COALESCE(_prev_cash, 0)
    );
  END IF;
  IF _operation_id IS NOT NULL THEN
    SELECT al.metadata INTO _prev_meta
    FROM public.activity_log al
    WHERE al.user_id = _owner
      AND al.action_type = 'partial_refund'
      AND al.metadata->>'operation_id' = _operation_id
    ORDER BY al.created_at DESC
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_processed', true,
        'invoice_id', _inv.id,
        'invoice_number', _inv.invoice_number,
        'new_total', _inv.total,
        'new_profit', _inv.profit,
        'new_debt_remaining', _inv.debt_remaining,
        'cash_to_refund', COALESCE((_prev_meta->>'cash_to_refund')::numeric, 0)
      );
    END IF;
  END IF;

  PERFORM public.assert_period_open(_owner, _inv.date, 'الاسترداد الجزئي');

  SELECT s.store_type INTO _store_type FROM public.stores s WHERE s.user_id = _owner ORDER BY s.created_at LIMIT 1;
  _track_inventory := NOT (COALESCE(_store_type, 'general') IN ('bakery', 'repair'));

  _factor := CASE WHEN COALESCE(_inv.subtotal,0) > 0 THEN COALESCE(_inv.total,0)/_inv.subtotal ELSE 1 END;
  IF COALESCE(_inv.tax_inclusive, false) AND COALESCE(_inv.tax_rate, 0) > 0 THEN
    _f := 1 / (1 + _inv.tax_rate / 100);
  END IF;
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
        amount_original=CASE
          WHEN COALESCE(_line.quantity, 0) > 0 AND COALESCE(_line.amount_original, 0) <> 0
            THEN round(_line.amount_original * (quantity - _take) / _line.quantity, 8)
          ELSE round(COALESCE(unit_price, 0) * (quantity - _take) * COALESCE(_inv.exchange_rate, 1), 8)
        END,
        amount_usd=round(COALESCE(unit_price,0)*(quantity-_take),8),
        profit=round(COALESCE(unit_price,0)*(quantity-_take)*(1-_disc_ratio)*_f - COALESCE(cost_price,0)*(quantity-_take),8)
      WHERE id=_line.id;
      _unit_factor := CASE WHEN COALESCE(_line.unit,'piece') = 'bulk' THEN GREATEST(COALESCE(_line.conversion_factor,1),1) ELSE 1 END;
      _gross := _gross + _take*COALESCE(_line.unit_price,0);
      _cogs := _cogs + _take*COALESCE(_line.cost_price,0);

      _line_cat := 'عام';
      IF _line.product_id IS NOT NULL THEN
        SELECT COALESCE(NULLIF(trim(p.category), ''), 'عام')
          INTO _line_cat
        FROM public.products p
        WHERE p.id = _line.product_id AND p.user_id = _owner;
        _line_cat := COALESCE(_line_cat, 'عام');
      END IF;
      _line_profit_red := round(_take * COALESCE(_line.unit_price, 0) * (1 - _disc_ratio) * _f - _take * COALESCE(_line.cost_price, 0), 8);
      IF _line_profit_red <> 0 THEN
        _category_profits := jsonb_set(
          _category_profits,
          ARRAY[_line_cat],
          to_jsonb(round(COALESCE((_category_profits->>_line_cat)::numeric, 0) + _line_profit_red, 8)),
          true
        );
      END IF;

      IF _track_inventory AND _line.product_id IS NOT NULL THEN
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

  DECLARE _ri record; _sid uuid; _released int;
  BEGIN
    FOR _ri IN
      SELECT (e->>'product_id')::uuid AS pid,
             floor(COALESCE((e->>'quantity')::numeric,0) * COALESCE((SELECT CASE WHEN ii.unit='bulk' THEN GREATEST(COALESCE(ii.conversion_factor,1),1) ELSE 1 END FROM public.invoice_items ii WHERE ii.invoice_id=_inv.id AND ii.product_id=(e->>'product_id')::uuid LIMIT 1),1))::int AS q,
             CASE WHEN jsonb_typeof(e->'serials') = 'array' THEN ARRAY(SELECT lower(trim(x)) FROM jsonb_array_elements_text(e->'serials') x WHERE trim(x) <> '') ELSE NULL END AS req_serials
      FROM jsonb_array_elements(_items) e
      WHERE NULLIF(e->>'product_id','') IS NOT NULL
    LOOP
      IF _ri.q > 0 AND EXISTS (SELECT 1 FROM public.products WHERE id=_ri.pid AND track_serials) THEN
        IF _ri.req_serials IS NOT NULL AND cardinality(_ri.req_serials) > 0 THEN
          IF cardinality(_ri.req_serials) <> _ri.q THEN
            RAISE EXCEPTION 'عدد الأرقام التسلسلية المحددة للاسترداد (%) لا يطابق الكمية (%)', cardinality(_ri.req_serials), _ri.q;
          END IF;
          _released := 0;
          FOR _sid IN
            SELECT id FROM public.product_serials
             WHERE user_id=_owner AND sold_invoice_id=_inv.id AND product_id=_ri.pid AND status='sold'
               AND lower(serial) = ANY(_ri.req_serials)
             FOR UPDATE
          LOOP
            UPDATE public.product_serials SET status='in_stock', sold_invoice_id=NULL, sold_invoice_number=NULL, sold_at=NULL, customer_name=NULL, warranty_until=NULL, updated_at=now() WHERE id=_sid;
            INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) VALUES (_owner,_sid,'customer_return',_inv.invoice_number,auth.uid());
            _released := _released + 1;
          END LOOP;
          IF _released <> cardinality(_ri.req_serials) THEN
            RAISE EXCEPTION 'بعض الأرقام التسلسلية المحددة غير مرتبطة بهذه الفاتورة أو سبق إرجاعها';
          END IF;
        ELSE
          FOR _sid IN SELECT id FROM public.product_serials WHERE user_id=_owner AND sold_invoice_id=_inv.id AND product_id=_ri.pid AND status='sold' ORDER BY sold_at DESC, id LIMIT _ri.q FOR UPDATE LOOP
            UPDATE public.product_serials SET status='in_stock', sold_invoice_id=NULL, sold_invoice_number=NULL, sold_at=NULL, customer_name=NULL, warranty_until=NULL, updated_at=now() WHERE id=_sid;
            INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) VALUES (_owner,_sid,'customer_return',_inv.invoice_number,auth.uid());
          END LOOP;
        END IF;
      END IF;
    END LOOP;
  END;

  _refund := round(_gross*_factor,8);
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

  IF _full THEN
    _profit_ratio := 1.0;
  ELSIF COALESCE(_inv.profit, 0) <> 0 THEN
    _profit_ratio := LEAST(GREATEST(_profit_red / _inv.profit, 0.0), 1.0);
  ELSE
    _profit_ratio := LEAST(GREATEST(_refund / GREATEST(COALESCE(_inv.total, 0.0001), 0.0001), 0.0), 1.0);
  END IF;

  IF _inv.payment_type='debt' THEN
    _debt_red := LEAST(_refund, GREATEST(COALESCE(_inv.debt_remaining,0),0));
    _paid_red := round(_refund-_debt_red,8);
  ELSE
    _debt_red := 0;
    _paid_red := 0;
  END IF;

  IF COALESCE(_inv.payment_method, 'cash') = 'digital' THEN
    _cash := 0;
  ELSIF _inv.payment_type='debt' THEN
    _cash := _paid_red;
  ELSE
    _cash := _refund;
  END IF;

  _new_debt := CASE WHEN _inv.payment_type='debt' THEN GREATEST(round(COALESCE(_inv.debt_remaining,0)-_debt_red,8),0) ELSE COALESCE(_inv.debt_remaining,0) END;

  IF _shift_id IS NOT NULL AND COALESCE(_inv.payment_method, 'cash') = 'cash' AND _cash > 0 THEN
    PERFORM 1 FROM public.cash_shifts
    WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
    END IF;

    _ccy := upper(COALESCE(NULLIF(trim(_currency), ''), NULLIF(trim(_inv.currency), ''), 'USD'));
    IF _ccy = 'USD' THEN
      _rate := 1.0;
      _ccy_amt := round(_cash, 2);
    ELSE
      _rate := COALESCE(_exchange_rate, NULLIF(_inv.exchange_rate, 0), 0);
      IF _rate <= 0 THEN
        RAISE EXCEPTION 'سعر الصرف غير صالح';
      END IF;
      _ccy_amt := round(COALESCE(_currency_amount, _cash * _rate), 2);
      IF _ccy_amt <= 0 THEN
        RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
      END IF;
      IF _currency_amount IS NOT NULL AND _currency_amount > 0 THEN
        IF abs(_ccy_amt - round(_cash * _rate, 2)) > GREATEST(0.05, _ccy_amt * 0.01) THEN
          RAISE EXCEPTION 'تعارض في تحويل العملة: المبلغ الأصلي (%) لا يطابق المبلغ بالدولار (%) × سعر الصرف (%)',
            _ccy_amt, round(_cash, 2), _rate;
        END IF;
      END IF;
    END IF;

    _shift_ref := COALESCE(NULLIF(trim(_operation_id), ''), _inv.invoice_number || ':' || gen_random_uuid()::text);
    INSERT INTO public.shift_transactions (
      shift_id, user_id, type, amount, currency_amount, currency, exchange_rate, notes, reference_id
    ) VALUES (
      _shift_id, _owner, 'refund', round(_cash, 4), _ccy_amt, _ccy, _rate,
      'استرداد جزئي للفاتورة ' || _inv.invoice_number,
      _shift_ref
    )
    ON CONFLICT (shift_id, type, reference_id) DO NOTHING;

    GET DIAGNOSTICS _inserted = ROW_COUNT;
    IF _inserted > 0 THEN
      UPDATE public.cash_shifts
      SET expected_balance = round(COALESCE(expected_balance, 0) - _cash, 4),
          updated_at = now()
      WHERE id = _shift_id;
    END IF;
  END IF;

  IF _full THEN PERFORM set_config('app.refund_context','allowed',true); END IF;
  UPDATE public.invoices SET subtotal=_new_sub, discount=_new_disc, tax_amount=_new_tax, total=_new_total, profit=_new_profit,
    debt_remaining=_new_debt, debt_paid=CASE WHEN payment_type='debt' THEN GREATEST(round(COALESCE(debt_paid,0)-_paid_red,8),0) ELSE debt_paid END,
    status=CASE WHEN _full THEN 'refunded' WHEN payment_type='debt' AND _new_debt<=0 THEN 'paid' ELSE status END,
    notes=concat_ws(E'\n',NULLIF(notes,''),'Partial refund '||_refund::text||' at '||now()::text),
    updated_at=now()
  WHERE id=_inv.id;

  IF _profit_ratio > 0 OR (_category_profits IS NOT NULL AND _category_profits <> '{}'::jsonb) THEN
    PERFORM public.revert_invoice_partner_profits_atomic(
      _inv.id,
      _profit_ratio,
      CASE WHEN _full THEN NULL ELSE NULLIF(_category_profits, '{}'::jsonb) END
    );
  END IF;
  IF _inv.payment_type='debt' AND NOT _full AND _new_debt<=0 THEN
    PERFORM public.release_pending_partner_profits_for_invoice(_inv.id);
  END IF;

  IF _inv.payment_type='debt' THEN
    IF _full THEN
      UPDATE public.debts SET status='cancelled', remaining_debt=0, notes=concat_ws(E'\n',NULLIF(notes,''),'ملغى بسبب مرتجع كامل '||now()::text), updated_at=now() WHERE user_id=_owner AND (invoice_id=_inv.invoice_number OR invoice_id=_inv.id::text);
    ELSIF _debt_red > 0 OR _paid_red > 0 THEN
      UPDATE public.debts SET total_debt=GREATEST(round(COALESCE(total_debt,0)-_refund,8),0), total_paid=GREATEST(round(COALESCE(total_paid,0)-_paid_red,8),0),
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
    PERFORM public.recalc_customer_open_debt(_owner, _inv.customer_id);
  END IF;

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

REVOKE ALL ON FUNCTION public.validate_partner_shares() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_partner_shares() TO service_role;

REVOKE ALL ON FUNCTION public.guard_partners_financial_direct_write() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_partners_financial_direct_write() TO service_role;

REVOKE ALL ON FUNCTION public.distribute_invoice_partner_profits_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distribute_invoice_partner_profits_atomic(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.revert_invoice_partner_profits_atomic(uuid, numeric, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revert_invoice_partner_profits_atomic(uuid, numeric, jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.refund_invoice_partial_atomic(text, jsonb, text, uuid, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refund_invoice_partial_atomic(text, jsonb, text, uuid, text, numeric, numeric) TO authenticated, service_role;
