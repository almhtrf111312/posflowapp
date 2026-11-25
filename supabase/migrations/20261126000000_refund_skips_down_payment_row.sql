-- Regression fix for 20261125170000 (M-3): the down payment row written to debt_payments is the sale-time receipt.
-- _allocate_sales_refund already handles that receipt via invoices.paid_at_sale and the sale's drawer movement, so the
-- loop over documented debt payments must skip it. Without this a credit invoice with a down payment could not be refunded
-- ("one of the original debt payments is not documented enough"). Only the WHERE clause of that loop changed.

CREATE OR REPLACE FUNCTION public._allocate_sales_refund(_inv invoices, _kind text, _operation text, _wanted numeric, _shift uuid, _mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  _receipts jsonb := '[]'::jsonb;
  _receipt record;
  _take numeric;
  _pending numeric := greatest(round(coalesce(_wanted, 0), 8), 0);
  _available numeric := 0;
  _previous numeric;
  _previous_usd numeric;
  _previous_original numeric;
  _net_usd numeric;
  _net_original numeric;
  _cash numeric := 0;
  _digital numeric := 0;
  _drawer numeric := 0;
  _drawer_recorded boolean := false;
  _allocations jsonb := '[]'::jsonb;
  _sale_settled numeric;
  _sale_shift public.shift_transactions%ROWTYPE;
  _sale_matches integer;
  _sale_method text;
  _sale_currency text;
  _sale_rate numeric;
  _sale_original numeric;
  _payment record;
BEGIN
  IF _pending <= 0 THEN
    RETURN jsonb_build_object('cash', 0, 'digital', 0, 'drawer', 0, 'allocations', _allocations);
  END IF;
  IF _mode NOT IN ('drawer', 'external_cash') THEN RAISE EXCEPTION 'وضع تسوية المرتجع غير صالح'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.activity_log l
     WHERE l.user_id = _inv.user_id AND l.entity_id = _inv.id::text AND l.action_type = 'partial_refund'
       AND COALESCE((l.metadata->>'cash_to_refund')::numeric, 0)
           + COALESCE((l.metadata->>'digital_to_refund')::numeric, 0) > 0
       AND NOT COALESCE((l.metadata->>'receipt_allocation')::boolean, false)
  ) THEN
    RAISE EXCEPTION 'يلزم مطابقة المرتجع السابق مع إيصالات القبض قبل تسجيل رد إضافي';
  END IF;

  _sale_settled := CASE WHEN _inv.payment_type = 'debt' THEN COALESCE(_inv.paid_at_sale, 0)
    ELSE COALESCE(NULLIF(_inv.paid_at_sale, 0), _inv.total + COALESCE((
      SELECT sum(a.settled_amount) FROM public.sales_refund_allocations a
       WHERE a.user_id = _inv.user_id AND a.invoice_id = _inv.id AND a.receipt_key = 'sale'
    ), 0)) END;
  IF _sale_settled > 0 THEN
    -- Cash receipts must be traceable when refunding a debt invoice. Paid-at-sale was historically inferred.
    _sale_method := CASE _inv.payment_method WHEN 'digital' THEN 'transfer' WHEN 'cash' THEN 'cash' END;
    _sale_currency := upper(COALESCE(NULLIF(trim(_inv.currency), ''), 'USD'));
    _sale_rate := CASE WHEN _sale_currency = 'USD' THEN 1 ELSE _inv.exchange_rate END;
    IF _sale_method IS NULL OR COALESCE(_sale_rate, 0) <= 0 THEN
      RAISE EXCEPTION 'وسيلة قبض البيع الأصلي أو عملته غير موثقة';
    END IF;

    SELECT count(*) INTO _sale_matches FROM public.shift_transactions t
     WHERE t.user_id = _inv.user_id AND t.reference_id IN (_inv.operation_id, _inv.invoice_number, _inv.id::text)
       AND t.type IN ('sale', 'digital_sale');
    IF _sale_matches = 1 THEN
      SELECT t.* INTO _sale_shift FROM public.shift_transactions t
       WHERE t.user_id = _inv.user_id AND t.reference_id IN (_inv.operation_id, _inv.invoice_number, _inv.id::text)
         AND t.type IN ('sale', 'digital_sale');
      IF (CASE _sale_shift.type WHEN 'sale' THEN 'cash' ELSE 'transfer' END) <> _sale_method
         OR upper(COALESCE(_sale_shift.currency, 'USD')) <> _sale_currency
         OR abs(_sale_shift.amount - _sale_settled) > 0.005 THEN
        RAISE EXCEPTION 'حركة قبض البيع الأصلي لا تطابق الفاتورة';
      END IF;
      _sale_original := CASE WHEN _sale_currency = 'USD' THEN _sale_shift.amount ELSE _sale_shift.currency_amount END;
      IF COALESCE(_sale_original, 0) <= 0 OR abs(_sale_original / _sale_rate - _sale_shift.amount) > 0.005 THEN
        RAISE EXCEPTION 'مبلغ عملة حركة البيع الأصلية غير موثق';
      END IF;
    ELSIF _sale_matches <> 0 OR _inv.payment_type = 'debt' THEN
      RAISE EXCEPTION 'تعذّر تحديد حركة الدفعة الأولى الأصلية';
    ELSE
      _sale_original := round(_sale_settled * _sale_rate, 4);
    END IF;
    _receipts := _receipts || jsonb_build_object('key', 'sale', 'method', _sale_method,
      'ccy', _sale_currency, 'rate', _sale_rate, 'settled', _sale_settled,
      'usd', CASE WHEN _sale_matches = 1 THEN _sale_shift.amount ELSE round(_sale_settled, 2) END,
      'original', _sale_original);
  END IF;

  IF _inv.payment_type = 'debt' THEN
    FOR _payment IN
      SELECT p.*, (SELECT count(*) FROM public.shift_transactions t
               WHERE t.shift_id = p.shift_id AND t.user_id = p.user_id AND t.type = 'debt_payment'
                 AND t.reference_id = p.operation_id) AS movements,
             (SELECT t.currency_amount FROM public.shift_transactions t
               WHERE t.shift_id = p.shift_id AND t.user_id = p.user_id AND t.type = 'debt_payment'
                 AND t.reference_id = p.operation_id
                 AND t.amount = p.amount AND upper(t.currency) = upper(p.currency) AND t.exchange_rate = p.exchange_rate
               LIMIT 1) AS movement_currency_amount
        FROM public.debt_payments p JOIN public.debts d ON d.id = p.debt_id AND d.user_id = p.user_id
       WHERE p.user_id = _inv.user_id AND NOT COALESCE(d.is_cash_debt, false)
         AND d.invoice_id IN (_inv.invoice_number, _inv.id::text)
         -- the sale-time down payment (operation id '<sale op>:down', migration 20261125170000) is the sale receipt,
         -- already counted through invoices.paid_at_sale and its 'sale' drawer movement
         AND p.operation_id NOT LIKE '%:down'
       ORDER BY p.created_at, p.id
    LOOP
      IF COALESCE(_payment.settled_amount, 0) <= 0 OR COALESCE(_payment.amount, -1) < 0
         OR COALESCE(_payment.payment_method, '') NOT IN ('cash', 'transfer')
         OR NULLIF(trim(_payment.currency), '') IS NULL OR COALESCE(_payment.exchange_rate, 0) <= 0
         OR (_payment.payment_method = 'cash' AND _payment.amount > 0
             AND (_payment.movements <> 1 OR _payment.movement_currency_amount IS NULL))
         OR (_payment.payment_method = 'transfer' AND _payment.shift_id IS NOT NULL) THEN
        RAISE EXCEPTION 'إحدى دفعات الدين الأصلية غير موثقة بما يكفي للرد';
      END IF;
      _sale_original := CASE WHEN upper(_payment.currency) = 'USD' THEN _payment.amount
                        ELSE COALESCE(_payment.currency_amount, _payment.movement_currency_amount) END;
      IF _sale_original IS NULL OR _sale_original < 0
          OR (_payment.amount > 0 AND _sale_original <= 0)
          OR abs(_sale_original / _payment.exchange_rate - _payment.amount) > 0.005 THEN
        RAISE EXCEPTION 'مبلغ العملة الأصلية لإحدى الدفعات غير موثق';
      END IF;
      _receipts := _receipts || jsonb_build_object('key', 'debt:' || _payment.id::text,
        'method', _payment.payment_method, 'ccy', upper(_payment.currency), 'rate', _payment.exchange_rate,
        'settled', _payment.settled_amount, 'usd', _payment.amount, 'original', _sale_original);
    END LOOP;
  END IF;

  SELECT COALESCE(sum(s.settled - COALESCE(previous.used, 0)), 0) INTO _available
    FROM jsonb_to_recordset(_receipts) AS s(key text, settled numeric)
    LEFT JOIN LATERAL (SELECT sum(a.settled_amount) AS used FROM public.sales_refund_allocations a
      WHERE a.user_id = _inv.user_id AND a.invoice_id = _inv.id AND a.receipt_key = s.key) previous ON true;
  IF _pending > _available + 0.0001
       OR (_inv.payment_type = 'debt' AND abs(_available - COALESCE(_inv.debt_paid, 0)) > 0.0001) THEN
    RAISE EXCEPTION 'مبلغ الرد لا يطابق المتبقي من إيصالات القبض الأصلية';
  END IF;
  _pending := LEAST(_pending, _available);

  IF _mode = 'drawer' AND EXISTS (SELECT 1 FROM jsonb_to_recordset(_receipts) AS s(method text) WHERE s.method = 'cash') THEN
    IF _shift IS NOT NULL THEN
      PERFORM 1 FROM public.cash_shifts WHERE id = _shift AND user_id = _inv.user_id AND closed_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'وردية الرد غير موجودة أو مغلقة أو لا تتبع لهذا المتجر'; END IF;
    END IF;
  END IF;

  FOR _receipt IN
    SELECT s.* FROM jsonb_array_elements(_receipts) WITH ORDINALITY r(value, ordinal)
      CROSS JOIN LATERAL jsonb_to_record(r.value)
        AS s(key text, method text, ccy text, rate numeric, settled numeric, usd numeric, original numeric)
      ORDER BY r.ordinal
  LOOP
    EXIT WHEN _pending <= 0;
    SELECT COALESCE(sum(a.settled_amount), 0), COALESCE(sum(a.tender_usd), 0), COALESCE(sum(a.currency_amount), 0)
      INTO _previous, _previous_usd, _previous_original
      FROM public.sales_refund_allocations a
     WHERE a.user_id = _inv.user_id AND a.invoice_id = _inv.id AND a.receipt_key = _receipt.key;
    _take := LEAST(_pending, _receipt.settled - _previous);
    CONTINUE WHEN _take <= 0;
    _net_usd := round(_receipt.usd * (_previous + _take) / _receipt.settled, 8) - _previous_usd;
    _net_original := round(_receipt.original * (_previous + _take) / _receipt.settled,
      CASE WHEN _receipt.ccy = 'USD' THEN 2 ELSE 4 END) - _previous_original;
    IF _net_usd < 0 OR _net_original < 0 THEN RAISE EXCEPTION 'تعارض في رصيد إيصال القبض التاريخي'; END IF;

    IF _receipt.method = 'cash' THEN
      _cash := _cash + _net_usd;
      IF _mode = 'drawer' AND (_net_usd > 0 OR _net_original > 0) THEN
        IF _shift IS NULL THEN RAISE EXCEPTION 'الرد النقدي يتطلب وردية تسوية صريحة ومفتوحة'; END IF;
        INSERT INTO public.shift_transactions(shift_id, user_id, type, amount, reference_id, notes, currency, currency_amount, exchange_rate)
        VALUES (_shift, _inv.user_id, 'refund', _net_usd, 'receipt-refund:' || _kind || ':' || _operation || ':' || _receipt.key,
          'رد إيصال قبض للفاتورة ' || _inv.invoice_number, _receipt.ccy, _net_original, _receipt.rate);
        _drawer := _drawer + _net_usd;
        _drawer_recorded := true;
      END IF;
    ELSE
      _digital := _digital + _net_usd;
    END IF;

    INSERT INTO public.sales_refund_allocations(user_id, invoice_id, kind, operation_id, receipt_key,
      method, currency, exchange_rate, settled_amount, tender_usd, currency_amount, shift_id, settlement_mode)
    VALUES (_inv.user_id, _inv.id, _kind, _operation, _receipt.key, _receipt.method, _receipt.ccy, _receipt.rate,
      _take, _net_usd, _net_original, CASE WHEN _receipt.method = 'cash' AND _mode = 'drawer' THEN _shift END, _mode);
    _allocations := _allocations || jsonb_build_object('method', _receipt.method, 'currency', _receipt.ccy, 'exchange_rate', _receipt.rate,
      'currency_amount', _net_original, 'tender_usd', _net_usd, 'settled_amount', _take);
    _pending := _pending - _take;
  END LOOP;

  IF _drawer > 0 THEN
    UPDATE public.cash_shifts SET expected_balance = round(COALESCE(expected_balance, 0) - _drawer, 8), updated_at = now()
     WHERE id = _shift AND user_id = _inv.user_id AND closed_at IS NULL;
  END IF;

  RETURN jsonb_build_object('cash', _cash, 'digital', _digital, 'drawer', _drawer,
    'drawer_recorded', _drawer_recorded, 'allocations', _allocations);
END;
$function$;
