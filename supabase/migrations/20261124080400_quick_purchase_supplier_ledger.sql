-- AUDIT FINDING F7 (2026-11-24): a quick purchase on credit wrote no supplier entry and had no supplier.
--  * a credit quick purchase must carry an active supplier of this store (raises otherwise);
--  * the invoice is linked to that supplier, so finalize_purchase_invoice_atomic writes the purchase entry;
--  * supplier_name is the supplier's name for credit purchases (it was the product name);
--  * cash quick purchases are unchanged (no supplier link, so no change to the drawer path).
-- Written by the implementing agent; NOT applied. The owner pastes it into the SQL editor.

CREATE OR REPLACE FUNCTION public.process_quick_purchase_atomic(_operation_id uuid, _purchase jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _existing public.purchase_invoices%ROWTYPE;
  _product_id uuid := NULLIF(_purchase->>'productId', '')::uuid;
  _shift_id uuid := NULLIF(_purchase->>'shiftId', '')::uuid;
  _supplier_id uuid := NULLIF(_purchase->>'supplierId', '')::uuid;
  _name text := NULLIF(btrim(_purchase->>'productName'), '');
  _barcode text := NULLIF(btrim(_purchase->>'barcode'), '');
  _category text := NULLIF(btrim(_purchase->>'category'), '');
  _image text := NULLIF(_purchase->>'imageUrl', '');
  _method text := _purchase->>'paymentMethod';
  _qty numeric := (_purchase->>'quantity')::numeric;
  _cost numeric := (_purchase->>'costPrice')::numeric;
  _price numeric := COALESCE((_purchase->>'salePrice')::numeric, _cost);
  _total numeric;
  _invoice_number text := 'QP-' || _operation_id::text;
  _result jsonb;
  _cash_amount numeric;
  _cash_shift_id uuid;
  _creates_product boolean;
BEGIN
  IF _caller IS NULL OR _operation_id IS NULL THEN
    RAISE EXCEPTION 'Authentication and operation ID are required';
  END IF;
  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'Store context is required';
  END IF;
  IF _name IS NULL OR _method IS NULL OR _method NOT IN ('cash', 'credit')
     OR _qty IS NULL OR NOT (_qty > 0 AND _qty < 1000000000)
     OR _cost IS NULL OR NOT (_cost >= 0 AND _cost < 1000000000)
     OR _price IS NULL OR NOT (_price >= 0 AND _price < 1000000000) THEN
    RAISE EXCEPTION 'Invalid quick purchase input';
  END IF;
  _total := round(_qty * _cost, 8);

  -- F7 (audit 2026-11-24): a credit quick purchase must name an active supplier of this store.
  IF _method = 'credit' THEN
    IF _supplier_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.suppliers sp WHERE sp.id = _supplier_id AND sp.user_id = _owner AND COALESCE(sp.is_active, true)
    ) THEN
      RAISE EXCEPTION 'يلزم اختيار مورد للشراء الآجل';
    END IF;
  END IF;

  -- Serialize duplicate requests and product resolution for quick purchases within the same store.
  PERFORM pg_advisory_xact_lock(hashtextextended('flowpos-quick-purchase:' || _owner::text, 0));
  SELECT * INTO _existing FROM public.purchase_invoices
    WHERE id = _operation_id AND user_id = _owner;
  IF FOUND THEN
    IF _existing.invoice_number <> _invoice_number OR _existing.status IS DISTINCT FROM 'finalized' THEN
      RAISE EXCEPTION 'Operation ID is already used by a different purchase';
    END IF;
    SELECT amount, shift_id INTO _cash_amount, _cash_shift_id FROM public.shift_transactions
      WHERE user_id = _owner AND type = 'withdrawal' AND reference_id = _operation_id::text
      LIMIT 1;
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'invoice_id', _existing.id,
      'cash_amount', _cash_amount, 'shift_id', _cash_shift_id);
  END IF;

  -- Lock the specific drawer before writing stock. Closure and payment must agree on the shift.
  IF _method = 'cash' AND _total > 0 THEN
    PERFORM 1 FROM public.cash_shifts
    WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL
      AND (cashier_id::text = _caller::text OR _caller = _owner)
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'An open cash shift for this purchase is required';
    END IF;
  END IF;

  IF _product_id IS NOT NULL THEN
    PERFORM 1 FROM public.products
      WHERE id = _product_id AND user_id = _owner AND NOT COALESCE(archived, false);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product is not available in this store';
    END IF;
  ELSE
    IF _barcode IS NOT NULL THEN
      SELECT id INTO _product_id FROM public.products WHERE user_id = _owner AND barcode = _barcode
        ORDER BY created_at, id LIMIT 1;
    END IF;
    IF _product_id IS NULL THEN
      SELECT id INTO _product_id FROM public.products
        WHERE user_id = _owner AND lower(btrim(name)) = lower(_name)
        ORDER BY created_at, id LIMIT 1;
    END IF;
    IF _product_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.products WHERE id = _product_id AND COALESCE(archived, false)
    ) THEN
      RAISE EXCEPTION 'Matching product is archived';
    END IF;
  END IF;
  _creates_product := _product_id IS NULL;

  INSERT INTO public.purchase_invoices (
    id, user_id, invoice_number, supplier_name, invoice_date, status, payment_method, image_url, supplier_id,
    expected_items_count, expected_total_quantity, expected_grand_total,
    actual_items_count, actual_total_quantity, actual_grand_total
  ) VALUES (
    _operation_id, _owner, _invoice_number, CASE WHEN _method = 'credit' THEN (SELECT sp.name FROM public.suppliers sp WHERE sp.id = _supplier_id) ELSE _name END, CURRENT_DATE, 'draft', _method, _image, CASE WHEN _method = 'credit' THEN _supplier_id ELSE NULL END,
    1, _qty, _total, 1, _qty, _total
  );
  INSERT INTO public.purchase_invoice_items (
    invoice_id, product_id, product_name, barcode, category, quantity, cost_price, sale_price, total_cost
  ) VALUES (_operation_id, _product_id, _name, _barcode, _category, _qty, _cost, _price, _total);

  _result := public.finalize_purchase_invoice_atomic(_operation_id);
  IF NOT COALESCE((_result->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'Purchase finalization failed';
  END IF;
  SELECT product_id INTO STRICT _product_id FROM public.purchase_invoice_items WHERE invoice_id = _operation_id;

  UPDATE public.products
  SET sale_price = CASE WHEN _price > 0 THEN _price ELSE sale_price END,
      barcode = COALESCE(_barcode, barcode),
      category = COALESCE(_category, category),
      expiry_date = COALESCE(NULLIF(_purchase->>'expiryDate', '')::date, expiry_date),
      image_url = COALESCE(_image, image_url),
      custom_fields = CASE WHEN _purchase ? 'wholesalePrice'
        THEN COALESCE(custom_fields, '{}'::jsonb) || jsonb_build_object('wholesalePrice', (_purchase->>'wholesalePrice')::numeric)
        ELSE custom_fields END,
      min_stock_level = CASE WHEN _creates_product THEN COALESCE((_purchase->>'minStockLevel')::integer, min_stock_level) ELSE min_stock_level END,
      track_by_unit = CASE WHEN _creates_product AND _purchase->>'trackByUnit' IN ('piece','bulk') THEN _purchase->>'trackByUnit' ELSE track_by_unit END,
      bulk_unit = CASE WHEN _creates_product THEN COALESCE(_purchase->>'bulkUnit', bulk_unit) ELSE bulk_unit END,
      small_unit = CASE WHEN _creates_product THEN COALESCE(_purchase->>'smallUnit', small_unit) ELSE small_unit END,
      conversion_factor = CASE WHEN _creates_product THEN GREATEST(COALESCE((_purchase->>'conversionFactor')::numeric, 1), 1) ELSE conversion_factor END,
      bulk_cost_price = CASE WHEN _creates_product THEN COALESCE((_purchase->>'bulkCostPrice')::numeric, bulk_cost_price) ELSE bulk_cost_price END,
      bulk_sale_price = CASE WHEN _creates_product THEN COALESCE((_purchase->>'bulkSalePrice')::numeric, bulk_sale_price) ELSE bulk_sale_price END,
      updated_at = now()
  WHERE id = _product_id AND user_id = _owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unable to update product details';
  END IF;

  IF _method = 'cash' AND _total > 0 THEN
    INSERT INTO public.shift_transactions (
      shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes
    ) VALUES (
      _shift_id, _owner, 'withdrawal', _total, 'USD', _total, 1, _operation_id::text, 'Quick purchase'
    );
  END IF;

  RETURN jsonb_build_object('success', true, 'already_processed', false, 'invoice_id', _operation_id,
    'cash_amount', CASE WHEN _method = 'cash' THEN _total END,
    'shift_id', CASE WHEN _method = 'cash' AND _total > 0 THEN _shift_id END);
END;
$function$;
