-- Rollback for phase 6b (does not delete ledger rows with refund type; remove them first if any exist).
DROP FUNCTION IF EXISTS public.supplier_refund_atomic(uuid,numeric,text,text,text,text,uuid,text,numeric,numeric);
DROP FUNCTION IF EXISTS public.pay_supplier_atomic(uuid,numeric,text,text,text,text,uuid,text,numeric,numeric);
DROP FUNCTION IF EXISTS public._supplier_drawer_tx(uuid,uuid,text,numeric,text,numeric,numeric,text,text);
-- Restore the original 5-arg payment function (ledger-only, no shift link):
CREATE OR REPLACE FUNCTION public.pay_supplier_atomic(_supplier_id uuid, _amount numeric, _method text, _note text, _operation_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _o uuid := public._supplier_owner(); _id uuid;
BEGIN
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  PERFORM 1 FROM public.suppliers WHERE id=_supplier_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'المورد غير موجود'; END IF;
  SELECT id INTO _id FROM public.supplier_ledger_entries WHERE user_id=_o AND operation_id=_operation_id AND entry_type='payment';
  IF _id IS NOT NULL THEN RETURN _id; END IF;
  INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,payment_method,note,operation_id,created_by)
  VALUES (_o,_supplier_id,'payment',-round(_amount,4),'supplier_payment',_method,_note,_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END $$;
GRANT EXECUTE ON FUNCTION public.pay_supplier_atomic(uuid,numeric,text,text,text) TO authenticated, service_role;
-- finalize_purchase_invoice_atomic / close_cash_shift_atomic: re-apply the previous bodies from 20261120060000 and 20261120050000.
-- Columns paid_from/paid_shift_id/payment_source/shift_id are left in place (nullable, harmless).
