-- Full cash settlement from the invoice screen. The payment RPC owns the ledger,
-- drawer, period checks and partner effects. All linked payments commit together.
CREATE OR REPLACE FUNCTION public.settle_invoice_debts_atomic(
  _invoice_number text, _shift_id uuid, _operation_id uuid)
RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _owner uuid := public.get_owner_id(auth.uid());
  _invoice public.invoices%ROWTYPE;
  _debt public.debts%ROWTYPE;
  _request jsonb := jsonb_build_object('invoice', _invoice_number, 'shift', _shift_id);
  _received numeric := 0;
  _paid_balance numeric := 0;
  _count integer := 0;
BEGIN
  IF auth.uid() IS NULL OR _owner IS NULL OR _operation_id IS NULL THEN
    RAISE EXCEPTION 'تعذّر تحديد المستخدم أو عملية السداد';
  END IF;
  IF public._read_sales_settlement_replay(_owner, 'invoice_cash_settlement', _operation_id::text, _request) IS NOT NULL THEN
    RETURN 0; -- No new receipt to add to the local drawer.
  END IF;
  SELECT * INTO STRICT _invoice FROM public.invoices
    WHERE user_id = _owner AND invoice_number = _invoice_number FOR UPDATE;
  IF _invoice.payment_type IS DISTINCT FROM 'debt' OR _invoice.status IN ('cancelled','refunded','written_off') THEN
    RAISE EXCEPTION 'حالة الفاتورة لا تسمح بسداد الدين';
  END IF;
  FOR _debt IN SELECT * FROM public.debts
    WHERE user_id = _owner AND invoice_id IN (_invoice.invoice_number, _invoice.id::text)
      AND NOT coalesce(is_cash_debt, false) AND status IN ('due','overdue','partially_paid','fully_paid')
    ORDER BY id FOR UPDATE
  LOOP
    _count := _count + 1;
    _paid_balance := _paid_balance + coalesce(_debt.total_paid, 0);
    IF _debt.remaining_debt > 0 THEN
      PERFORM public.record_debt_payment_atomic(_debt.id, _debt.remaining_debt,
        _operation_id::text || ':' || _debt.id::text, _shift_id, 'USD', _debt.remaining_debt, 1, 'cash');
      _received := _received + _debt.remaining_debt;
    END IF;
  END LOOP;
  IF _count = 0 OR (_received = 0 AND _invoice.status IS DISTINCT FROM 'paid') THEN
    RAISE EXCEPTION 'لم يتم العثور على دين مفتوح لتسديد هذه الفاتورة';
  END IF;
  -- Each nested payment updates the invoice from one debt. Preserve the combined
  -- paid balance when historical data contains multiple linked debt rows.
  IF _count > 1 AND _received > 0 THEN
    IF _received IS DISTINCT FROM _invoice.debt_remaining THEN
      RAISE EXCEPTION 'مجموع الديون المرتبطة لا يطابق رصيد الفاتورة. راجع الديون قبل السداد';
    END IF;
    UPDATE public.invoices SET debt_paid = _paid_balance + _received, debt_remaining = 0,
      status = 'paid', updated_at = now() WHERE id = _invoice.id;
  END IF;
  INSERT INTO public.sales_settlement_replays(user_id, kind, operation_id, request, response)
    VALUES (_owner, 'invoice_cash_settlement', _operation_id::text, _request, jsonb_build_object('received', _received));
  RETURN _received;
END;
$$;
REVOKE ALL ON FUNCTION public.settle_invoice_debts_atomic(text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settle_invoice_debts_atomic(text, uuid, uuid) TO authenticated, service_role;
