-- =========================================================================
-- Migration: 20261104235500_store_isolation_and_debt_writeoff_atomic.sql
-- Description:
-- 1) Plan 6: Store isolation, owner resolution (get_owner_id), and hardened RLS
--    policies for products, invoices, debts, and partners (restricted to admin/boss).
-- 2) Plan 7: Atomic debt write-off (writeoff_debt_atomic) with pending profit
--    cancellation, invoice status update, customer total_debt deduction, and idempotency.
-- =========================================================================

-- ========================================================
-- 1) تحصين دالة جلب معرف المالك (get_owner_id)
-- ========================================================
CREATE OR REPLACE FUNCTION public.get_owner_id(_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _role app_role;
  _owner_id uuid;
BEGIN
  IF _user_id IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- جلب دور المستخدم ومعرف مالكه إن وُجد
  SELECT role, owner_id INTO _role, _owner_id
  FROM public.user_roles
  WHERE user_id = _user_id
  LIMIT 1;
  
  -- إذا كان المستخدم مالكاً أو مديراً عاماً فهو صاحب المتجر
  IF _role IN ('admin', 'boss') OR _owner_id IS NULL THEN
    RETURN _user_id;
  END IF;
  
  -- إذا كان كاشير أو موزع يُعاد معرف المالك المرتبط به
  RETURN _owner_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_owner_id(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_owner_id(uuid) TO service_role;

-- ========================================================
-- 2) سياسات الأمان RLS الموحدة والصارمة لضمان عزل المتاجر
-- ========================================================

-- جدول المنتجات: القراءة والإدارة بحسب معرف المالك
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Store isolation products" ON public.products;
CREATE POLICY "Store isolation products" ON public.products
  FOR ALL TO authenticated
  USING (user_id = public.get_owner_id(auth.uid()))
  WITH CHECK (user_id = public.get_owner_id(auth.uid()));

-- جدول الفواتير: القراءة والتسجيل بحسب معرف المالك
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Store isolation invoices" ON public.invoices;
CREATE POLICY "Store isolation invoices" ON public.invoices
  FOR ALL TO authenticated
  USING (user_id = public.get_owner_id(auth.uid()))
  WITH CHECK (user_id = public.get_owner_id(auth.uid()));

-- جدول الديون: عزل تام بين المتاجر
ALTER TABLE public.debts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Store isolation debts" ON public.debts;
CREATE POLICY "Store isolation debts" ON public.debts
  FOR ALL TO authenticated
  USING (user_id = public.get_owner_id(auth.uid()))
  WITH CHECK (user_id = public.get_owner_id(auth.uid()));

-- جدول الشركاء: مقتصر حصراً على المالك والمدير العام (يُمنع الكاشير من القراءة المباشرة)
ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Owners only view partners" ON public.partners;
DROP POLICY IF EXISTS "Owners only manage partners" ON public.partners;

CREATE POLICY "Owners only view partners" ON public.partners
  FOR SELECT TO authenticated
  USING (
    user_id = public.get_owner_id(auth.uid()) 
    AND (public.has_role(auth.uid(), 'admin'::app_role) OR public.is_boss(auth.uid()))
  );

CREATE POLICY "Owners only manage partners" ON public.partners
  FOR ALL TO authenticated
  USING (
    user_id = public.get_owner_id(auth.uid()) 
    AND (public.has_role(auth.uid(), 'admin'::app_role) OR public.is_boss(auth.uid()))
  )
  WITH CHECK (
    user_id = public.get_owner_id(auth.uid()) 
    AND (public.has_role(auth.uid(), 'admin'::app_role) OR public.is_boss(auth.uid()))
  );

-- ========================================================
-- 3) دالة الشطب الذري للديون مع إلغاء الربح المعلق وتوثيق السبب
-- ========================================================
CREATE OR REPLACE FUNCTION public.writeoff_debt_atomic(
  _debt_id uuid,
  _reason text,
  _operation_id text
)
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

  RETURN jsonb_build_object(
    'success', true,
    'debt_id', _debt_id,
    'written_off_amount', _debt.remaining_debt,
    'status', 'written_off'
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.writeoff_debt_atomic(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.writeoff_debt_atomic(uuid, text, text) TO service_role;
