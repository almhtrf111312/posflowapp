-- PosFlow phase 6b: supplier refund, drawer/external payment source, mandatory supplier master on purchase invoices.
-- (Applied to bwlqfxfvchjvehnbvwaz via MCP as posflow_phase6b_supplier_drawer_refund.)
ALTER TABLE public.supplier_ledger_entries
  ADD COLUMN IF NOT EXISTS payment_source text CHECK (payment_source IN ('drawer','external')),
  ADD COLUMN IF NOT EXISTS shift_id uuid;
ALTER TABLE public.supplier_ledger_entries DROP CONSTRAINT IF EXISTS supplier_ledger_entries_entry_type_check;
ALTER TABLE public.supplier_ledger_entries ADD CONSTRAINT supplier_ledger_entries_entry_type_check
  CHECK (entry_type IN ('purchase','payment','purchase_return','adjustment','refund'));
DROP INDEX IF EXISTS public.uq_supplier_ledger_op;
CREATE UNIQUE INDEX uq_supplier_ledger_op ON public.supplier_ledger_entries(user_id, operation_id, entry_type) WHERE operation_id IS NOT NULL;

ALTER TABLE public.purchase_invoices
  ADD COLUMN IF NOT EXISTS paid_from text CHECK (paid_from IN ('drawer','external')),
  ADD COLUMN IF NOT EXISTS paid_shift_id uuid,
  ADD COLUMN IF NOT EXISTS paid_currency text,
  ADD COLUMN IF NOT EXISTS paid_currency_amount numeric(18,4),
  ADD COLUMN IF NOT EXISTS paid_rate numeric(18,8);

ALTER TABLE public.shift_transactions DROP CONSTRAINT IF EXISTS shift_transactions_type_check;
ALTER TABLE public.shift_transactions ADD CONSTRAINT shift_transactions_type_check CHECK (type IN (
  'sale','deposit','deposit_capital','deposit_revenue','deposit_purchase_cover','debt_payment','expense','expense_refund',
  'refund','writeoff','withdrawal','surplus','shortage','transfer_in','transfer_out','fx_in','fx_out','supplier_payment','supplier_refund','store_credit_refund'));

DO $$
DECLARE _oid oid; _def text;
BEGIN
  SELECT oid INTO _oid FROM pg_proc WHERE proname='close_cash_shift_atomic' AND pronamespace='public'::regnamespace;
  _def := pg_get_functiondef(_oid);
  IF position('''expense_refund''' IN _def) = 0 OR position('''expense'',''refund'',''withdrawal''' IN _def) = 0 THEN RAISE EXCEPTION 'close anchors mismatch'; END IF;
  _def := replace(_def, '''expense_refund''', '''expense_refund'',''supplier_refund''');
  _def := replace(_def, '''expense'',''refund'',''withdrawal''', '''expense'',''refund'',''withdrawal'',''supplier_payment''');
  EXECUTE _def;
END $$;

CREATE OR REPLACE FUNCTION public._supplier_drawer_tx(_owner uuid, _shift uuid, _type text, _amount numeric, _ccy text, _ccy_amount numeric, _rate numeric, _ref text, _note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM 1 FROM public.cash_shifts WHERE id=_shift AND user_id=_owner AND closed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'لا توجد وردية مفتوحة لتسجيل الحركة من الصندوق'; END IF;
  INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,reference_id,notes,currency,currency_amount,exchange_rate)
  VALUES (_shift,_owner,_type,round(_amount,4),_ref,_note,COALESCE(_ccy,'USD'),COALESCE(_ccy_amount,_amount),_rate);
