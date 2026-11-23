-- FINANCE LAW D-09 / F-21 — partner expense rule (owner decision, 2026-11-23). NEW expenses and NEW profit only.
-- Nothing already recorded is recalculated.
--
--   Expenses (add_expense_atomic):
--     1. category partners (access_all = false) pay their expense percentage of the TOTAL expense, taken off the top;
--     2. general partners (access_all = true) pay their percentage of what REMAINS after step 1;
--     3. the store owner keeps the rest (no partner row). The owner's share is never entered as a number.
--   Percentages (validate_partner_shares): whole numbers only (no fractions). Money amounts keep cents.
--     General expense percentages sum to at most 100; category expense percentages sum to at most 100 on their own.
--   Profit (unchanged, F-21): a category partner takes its percentage of its category's profit first; general
--     partners take their percentage of the remainder; the owner keeps the rest.
--   Reversal (delete_expense_atomic) is unchanged: it reverses the STORED distributions.
--
-- Apply manually after owner approval (AGENTS.md database rule). Generated from the live definitions (md5 verified).

CREATE OR REPLACE FUNCTION public.validate_partner_shares()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _total_pct numeric := 0;
  _other_pct numeric := 0;
  _total_exp_pct numeric := 0;
  _new_exp_pct numeric := 0;
  _cat record;
BEGIN
  -- Skip validation on updates that do not touch share configuration or owner
  IF TG_OP = 'UPDATE'
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.access_all IS NOT DISTINCT FROM OLD.access_all
     AND NEW.share_percentage IS NOT DISTINCT FROM OLD.share_percentage
     AND NEW.expense_share_percentage IS NOT DISTINCT FROM OLD.expense_share_percentage
     AND NEW.category_shares IS NOT DISTINCT FROM OLD.category_shares THEN
    RETURN NEW;
  END IF;

  -- Serialize concurrent share edits for the same store owner
  PERFORM pg_advisory_xact_lock(hashtext('partner_shares:' || NEW.user_id::text));

  -- KD-08 / D-09: whole percentages only (the owner's share is the remainder, never a fraction)
  IF (NEW.share_percentage IS NOT NULL AND NEW.share_percentage <> trunc(NEW.share_percentage))
     OR (NEW.expense_share_percentage IS NOT NULL AND NEW.expense_share_percentage <> trunc(NEW.expense_share_percentage))
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(NEW.category_shares) = 'array' THEN NEW.category_shares ELSE '[]'::jsonb END
       ) cs
       WHERE COALESCE((cs->>'percentage')::numeric, 0) <> trunc(COALESCE((cs->>'percentage')::numeric, 0))
     ) THEN
    RAISE EXCEPTION 'نسب الشركاء يجب أن تكون أعداداً صحيحة بدون فواصل'
      USING ERRCODE = '22023';
  END IF;

  -- Expense share: non-negative
  IF NEW.expense_share_percentage IS NOT NULL AND NEW.expense_share_percentage < 0 THEN
    RAISE EXCEPTION 'نسبة مشاركة المصاريف للشريك لا يمكن أن تكون سالبة'
      USING ERRCODE = '22023';
  END IF;

  -- KD-08 / D-09: expense pools are separate. General partners share what remains after category partners,
  -- so their expense percentages sum to at most 100 (the owner keeps the rest). Category partners' expense
  -- percentages are of the total and also sum to at most 100 on their own.
  _new_exp_pct := COALESCE(NEW.expense_share_percentage, 0);
  IF COALESCE(NEW.access_all, false) = true THEN
    SELECT COALESCE(SUM(COALESCE(expense_share_percentage, 0)), 0)
      INTO _total_exp_pct
    FROM public.partners
    WHERE user_id = NEW.user_id
      AND COALESCE(access_all, false) = true
      AND (TG_OP = 'INSERT' OR id <> OLD.id);
    IF round(_total_exp_pct + _new_exp_pct, 4) > 100 THEN
      RAISE EXCEPTION 'إجمالي مصاريف الشركاء العامين يتجاوز 100%% (الإجمالي: %%%)',
        round(_total_exp_pct + _new_exp_pct, 2)
        USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT COALESCE(SUM(COALESCE(expense_share_percentage, 0)), 0)
      INTO _total_exp_pct
    FROM public.partners
    WHERE user_id = NEW.user_id
      AND COALESCE(access_all, false) = false
      AND (TG_OP = 'INSERT' OR id <> OLD.id);
    IF round(_total_exp_pct + _new_exp_pct, 4) > 100 THEN
      RAISE EXCEPTION 'إجمالي مصاريف شركاء الصنف يتجاوز 100%% (الإجمالي: %%%)',
        round(_total_exp_pct + _new_exp_pct, 2)
        USING ERRCODE = '22023';
    END IF;
  END IF;

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


