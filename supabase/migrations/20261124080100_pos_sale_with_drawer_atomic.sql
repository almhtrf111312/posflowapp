-- KD-06 / audit finding F1+F3 (2026-11-24): a cash sale and its drawer movement are written in ONE transaction.
-- New function. process_pos_sale_atomic is not changed. The movement carries the exchange rate and the foreign amount.
-- Idempotent: a replay returns already_processed and posts no second movement (unique index on shift, type, reference).
-- A closed or foreign shift refuses the whole sale (the invoice is rolled back with it).
-- Written by the implementing agent; NOT applied. The owner pastes it into the SQL editor.

CREATE OR REPLACE FUNCTION public.process_pos_sale_with_drawer_atomic(
  _operation_id text,
  _payment_type text,
  _customer_name text,
  _customer_phone text,
  _subtotal numeric,
  _discount numeric,
  _discount_percentage numeric,
  _tax_rate numeric,
  _tax_amount numeric,
  _total numeric,
  _profit numeric,
  _currency text,
  _warehouse_id uuid,
  _items jsonb,
  _down_payment numeric DEFAULT 0,
  _exchange_rate numeric DEFAULT NULL::numeric,
  _tax_mode text DEFAULT NULL::text,
  _shift_id uuid DEFAULT NULL::uuid,
  _currency_amount numeric DEFAULT NULL::numeric
)
RETURNS TABLE(
  success boolean,
  already_processed boolean,
  invoice_id uuid,
  invoice_number text,
  subtotal numeric,
  discount numeric,
  tax_amount numeric,
  total numeric,
  cogs numeric,
  profit numeric,
  debt_paid numeric,
  debt_remaining numeric,
  stock_shortage boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_owner uuid := public.get_owner_id(auth.uid());
  v_ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  v_rate numeric;
  v_amt numeric;
  v_orig numeric;
  v_inserted integer := 0;
BEGIN
  SELECT * INTO r
  FROM public.process_pos_sale_atomic(
    _operation_id, _payment_type, _customer_name, _customer_phone, _subtotal, _discount,
    _discount_percentage, _tax_rate, _tax_amount, _total, _profit, _currency, _warehouse_id,
    _items, _down_payment, _exchange_rate, _tax_mode
  );

  IF NOT COALESCE(r.already_processed, false) AND _payment_type = 'cash' AND _shift_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.cash_shifts cs
       WHERE cs.id = _shift_id AND cs.user_id = v_owner AND cs.closed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'الوردية مغلقة أو غير موجودة: لا يمكن ترحيل بيع نقدي إليها';
    END IF;

    v_rate := CASE WHEN v_ccy = 'USD' THEN 1 ELSE _exchange_rate END;
    v_amt := round(r.total, 2);
    v_orig := COALESCE(_currency_amount, round(v_amt * COALESCE(v_rate, 1), 2));

    INSERT INTO public.shift_transactions (
      shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, notes, reference_id
    ) VALUES (
      _shift_id, v_owner, 'sale', v_amt, v_ccy, v_orig, COALESCE(v_rate, 1), 'مبيعات نقدية', _operation_id
    )
    ON CONFLICT (shift_id, type, reference_id) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF v_inserted = 1 THEN
      UPDATE public.cash_shifts
         SET expected_balance = round(COALESCE(expected_balance, 0) + v_amt, 2),
             updated_at = now()
       WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL;
    END IF;
  END IF;

  RETURN QUERY SELECT r.success, r.already_processed, r.invoice_id, r.invoice_number, r.subtotal,
    r.discount, r.tax_amount, r.total, r.cogs, r.profit, r.debt_paid, r.debt_remaining, r.stock_shortage;
END;
$function$;
