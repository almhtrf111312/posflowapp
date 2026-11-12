-- hard_delete_product_atomic(_product_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.hard_delete_product_atomic(_product_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _owner uuid := public.get_owner_id(auth.uid());
BEGIN
  IF auth.uid() IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  -- حذف المخزون من المستودعات الفرعية
  DELETE FROM public.warehouse_stock 
  WHERE product_id = _product_id;

  -- حذف المنتج نهائياً من جدول المنتجات
  DELETE FROM public.products 
  WHERE id = _product_id AND user_id = _owner;

  RETURN jsonb_build_object('success', true, 'deleted_id', _product_id);
END;
$function$
;
