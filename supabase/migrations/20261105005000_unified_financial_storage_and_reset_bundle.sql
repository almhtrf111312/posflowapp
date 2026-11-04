-- ============================================================================
-- حزمة الإصلاحات المالية والأمنية المدمجة لـ FlowPOS Pro
-- 1. دالة إيداع رأس المال أو الرصيد للشريك متعدد العملات (partner_deposit_atomic)
-- 2. دالة سحب الأرباح أو رأس المال متعدد العملات (partner_withdrawal_atomic)
-- 3. دالة فحص إحصائيات التخزين والبيانات لقسم المستخدمين (get_user_storage_stats)
-- 4. دالة التصفير الشامل لبيانات المتجر (reset_user_store_data)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1️⃣ دالة إيداع رأس مال أو رصيد للشريك ذرياً مع دعم العملات والربط بالصندوق
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_deposit_atomic(
  _partner_id uuid,
  _amount_usd numeric,
  _deposit_target text DEFAULT 'capital', -- 'capital' (رأس مال) أو 'balance' (رصيد أرباح)
  _notes text DEFAULT NULL,
  _shift_id uuid DEFAULT NULL,
  _currency text DEFAULT 'USD',
  _original_amount numeric DEFAULT NULL,
  _exchange_rate numeric DEFAULT 1.0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
    IF _currency = 'USD' THEN
      UPDATE public.cash_shifts SET
        expected_cash = round(COALESCE(expected_cash, 0) + _amt_usd, 2),
        updated_at = now()
      WHERE id = _shift_id;
    ELSIF _currency = 'TRY' THEN
      UPDATE public.cash_shifts SET
        expected_try = round(COALESCE(expected_try, 0) + _orig_amt, 2),
        updated_at = now()
      WHERE id = _shift_id;
    ELSIF _currency = 'SYP' THEN
      UPDATE public.cash_shifts SET
        expected_syp = round(COALESCE(expected_syp, 0) + _orig_amt, 2),
        updated_at = now()
      WHERE id = _shift_id;
    END IF;
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

GRANT EXECUTE ON FUNCTION public.partner_deposit_atomic(uuid, numeric, text, text, uuid, text, numeric, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_deposit_atomic(uuid, numeric, text, text, uuid, text, numeric, numeric) TO service_role;


-- ----------------------------------------------------------------------------
-- 2️⃣ دالة سحب أرباح أو رأس مال الشريك متعدد العملات (partner_withdrawal_atomic)
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.partner_withdrawal_atomic(uuid, numeric, text, text, uuid);

CREATE OR REPLACE FUNCTION public.partner_withdrawal_atomic(
  _partner_id uuid,
  _amount numeric,
  _withdrawal_type text,
  _notes text DEFAULT NULL,
  _shift_id uuid DEFAULT NULL,
  _currency text DEFAULT 'USD',
  _original_amount numeric DEFAULT NULL,
  _exchange_rate numeric DEFAULT 1.0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

    IF _currency = 'USD' THEN
      UPDATE public.cash_shifts SET
        expected_cash = round(COALESCE(expected_cash, 0) - v_amt, 2),
        updated_at = now()
      WHERE id = _shift_id;
    ELSIF _currency = 'TRY' THEN
      UPDATE public.cash_shifts SET
        expected_try = round(COALESCE(expected_try, 0) - v_orig_amt, 2),
        updated_at = now()
      WHERE id = _shift_id;
    ELSIF _currency = 'SYP' THEN
      UPDATE public.cash_shifts SET
        expected_syp = round(COALESCE(expected_syp, 0) - v_orig_amt, 2),
        updated_at = now()
      WHERE id = _shift_id;
    END IF;
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

GRANT EXECUTE ON FUNCTION public.partner_withdrawal_atomic(uuid, numeric, text, text, uuid, text, numeric, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_withdrawal_atomic(uuid, numeric, text, text, uuid, text, numeric, numeric) TO service_role;


-- ----------------------------------------------------------------------------
-- 3️⃣ دالة إحصائيات التخزين والبيانات لقسم المستخدمين (get_user_storage_stats)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_storage_stats(_target_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $function$
DECLARE
  _caller UUID := auth.uid();
  _is_boss BOOLEAN := false;
  _caller_role TEXT;
  _categories_count BIGINT := 0;
  _products_count BIGINT := 0;
  _storage_bytes BIGINT := 0;
  _storage_formatted TEXT := '0 KB';
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير مسجل الدخول';
  END IF;

  -- 1. فحص الرتبة
  SELECT role INTO _caller_role FROM public.user_roles WHERE user_id = _caller LIMIT 1;
  _is_boss := (_caller_role = 'boss');

  -- السماح للـ Boss دائماً، أو للمالك بفحص حسابه وحسابات كاشيراته
  IF NOT _is_boss AND _caller <> _target_user_id AND public.get_owner_id(_target_user_id) <> _caller THEN
    RAISE EXCEPTION 'غير مصرح: هذا الإجراء مخصص للمدير العام أو مالك الحساب فقط';
  END IF;

  -- 2. حساب عدد الأصناف
  SELECT count(*) INTO _categories_count
  FROM public.categories
  WHERE user_id = _target_user_id;

  -- 3. حساب عدد المنتجات النشطة غير المؤرشفة
  SELECT count(*) INTO _products_count
  FROM public.products
  WHERE user_id = _target_user_id AND (archived IS NULL OR archived = false);

  -- 4. حساب المساحة التخزينية المستخدمة من storage.objects بأمان كامل
  SELECT coalesce(sum((metadata->>'size')::bigint), 0) INTO _storage_bytes
  FROM storage.objects
  WHERE (storage.foldername(name))[1] = _target_user_id::text 
     OR name LIKE _target_user_id::text || '/%'
     OR owner = _target_user_id
     OR owner_id = _target_user_id::text;

  -- 5. التنسيق
  IF _storage_bytes >= 1073741824 THEN
    _storage_formatted := round((_storage_bytes / 1073741824.0)::numeric, 2) || ' GB';
  ELSIF _storage_bytes >= 1048576 THEN
    _storage_formatted := round((_storage_bytes / 1048576.0)::numeric, 2) || ' MB';
  ELSIF _storage_bytes >= 1024 THEN
    _storage_formatted := round((_storage_bytes / 1024.0)::numeric, 2) || ' KB';
  ELSE
    _storage_formatted := _storage_bytes || ' B';
  END IF;

  RETURN jsonb_build_object(
    'categories_count', _categories_count,
    'products_count', _products_count,
    'storage_bytes', _storage_bytes,
    'storage_formatted', _storage_formatted
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_user_storage_stats(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_storage_stats(UUID) TO service_role;


-- ----------------------------------------------------------------------------
-- 4️⃣ دالة التصفير الشامل لبيانات المتجر (reset_user_store_data)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_user_store_data()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_owner_id uuid;
  v_is_boss boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'يجب تسجيل الدخول أولاً');
  END IF;

  v_is_boss := public.is_boss(v_uid);
  v_owner_id := public.get_owner_id(v_uid);

  -- التحقق من الصلاحية: يجب أن يكون Boss أو مالك المتجر نفسه
  IF NOT v_is_boss AND (v_owner_id IS NULL OR v_owner_id != v_uid) THEN
    RETURN jsonb_build_object('success', false, 'error', 'صلاحية غير كافية: العملية تتطلب مالك المتجر أو Boss');
  END IF;

  -- الحذف بترتيب شجرة الاعتماديات لمنع أخطاء قيود المفاتيح الأجنبية:
  -- 1. الجرد وتعديلات المخزون
  DELETE FROM public.stock_count_items WHERE count_id IN (SELECT id FROM public.stock_counts WHERE user_id = v_owner_id);
  DELETE FROM public.stock_counts WHERE user_id = v_owner_id;
  DELETE FROM public.stock_damages WHERE user_id = v_owner_id;

  -- 2. تحويلات المخازن وتفاصيلها
  DELETE FROM public.stock_transfer_items WHERE transfer_id IN (SELECT id FROM public.stock_transfers WHERE user_id = v_owner_id);
  DELETE FROM public.stock_transfers WHERE user_id = v_owner_id;

  -- 3. حركات المخزون العامة
  DELETE FROM public.stock_movements WHERE user_id = v_owner_id;

  -- 4. بنود الفواتير وسجلات الأرباح والفواتير
  DELETE FROM public.invoice_items WHERE invoice_id IN (SELECT id FROM public.invoices WHERE user_id = v_owner_id);
  DELETE FROM public.profit_records WHERE user_id = v_owner_id;
  DELETE FROM public.invoices WHERE user_id = v_owner_id;

  -- 5. فواتير المشتريات وبنودها
  DELETE FROM public.purchase_invoice_items WHERE invoice_id IN (SELECT id FROM public.purchase_invoices WHERE user_id = v_owner_id);
  DELETE FROM public.purchase_invoices WHERE user_id = v_owner_id;

  -- 6. الديون وسداداتها والإعفاءات
  DELETE FROM public.debt_payments WHERE user_id = v_owner_id;
  DELETE FROM public.debt_writeoffs WHERE user_id = v_owner_id;
  DELETE FROM public.debts WHERE user_id = v_owner_id;

  -- 7. حركات الورديات والصندوق والمصاريف والشركاء
  DELETE FROM public.shift_transactions 
  WHERE shift_id IN (SELECT id FROM public.cash_shifts WHERE user_id = v_owner_id) 
     OR user_id = v_owner_id;

  DELETE FROM public.expenses WHERE user_id = v_owner_id;
  DELETE FROM public.recurring_expenses WHERE user_id = v_owner_id;
  DELETE FROM public.cash_shifts WHERE user_id = v_owner_id;
  DELETE FROM public.maintenance_services WHERE user_id = v_owner_id;
  DELETE FROM public.partners WHERE user_id = v_owner_id;

  -- 8. المنتجات والتصنيفات والعملاء
  DELETE FROM public.warehouse_stock WHERE warehouse_id IN (SELECT id FROM public.warehouses WHERE user_id = v_owner_id);
  DELETE FROM public.products WHERE user_id = v_owner_id;
  DELETE FROM public.categories WHERE user_id = v_owner_id;
  DELETE FROM public.customers WHERE user_id = v_owner_id;
  DELETE FROM public.warehouses WHERE user_id = v_owner_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'تم تصفير جميع بيانات المتجر بنجاح'
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.reset_user_store_data() TO authenticated;
GRANT EXECUTE ON FUNCTION public.reset_user_store_data() TO service_role;
