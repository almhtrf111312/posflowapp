-- ============================================================================
-- الرجوع عن المرحلة 2 (تعريف الربح الموحّد)
-- ----------------------------------------------------------------------------
-- يعيد دالتي شطب الدين وإقفال الفترة إلى نسختي المرحلة 1 ويحذف مشغّل paid_at_sale وحارسَي الشطب.
-- الأعمدة الجديدة تبقى (لا ضرر منها ولا تُفقد بياناتها):
--   invoices.paid_at_sale، debt_writeoffs.loss_amount / pending_profit_cancelled،
--   accounting_period_closures.realized_profit / pending_profit / bad_debt_loss / closing_timezone.
-- تنبيه: ما حُمّل على الشركاء من خسائر ديون شُطبت بعد تطبيق المرحلة 2 لا يُعكس تلقائياً،
-- وكذلك أي إقفال فترة سُجّل بعدها؛ كلاهما موثّق في جدوله (partner_impact / closing_timezone).
-- ============================================================================

BEGIN;

DROP TRIGGER IF EXISTS c_set_invoice_paid_at_sale ON public.invoices;
DROP FUNCTION IF EXISTS public.set_invoice_paid_at_sale();

DROP TRIGGER IF EXISTS c_guard_written_off_debt ON public.debts;
DROP FUNCTION IF EXISTS public.guard_written_off_debt();
DROP TRIGGER IF EXISTS d_guard_written_off_invoice ON public.invoices;
DROP FUNCTION IF EXISTS public.guard_written_off_invoice();

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

REVOKE ALL ON FUNCTION public.writeoff_debt_atomic(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.writeoff_debt_atomic(uuid, text, text) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.close_accounting_period_atomic(date, date, text);

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

REVOKE ALL ON FUNCTION public.close_accounting_period_atomic(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_accounting_period_atomic(date, date) TO authenticated, service_role;

COMMIT;

SELECT
  to_regprocedure('public.close_accounting_period_atomic(date,date)') IS NOT NULL AS old_close_restored,
  to_regprocedure('public.close_accounting_period_atomic(date,date,text)') IS NULL AS new_close_removed,
  position('loss_amount' in pg_get_functiondef('public.writeoff_debt_atomic(uuid,text,text)'::regprocedure)) = 0 AS writeoff_restored,
  NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.invoices'::regclass AND tgname IN ('c_set_invoice_paid_at_sale', 'd_guard_written_off_invoice')) AS invoice_triggers_removed,
  NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.debts'::regclass AND tgname = 'c_guard_written_off_debt') AS debt_guard_removed;
