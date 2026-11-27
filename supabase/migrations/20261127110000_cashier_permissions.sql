-- Cashier permissions enforced by the server (owner decision 2026-11-27, D-36).
-- Until now «إمكانية إضافة المنتجات» was checked only in the app, and a cashier could not record supplier invoices at all.
--   * products:add — a cashier without it cannot insert or delete products, and may change only the stock fields
--     (quantity / archived) that sales and stock counts write; every other column needs the permission.
--     hard_delete_product_atomic (SECURITY DEFINER) checks it too.
--   * purchases   — a cashier with it may read suppliers and finalize purchase invoices (owner-only before).
-- The store owner and Boss keep full access. The cashier cannot grant itself pages (guarded since SEC2).

-- True for the store owner / Boss, or a member whose profile allowed_pages contains _key.
CREATE OR REPLACE FUNCTION public._caller_has_permission(_key text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL AND (
    public._caller_is_store_manager()
    OR EXISTS (SELECT 1 FROM public.profiles p
                WHERE p.user_id = auth.uid()
                  AND jsonb_typeof(p.allowed_pages) = 'array'
                  AND p.allowed_pages ? _key)
  )
$function$;
REVOKE EXECUTE ON FUNCTION public._caller_has_permission(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._caller_has_permission(text) TO authenticated, service_role;

-- Direct client writes on products by a member without products:add: stock fields only.
CREATE OR REPLACE FUNCTION public.guard_products_cashier_permission()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._direct_client_write() OR public._caller_has_permission('products:add') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'INSERT' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'إضافة المنتجات وحذفها تتطلب صلاحية «إمكانية إضافة المنتجات»' USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['quantity','archived','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['quantity','archived','updated_at']) THEN
    RAISE EXCEPTION 'تعديل بيانات المنتج يتطلب صلاحية «إمكانية إضافة المنتجات»' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $function$;
DROP TRIGGER IF EXISTS a0b_guard_products_permission ON public.products;
CREATE TRIGGER a0b_guard_products_permission BEFORE INSERT OR UPDATE OR DELETE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.guard_products_cashier_permission();

-- Suppliers: a member with the purchases permission may read them (writes stay in the atomic RPCs).
DROP POLICY IF EXISTS "purchases permission reads suppliers" ON public.suppliers;
CREATE POLICY "purchases permission reads suppliers" ON public.suppliers FOR SELECT
  USING (user_id = public.get_owner_id((SELECT auth.uid())) AND public._caller_has_permission('purchases'));

-- Patches (exact occurrence counts asserted; any mismatch aborts the migration).
DO $patch$
DECLARE
  _p record; _src text; _new text; _n int;
BEGIN
  FOR _p IN SELECT * FROM (VALUES
      ('finalize_purchase_invoice_atomic',
       'IF NOT public.is_store_owner(_caller) THEN',
       'IF NOT (public.is_store_owner(_caller) OR public._caller_has_permission(''purchases'')) THEN'),
      ('hard_delete_product_atomic',
       'IF auth.uid() IS NULL OR _owner IS NULL THEN RAISE EXCEPTION ''غير مصرح''; END IF;',
       'IF auth.uid() IS NULL OR _owner IS NULL THEN RAISE EXCEPTION ''غير مصرح''; END IF;' || E'\n' ||
       '  IF NOT public._caller_has_permission(''products:add'') THEN RAISE EXCEPTION ''حذف المنتجات يتطلب صلاحية «إمكانية إضافة المنتجات»'' USING ERRCODE = ''42501''; END IF;')
    ) AS t(fn, old_text, new_text)
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO _src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = _p.fn;
    IF _src IS NULL THEN RAISE EXCEPTION 'permissions patch: function % not found', _p.fn; END IF;
    _src := replace(_src, E'\r', '');
    _n := (length(_src) - length(replace(_src, _p.old_text, ''))) / length(_p.old_text);
    IF _n <> 1 THEN RAISE EXCEPTION 'permissions patch: % has % occurrences of the target (expected 1)', _p.fn, _n; END IF;
    _new := replace(_src, _p.old_text, _p.new_text);
    EXECUTE _new;
  END LOOP;
END $patch$;
