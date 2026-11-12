-- reset_user_store_data()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.reset_user_store_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
$function$
;
