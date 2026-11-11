-- حجب الكتابة عن الحسابات بدون اشتراك مدفوع فعّال (تجربة / منتهٍ). القراءة تبقى مسموحة.
-- طُبّق يدوياً على قاعدة الإنتاج بتاريخ 2026-11-11؛ هذا الملف يوثّقه في المستودع. آمن لإعادة التشغيل.

CREATE OR REPLACE FUNCTION public.has_paid_write_access(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_boss(_user_id)
    OR EXISTS (
      SELECT 1
      FROM public.app_licenses al
      WHERE al.user_id = public.get_owner_id(_user_id)
        AND COALESCE(al.is_revoked, false) = false
        AND COALESCE(al.is_trial, false) = false
        AND al.expires_at > now()
    );
$$;

REVOKE EXECUTE ON FUNCTION public.has_paid_write_access(uuid) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.enforce_paid_write_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_paid_write_access(auth.uid()) THEN
    RAISE EXCEPTION 'subscription_required' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t text;
  gated_tables text[] := ARRAY[
    'accounting_period_closures', 'book_loans', 'cash_shifts', 'categories', 'customers',
    'debt_payments', 'debt_writeoffs', 'debts', 'expenses', 'invoice_items', 'invoice_sequences',
    'invoices', 'library_members', 'maintenance_services', 'partners', 'products', 'profit_records',
    'purchase_invoice_items', 'purchase_invoices', 'recurring_expenses', 'shift_transactions',
    'stock_count_items', 'stock_counts', 'stock_damages', 'stock_movements', 'stock_transfer_items',
    'stock_transfers', 'store_settings', 'stores', 'warehouse_stock', 'warehouses'
  ];
BEGIN
  FOREACH t IN ARRAY gated_tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS a_paid_write_gate ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER a_paid_write_gate
         BEFORE INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.enforce_paid_write_access()',
      t
    );
  END LOOP;
END
$$;

DROP POLICY IF EXISTS "Products require active license" ON public.products;