CREATE OR REPLACE FUNCTION public.add_expense_atomic(_operation_id text, _expense_type text, _amount numeric, _description text DEFAULT NULL::text, _date date DEFAULT CURRENT_DATE, _notes text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _paid_from text DEFAULT NULL::text, _original_currency text DEFAULT 'USD'::text, _original_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT 1)
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
  _orig_ccy text := upper(COALESCE(NULLIF(trim(_original_currency), ''), 'USD'));
  _orig_rate numeric;
  _orig_amt numeric;
  _target_shift_id uuid := NULL;
  _dist jsonb := '[]'::jsonb;
  p record;
  _pct numeric;
  _part numeric;
  _pct_before numeric := 0;
  _cat_total numeric := 0;
  _remaining_amt numeric := 0;
  _drawer boolean := _shift_id IS NOT NULL OR lower(COALESCE(trim(_paid_from), '')) = 'drawer';
  _request jsonb;
  _previous_request jsonb;
  _result jsonb;
BEGIN
  PERFORM set_config('app.partner_source', 'add_expense_atomic', true);
  IF _uid IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF _amt <= 0 OR _amt::text IN ('NaN', 'Infinity', '-Infinity') THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;

  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN RAISE EXCEPTION 'لم يتم العثور على حساب المالك'; END IF;

  IF NULLIF(trim(COALESCE(_operation_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'معرّف العملية مطلوب';
  END IF;

  BEGIN
    _op_uuid := trim(_operation_id)::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    -- Deterministic UUID so retries with a non-UUID _operation_id remain idempotent
    _op_uuid := md5(_owner::text || ':expense:' || trim(_operation_id))::uuid;
  END;

  IF _original_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR _exchange_rate::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'مبلغ المصروف أو سعر الصرف غير صالح';
  END IF;

  -- Resolve currency metadata
  IF _orig_ccy = 'USD' THEN
    _orig_rate := 1;
    _orig_amt := COALESCE(NULLIF(_original_amount, 0), _amt);
  ELSE
    _orig_rate := COALESCE(_exchange_rate, 0);
    IF _orig_rate <= 0 THEN
      RAISE EXCEPTION 'سعر الصرف غير صالح للعملة %', _orig_ccy;
    END IF;
    _orig_amt := COALESCE(NULLIF(_original_amount, 0), round(_amt * _orig_rate, 4));
  END IF;

  IF _orig_amt <= 0 OR abs(_orig_amt / _orig_rate - _amt) > 0.005 + 0.00005 / _orig_rate THEN
    RAISE EXCEPTION 'مبلغ المصروف الأصلي لا يطابق القيمة الدفترية وسعر الصرف';
  END IF;
  IF _drawer AND _shift_id IS NULL THEN
    RAISE EXCEPTION 'يجب تحديد الوردية الأصلية لتسجيل مصروف من الصندوق';
  END IF;
  IF _shift_id IS NOT NULL AND NULLIF(trim(_paid_from), '') IS NOT NULL AND lower(trim(_paid_from)) <> 'drawer' THEN
    RAISE EXCEPTION 'مصدر المصروف لا يطابق الوردية';
  END IF;

  _request := jsonb_build_object(
    'expense_type', _expense_type, 'amount', _amt, 'description', _description,
    'date', COALESCE(_date, CURRENT_DATE), 'notes', _notes, 'shift_id', _shift_id,
    'original_currency', _orig_ccy, 'original_amount', _orig_amt, 'exchange_rate', _orig_rate
  );
  PERFORM pg_advisory_xact_lock(hashtext('expense_op:' || _op_uuid::text));
  SELECT request, result INTO _previous_request, _result
    FROM public.accounting_rpc_receipts
   WHERE user_id = _owner AND kind = 'expense_add' AND operation_id = _op_uuid::text;
  IF FOUND THEN
    IF _previous_request IS DISTINCT FROM _request THEN
      RAISE EXCEPTION 'معرّف المصروف مرتبط بطلب مختلف';
    END IF;
    RETURN _result || jsonb_build_object('already_processed', true);
  END IF;
  IF EXISTS (SELECT 1 FROM public.expenses WHERE id = _op_uuid AND user_id = _owner) THEN
    RAISE EXCEPTION 'تم ترحيل معرّف المصروف سابقاً دون إيصال كامل. راجع سجل المصروف قبل إعادة المحاولة';
  END IF;

  PERFORM public.assert_period_open(_owner, COALESCE(_date, CURRENT_DATE), 'تسجيل مصروف');
  IF _drawer THEN
    SELECT id INTO _target_shift_id FROM public.cash_shifts
     WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL
       AND (cashier_id = _uid OR public.is_store_owner(_uid))
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المستخدم';
    END IF;
  END IF;

  PERFORM 1 FROM public.partners WHERE user_id = _owner ORDER BY id FOR UPDATE;

  -- KD-08 / D-09 (owner decision, 2026-11-23), applies to NEW expenses only.
  -- Step 1: category partners (access_all = false) pay their expense share of the TOTAL, taken off the top.
  FOR p IN
    SELECT * FROM public.partners
    WHERE user_id = _owner AND COALESCE(access_all, false) = false AND COALESCE(expense_share_percentage, 0) > 0
    ORDER BY id
  LOOP
    _pct := p.expense_share_percentage;
    _part := round(_amt * _pct / 100, 4);
    IF _part > 0 THEN
      _cat_total := _cat_total + _part;
      _dist := _dist || jsonb_build_object(
        'partnerId', p.id,
        'partnerName', p.name,
        'amount', _part,
        'percentage', _pct,
        'pool', 'category'
      );

        UPDATE public.partners SET
          current_balance = round(coalesce(current_balance, 0) - _part, 4),
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
  END LOOP;

  -- Step 2: general partners (access_all = true) pay their percentage of what REMAINS after step 1.
  -- The store owner keeps the rest (no partner row); general percentages sum to at most 100.
  _remaining_amt := _amt - _cat_total;
  FOR p IN
    SELECT * FROM public.partners
    WHERE user_id = _owner AND COALESCE(access_all, false) = true AND COALESCE(expense_share_percentage, 0) > 0
    ORDER BY id
  LOOP
    _pct := p.expense_share_percentage;
    _part := round(_remaining_amt * (_pct_before + _pct) / 100, 4)
           - round(_remaining_amt * _pct_before / 100, 4);
    _pct_before := _pct_before + _pct;

    IF _part > 0 THEN
      _dist := _dist || jsonb_build_object(
        'partnerId', p.id,
        'partnerName', p.name,
        'amount', _part,
        'percentage', _pct,
        'pool', 'general'
      );

        UPDATE public.partners SET
          current_balance = round(coalesce(current_balance, 0) - _part, 4),
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
  END LOOP;

  INSERT INTO public.expenses(
    id, user_id, expense_type, amount, description, date, notes, distributions, cashier_id,
    original_currency, original_amount, exchange_rate
  ) VALUES (
    _op_uuid, _owner, _expense_type, _amt, _description, coalesce(_date, CURRENT_DATE), _notes, _dist, _uid,
    _orig_ccy, _orig_amt, _orig_rate
  );

  IF _target_shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions(
      shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes
    ) VALUES (
      _target_shift_id, _owner, 'expense', _amt,
      _orig_ccy, _orig_amt, _orig_rate,
      _op_uuid::text,
      COALESCE(NULLIF(trim(_notes), ''), NULLIF(trim(_description), ''), _expense_type)
    );

    IF FOUND THEN
      UPDATE public.cash_shifts
         SET expected_balance = round(COALESCE(expected_balance, 0) - _amt, 2),
             updated_at = now()
       WHERE id = _target_shift_id
         AND user_id = _owner
         AND closed_at IS NULL;
    END IF;
  END IF;

  _result := jsonb_build_object(
    'success', true,
    'already_processed', false,
    'id', _op_uuid,
    'distributions', _dist,
    'shift_id', _target_shift_id
  );
  INSERT INTO public.accounting_rpc_receipts(user_id, kind, operation_id, request, result)
  VALUES (_owner, 'expense_add', _op_uuid::text, _request, _result);
  RETURN _result;
END;
$function$;
