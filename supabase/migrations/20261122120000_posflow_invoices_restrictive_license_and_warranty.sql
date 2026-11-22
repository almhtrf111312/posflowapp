-- =============================================================================
-- Migration: 20261122120000_posflow_invoices_restrictive_license_and_warranty.sql
-- Already applied to the live project as:
--   posflow_invoices_license_policy_restrictive, posflow_recalc_keeps_historical_warranty
-- Rollback (policy): recreate it as PERMISSIVE (see supabase/live-snapshots/rollbacks/
--   ROLLBACK_invoices_restrictive_license.sql).
--
-- 1) invoices INSERT. Two PERMISSIVE INSERT policies are OR-ed:
--      "Users insert own invoices"  : user_id = get_owner_id(auth.uid())
--      "Enforce device license ..." : caller license not revoked (no user_id check)
--    so any caller with a non-revoked license could insert an invoice for ANOTHER store
--    (verified in a rolled-back test), and a revoked caller still passed the first one.
--    The license check is now RESTRICTIVE, so an insert needs BOTH conditions.
--    Verified after applying: cross-store insert blocked, own-store insert allowed.
-- 2) recalc_pos_invoice_profit keeps the warranty_until already stored on the sale line
--    (it was recomputed from the product's CURRENT warranty months). It only fills it
--    when empty.
-- =============================================================================

DROP POLICY IF EXISTS "Enforce device license on invoice insert" ON public.invoices;
CREATE POLICY "Enforce device license on invoice insert"
  ON public.invoices
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (EXISTS (SELECT 1 FROM public.user_roles WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'boss'::app_role))
    OR NOT (EXISTS (SELECT 1 FROM public.app_licenses WHERE app_licenses.user_id = public.get_owner_id(auth.uid()) AND app_licenses.is_revoked = true))
  );

CREATE OR REPLACE FUNCTION public.recalc_pos_invoice_profit(_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE;
  _cogs numeric;
  _sub numeric;
  _f numeric := 1;
BEGIN
  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF COALESCE(_inv.tax_inclusive, false) AND COALESCE(_inv.tax_rate, 0) > 0 THEN
    _f := 1 / (1 + _inv.tax_rate / 100);
  END IF;

  -- التكلفة والضمان التاريخيان يُثبَّتان عند البيع: يُملآن فقط إذا كانا فارغين.
  UPDATE public.invoice_items ii
     SET cost_price = CASE
           WHEN COALESCE(ii.cost_price, 0) <> 0 THEN ii.cost_price
           ELSE round(
             COALESCE(p.cost_price, 0) * (
               CASE
                 WHEN COALESCE(ii.unit, 'piece') = 'bulk' THEN (CASE WHEN COALESCE(p.bulk_cost_price,0) > 0 AND COALESCE(p.cost_price,0) > 0 THEN p.bulk_cost_price / p.cost_price ELSE GREATEST(COALESCE(ii.conversion_factor, 1), 1) END)
                 ELSE 1
               END
             ), 8)
         END,
         warranty_until = COALESCE(
           ii.warranty_until,
           CASE WHEN p.warranty_months IS NOT NULL THEN (_inv.date + make_interval(months => p.warranty_months))::date ELSE NULL END
         )
    FROM public.products p
   WHERE ii.invoice_id = _invoice_id AND p.id = ii.product_id AND p.user_id = _inv.user_id;

  SELECT COALESCE(SUM(COALESCE(cost_price, 0) * COALESCE(quantity, 0)), 0),
         COALESCE(SUM(COALESCE(unit_price, 0) * COALESCE(quantity, 0)), 0)
    INTO _cogs, _sub FROM public.invoice_items WHERE invoice_id = _invoice_id;

  UPDATE public.invoice_items
     SET profit = round(((COALESCE(unit_price, 0) * COALESCE(quantity, 0))
                  - CASE WHEN _sub > 0 THEN COALESCE(_inv.discount, 0) * (COALESCE(unit_price, 0) * COALESCE(quantity, 0)) / _sub ELSE 0 END) * _f
                  - COALESCE(cost_price, 0) * COALESCE(quantity, 0), 8)
   WHERE invoice_id = _invoice_id;

  UPDATE public.invoices
     SET profit = round((COALESCE(subtotal, _sub) - COALESCE(discount, 0)) * _f - _cogs, 8)
   WHERE id = _invoice_id;
END;
$function$;

NOTIFY pgrst, 'reload schema';
