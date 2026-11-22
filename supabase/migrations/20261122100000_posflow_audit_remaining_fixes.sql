-- =============================================================================
-- Migration: 20261122100000_posflow_audit_remaining_fixes.sql
-- Already applied to the live project as separate migrations:
--   posflow_boss_push_shared_secret, posflow_recalc_keeps_historical_cost,
--   posflow_fk_indexes_and_fixed_search_path
-- This file records the same SQL in the repo. Idempotent.
--
-- 1) send-boss-push: shared secret stored in Vault (generated inside the DB,
--    never shown to clients). The edge function checks it via check_boss_push_secret.
-- 2) recalc_pos_invoice_profit: keeps the historical cost_price already stored on
--    a sale line; it only fills cost when the stored value is empty/zero.
-- 3) Indexes for foreign keys that had none (linter 0001).
-- 4) Fixed search_path on _partner_ledger_immutable (linter 0011).
-- =============================================================================

-- 1) Shared secret ----------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'boss_push_secret') THEN
    PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'boss_push_secret', 'Shared secret checked by the send-boss-push edge function');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.check_boss_push_secret(p_secret text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $$
  SELECT p_secret IS NOT NULL
     AND p_secret = (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'boss_push_secret' LIMIT 1);
$$;

REVOKE EXECUTE ON FUNCTION public.check_boss_push_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_boss_push_secret(text) TO service_role;

CREATE OR REPLACE FUNCTION public.push_customer_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'vault'
AS $function$
begin
  perform net.http_post(
    url := 'https://bwlqfxfvchjvehnbvwaz.supabase.co/functions/v1/send-boss-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'boss_push_secret' LIMIT 1)
    ),
    body := jsonb_build_object('message_id', NEW.id)
  );
  return NEW;
exception when others then
  return NEW;
end $function$;

CREATE OR REPLACE FUNCTION public.push_app_broadcast()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'vault'
AS $function$
begin
  perform net.http_post(
    url := 'https://bwlqfxfvchjvehnbvwaz.supabase.co/functions/v1/send-boss-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'boss_push_secret' LIMIT 1)
    ),
    body := jsonb_build_object('broadcast_id', NEW.id)
  );
  return NEW;
exception when others then
  return NEW;
end $function$;

-- 2) Historical cost is kept ------------------------------------------------
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

  -- التكلفة التاريخية تُثبَّت عند البيع: نملأها فقط إذا كانت صفراً/فارغة.
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
         warranty_until = CASE WHEN p.warranty_months IS NOT NULL THEN (_inv.date + make_interval(months => p.warranty_months))::date ELSE NULL END
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

-- 3) Foreign-key indexes ----------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_activation_codes_created_by ON public.activation_codes (created_by);
CREATE INDEX IF NOT EXISTS idx_app_licenses_activation_code_id ON public.app_licenses (activation_code_id);
CREATE INDEX IF NOT EXISTS idx_book_loans_member_id ON public.book_loans (member_id);
CREATE INDEX IF NOT EXISTS idx_book_loans_product_id ON public.book_loans (product_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_user_id ON public.error_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_stock_warehouse_id ON public.invoice_items (stock_warehouse_id);
CREATE INDEX IF NOT EXISTS idx_invoices_warehouse_id ON public.invoices (warehouse_id);
CREATE INDEX IF NOT EXISTS idx_phone_transfer_requests_source_user_id ON public.phone_transfer_requests (source_user_id);
CREATE INDEX IF NOT EXISTS idx_purchase_invoice_items_product_id ON public.purchase_invoice_items (product_id);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_supplier_id ON public.purchase_invoices (supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_return_items_invoice_item_id ON public.purchase_return_items (invoice_item_id);
CREATE INDEX IF NOT EXISTS idx_purchase_return_items_return_id ON public.purchase_return_items (return_id);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_invoice_id ON public.purchase_returns (invoice_id);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_supplier_id ON public.purchase_returns (supplier_id);
CREATE INDEX IF NOT EXISTS idx_security_tamper_logs_user_id ON public.security_tamper_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_product_id ON public.stock_transfer_items (product_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_transfer_id ON public.stock_transfer_items (transfer_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_from_warehouse_id ON public.stock_transfers (from_warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_to_warehouse_id ON public.stock_transfers (to_warehouse_id);
CREATE INDEX IF NOT EXISTS idx_subscription_requests_method_id ON public.subscription_requests (method_id);
CREATE INDEX IF NOT EXISTS idx_subscription_requests_plan_id ON public.subscription_requests (plan_id);
CREATE INDEX IF NOT EXISTS idx_support_messages_sender_id ON public.support_messages (sender_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_owner_id ON public.user_roles (owner_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_stock_product_id ON public.warehouse_stock (product_id);

-- 4) search_path -------------------------------------------------------------
ALTER FUNCTION public._partner_ledger_immutable() SET search_path TO 'public';

NOTIFY pgrst, 'reload schema';
