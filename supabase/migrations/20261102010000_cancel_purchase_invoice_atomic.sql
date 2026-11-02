-- =========================================================================
-- Migration: 20261102010000_cancel_purchase_invoice_atomic.sql
-- Description:
-- 1) Ensure payment_status and payment_method columns exist on purchase_invoices
-- 2) Atomic server function cancel_purchase_invoice_atomic to reverse stock & WAC,
--    document movement in stock_movements (purchase_reversal), and mark status = 'cancelled'
--    without physical deletion (Financial Core Invariant).
-- =========================================================================

-- 1. التأكد من وجود أعمدة حالة وطريقة الدفع في جدول فواتير المشتريات
ALTER TABLE IF EXISTS public.purchase_invoices
  ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'cash';

-- 2. الدالة الذرية لإلغاء فاتورة المشتريات وعكس المخزون والتكلفة بأمان
CREATE OR REPLACE FUNCTION public.cancel_purchase_invoice_atomic(
  _invoice_id UUID,
  _reason TEXT DEFAULT 'Purchase invoice cancellation'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _caller UUID := auth.uid();
  _owner UUID;
  _orig_inv RECORD;
  _old_item RECORD;
  _cur_stock NUMERIC;
  _cur_cost NUMERIC;
  _new_stock NUMERIC;
  _new_cost NUMERIC;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  _owner := public.get_owner_id(_caller);

  -- 1) قفل الفاتورة والتحقق من وجودها وتبعية المالك
  SELECT * INTO _orig_inv
    FROM public.purchase_invoices
   WHERE id = _invoice_id AND user_id = _owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase invoice not found';
  END IF;

  -- إذا كانت ملغاة مسبقاً، نرجع true دون تكرار العملية (Idempotency)
  IF _orig_inv.status = 'cancelled' OR _orig_inv.payment_status = 'cancelled' THEN
    RETURN TRUE;
  END IF;

  -- 2) عكس أثر المخزون والتكلفة المرجحة (WAC Reversal)
  FOR _old_item IN
    SELECT * FROM public.purchase_invoice_items
     WHERE invoice_id = _invoice_id
  LOOP
    IF _old_item.product_id IS NOT NULL THEN
      SELECT quantity, cost_price
        INTO _cur_stock, _cur_cost
        FROM public.products
       WHERE id = _old_item.product_id AND user_id = _owner
         FOR UPDATE;

      IF FOUND THEN
        _new_stock := GREATEST(0, COALESCE(_cur_stock, 0) - COALESCE(_old_item.quantity, 0));

        IF _old_item.cost_price_before IS NOT NULL THEN
          _new_cost := _old_item.cost_price_before;
        ELSIF _new_stock > 0 THEN
          _new_cost := GREATEST(0, ((COALESCE(_cur_stock, 0) * COALESCE(_cur_cost, 0)) - (COALESCE(_old_item.quantity, 0) * COALESCE(_old_item.cost_price, 0))) / _new_stock);
        ELSE
          _new_cost := COALESCE(_cur_cost, 0);
        END IF;

        -- توثيق حركة المخزون كـ purchase_reversal عبر إعدادات الجلسة للمحفز (Trigger)
        PERFORM set_config('app.stock_movement_type', 'purchase_reversal', true);
        PERFORM set_config('app.stock_actor_id', _caller::text, true);
        PERFORM set_config('app.stock_invoice_id', _orig_inv.id::text, true);
        PERFORM set_config('app.stock_invoice_number', _orig_inv.invoice_number, true);
        PERFORM set_config('app.stock_source', 'cancel_purchase_invoice_atomic', true);

        UPDATE public.products
           SET quantity = _new_stock,
               cost_price = _new_cost,
               updated_at = NOW()
         WHERE id = _old_item.product_id;
      END IF;
    END IF;
  END LOOP;

  -- 3) وسم الفاتورة كملغاة دون حذف مادي
  UPDATE public.purchase_invoices
     SET status = 'cancelled',
         payment_status = 'cancelled',
         notes = COALESCE(notes, '') || ' [ملغاة: ' || COALESCE(_reason, 'إلغاء الفاتورة') || ']',
         updated_at = NOW()
   WHERE id = _invoice_id;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_purchase_invoice_atomic(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_invoice_atomic(UUID, TEXT) TO authenticated;
