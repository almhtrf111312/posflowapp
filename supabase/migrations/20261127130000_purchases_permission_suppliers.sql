-- Cashier with the «إضافة فواتير الموردين (المشتريات)» permission (D-36) could not record a purchase invoice for a NEW supplier:
-- create_supplier_atomic refused with «إدارة الموردين لمالك المتجر ومديره فقط» (agent test P3, 2026-11-27).
-- Only creating a supplier and linking a purchase invoice to it are opened to that permission.
-- Supplier payments, refunds and purchase returns (money in/out of the drawer) stay owner-only through _supplier_owner().
CREATE OR REPLACE FUNCTION public._supplier_owner_for_purchases()
 RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _c uuid := auth.uid();
BEGIN
  IF _c IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT (public.is_store_owner(_c) OR public._caller_has_permission('purchases')) THEN
    RAISE EXCEPTION 'إدارة الموردين لمالك المتجر ومديره فقط' USING ERRCODE='42501';
  END IF;
  RETURN public.get_owner_id(_c);
END $function$;
REVOKE EXECUTE ON FUNCTION public._supplier_owner_for_purchases() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._supplier_owner_for_purchases() TO authenticated, service_role;

DO $patch$
DECLARE _p record; _src text; _n int;
BEGIN
  FOR _p IN SELECT unnest(ARRAY['create_supplier_atomic', 'link_purchase_to_supplier_atomic']) AS fn LOOP
    SELECT pg_get_functiondef(p.oid) INTO _src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = _p.fn;
    IF _src IS NULL THEN RAISE EXCEPTION 'purchases patch: function % not found', _p.fn; END IF;
    _src := replace(_src, E'\r', '');
    _n := (length(_src) - length(replace(_src, 'public._supplier_owner()', ''))) / length('public._supplier_owner()');
    IF _n <> 1 THEN RAISE EXCEPTION 'purchases patch: % has % calls of _supplier_owner() (expected 1)', _p.fn, _n; END IF;
    EXECUTE replace(_src, 'public._supplier_owner()', 'public._supplier_owner_for_purchases()');
  END LOOP;
END $patch$;