END $$;
REVOKE ALL ON FUNCTION public._supplier_drawer_tx(uuid,uuid,text,numeric,text,numeric,numeric,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._supplier_drawer_tx(uuid,uuid,text,numeric,text,numeric,numeric,text,text) TO service_role;

DROP FUNCTION IF EXISTS public.pay_supplier_atomic(uuid,numeric,text,text,text);
CREATE OR REPLACE FUNCTION public.pay_supplier_atomic(_supplier_id uuid, _amount numeric, _method text, _note text, _operation_id text,
  _source text DEFAULT 'external', _shift_id uuid DEFAULT NULL, _currency text DEFAULT 'USD', _currency_amount numeric DEFAULT NULL, _rate numeric DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _o uuid := public._supplier_owner(); _id uuid;
BEGIN
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  IF COALESCE(_operation_id,'') = '' THEN RAISE EXCEPTION 'معرّف العملية مطلوب'; END IF;
  IF _source NOT IN ('drawer','external') THEN RAISE EXCEPTION 'مصدر الدفع غير صالح'; END IF;
  IF _source = 'drawer' AND _shift_id IS NULL THEN RAISE EXCEPTION 'الدفع من الصندوق يتطلب وردية مفتوحة'; END IF;
  PERFORM 1 FROM public.suppliers WHERE id=_supplier_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'المورد غير موجود'; END IF;
  SELECT id INTO _id FROM public.supplier_ledger_entries WHERE user_id=_o AND operation_id=_operation_id AND entry_type='payment';
  IF _id IS NOT NULL THEN RETURN _id; END IF;
  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'دفعة لمورد');
  IF _amount > COALESCE((SELECT SUM(amount) FROM public.supplier_ledger_entries WHERE supplier_id=_supplier_id),0) + 0.0001 THEN
    RAISE EXCEPTION 'الدفعة أكبر من المستحق للمورد';
  END IF;
  IF _source = 'drawer' THEN
    PERFORM public._supplier_drawer_tx(_o,_shift_id,'supplier_payment',_amount,_currency,_currency_amount,_rate,_operation_id,'دفعة مورد من الصندوق');
  END IF;
  INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,payment_method,payment_source,shift_id,note,operation_id,created_by)
  VALUES (_o,_supplier_id,'payment',-round(_amount,4),'supplier_payment',_method,_source,CASE WHEN _source='drawer' THEN _shift_id END,_note,_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END $$;

CREATE OR REPLACE FUNCTION public.supplier_refund_atomic(_supplier_id uuid, _amount numeric, _method text, _note text, _operation_id text,
  _source text DEFAULT 'external', _shift_id uuid DEFAULT NULL, _currency text DEFAULT 'USD', _currency_amount numeric DEFAULT NULL, _rate numeric DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _o uuid := public._supplier_owner(); _id uuid; _bal numeric;
BEGIN
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  IF COALESCE(_operation_id,'') = '' THEN RAISE EXCEPTION 'معرّف العملية مطلوب'; END IF;
  IF _source NOT IN ('drawer','external') THEN RAISE EXCEPTION 'جهة الاستلام غير صالحة'; END IF;
  IF _source = 'drawer' AND _shift_id IS NULL THEN RAISE EXCEPTION 'الاستلام في الصندوق يتطلب وردية مفتوحة'; END IF;
  PERFORM 1 FROM public.suppliers WHERE id=_supplier_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'المورد غير موجود'; END IF;
  SELECT id INTO _id FROM public.supplier_ledger_entries WHERE user_id=_o AND operation_id=_operation_id AND entry_type='refund';
  IF _id IS NOT NULL THEN RETURN _id; END IF;
  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'استرداد من مورد');
  SELECT COALESCE(SUM(amount),0) INTO _bal FROM public.supplier_ledger_entries WHERE supplier_id=_supplier_id;
  IF _amount > -_bal + 0.0001 THEN RAISE EXCEPTION 'الاسترداد أكبر من الرصيد الدائن لنا عند المورد (%)', round(-_bal,2); END IF;
  IF _source = 'drawer' THEN
    PERFORM public._supplier_drawer_tx(_o,_shift_id,'supplier_refund',_amount,_currency,_currency_amount,_rate,_operation_id,'استرداد من مورد إلى الصندوق');
  END IF;
  INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,payment_method,payment_source,shift_id,note,operation_id,created_by)
  VALUES (_o,_supplier_id,'refund',round(_amount,4),'supplier_refund',_method,_source,CASE WHEN _source='drawer' THEN _shift_id END,_note,_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END $$;

-- finalize_purchase_invoice_atomic: supplier ledger + drawer transaction are patched in (see live function body).
-- Supplier backfill from free-text names:
INSERT INTO public.suppliers(user_id,name,company)
SELECT DISTINCT ON (user_id, lower(trim(supplier_name))) user_id, trim(supplier_name), NULLIF(trim(supplier_company),'')
  FROM public.purchase_invoices WHERE COALESCE(trim(supplier_name),'') <> ''
ON CONFLICT DO NOTHING;
UPDATE public.purchase_invoices i SET supplier_id = s.id
  FROM public.suppliers s WHERE i.supplier_id IS NULL AND s.user_id = i.user_id AND lower(s.name) = lower(trim(i.supplier_name));

DO $$ DECLARE f text; BEGIN
 FOREACH f IN ARRAY ARRAY['pay_supplier_atomic(uuid,numeric,text,text,text,text,uuid,text,numeric,numeric)','supplier_refund_atomic(uuid,numeric,text,text,text,text,uuid,text,numeric,numeric)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', f);
 END LOOP; END $$;
