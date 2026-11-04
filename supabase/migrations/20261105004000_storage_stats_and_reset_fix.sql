-- ============================================================================
-- Migration: 20261105004000_storage_stats_and_reset_fix.sql
-- Description: تحديث دالة إحصائيات التخزين get_user_storage_stats للمالك والـ Boss
-- وتحسين دالة تصفير البيانات reset_user_store_data لحذف حركات الورديات الشاملة
-- ============================================================================

-- 1. تحديث دالة حساب إحصائيات التخزين والبيانات
CREATE OR REPLACE FUNCTION public.get_user_storage_stats(_target_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $$
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

  -- السماح للـ Boss دائماً، أو للمالك بفحص حسابه وموظفيه
  IF NOT _is_boss AND _caller <> _target_user_id AND public.get_owner_id(_target_user_id) <> _caller THEN
    RAISE EXCEPTION 'غير مصرح: هذا الإجراء مخصص للمدير العام ومالك الحساب فقط';
  END IF;

  -- 2. عدد الأصناف
  SELECT count(*) INTO _categories_count
  FROM public.categories
  WHERE user_id = _target_user_id;

  -- 3. عدد المنتجات النشطة
  SELECT count(*) INTO _products_count
  FROM public.products
  WHERE user_id = _target_user_id AND (archived IS NULL OR archived = false);

  -- 4. حساب المساحة التخزينية في storage.objects بدقة
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
$$;

GRANT EXECUTE ON FUNCTION public.get_user_storage_stats(UUID) TO authenticated;


-- 2. تحديث دالة تصفير بيانات المتجر الشاملة
CREATE OR REPLACE FUNCTION public.reset_user_store_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_owner_id uuid;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير مسجل الدخول';
  END IF;

  v_owner_id := public.get_owner_id(v_caller);
  IF v_owner_id IS NULL THEN
    v_owner_id := v_caller;
  END IF;

  -- حذف حركات الورديات لكافة ورديات المتجر لمنع خطأ Foreign Key Constraint
  DELETE FROM public.shift_transactions 
  WHERE shift_id IN (SELECT id FROM public.cash_shifts WHERE user_id = v_owner_id)
     OR user_id = v_owner_id;

  -- حذف الورديات النقدية
  DELETE FROM public.cash_shifts WHERE user_id = v_owner_id;

  -- حذف بنود الفواتير والفواتير
  DELETE FROM public.invoice_items WHERE invoice_id IN (SELECT id FROM public.invoices WHERE user_id = v_owner_id);
  DELETE FROM public.invoices WHERE user_id = v_owner_id;

  -- حذف سجلات الدفع وسجلات الديون
  DELETE FROM public.debt_payments WHERE debt_id IN (SELECT id FROM public.debts WHERE user_id = v_owner_id) OR user_id = v_owner_id;
  DELETE FROM public.debts WHERE user_id = v_owner_id;

  -- حذف حركات المخزون والمشتريات
  DELETE FROM public.purchase_invoice_items WHERE purchase_invoice_id IN (SELECT id FROM public.purchase_invoices WHERE user_id = v_owner_id);
  DELETE FROM public.purchase_invoices WHERE user_id = v_owner_id;
  DELETE FROM public.stock_movements WHERE user_id = v_owner_id;

  -- حذف المصاريف والمصاريف الدورية
  DELETE FROM public.expenses WHERE user_id = v_owner_id;
  DELETE FROM public.recurring_expenses WHERE user_id = v_owner_id;

  -- حذف سجلات الإقفال المحاسبي وحسابات الشركاء
  DELETE FROM public.accounting_period_closures WHERE user_id = v_owner_id;
  DELETE FROM public.partners WHERE user_id = v_owner_id;

  -- حذف المنتجات والتصنيفات والزبائن
  DELETE FROM public.products WHERE user_id = v_owner_id;
  DELETE FROM public.categories WHERE user_id = v_owner_id;
  DELETE FROM public.customers WHERE user_id = v_owner_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'تم تصفير بيانات المتجر بالكامل بنجاح'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_user_store_data() TO authenticated;
