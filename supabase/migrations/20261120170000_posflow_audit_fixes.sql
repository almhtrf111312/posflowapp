-- PosFlow audit fixes (phase 1-9): partner pending release, purchase cancel/edit, damage per warehouse,
-- supplier drawer fallback, surplus setting column, indexes.
CREATE OR REPLACE FUNCTION public.release_pending_partner_profits_for_invoice(_invoice_id uuid)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE _inv public.invoices%ROWTYPE; _p record; _sum numeric; _tot numeric := 0; _keep jsonb; _it jsonb;
BEGIN
  PERFORM set_config('app.partner_source','release_pending_partner_profits_for_invoice',true);
  SELECT * INTO _inv FROM public.invoices WHERE id=_invoice_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  FOR _p IN SELECT * FROM public.partners WHERE user_id=_inv.user_id AND pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId',_inv.invoice_number)) FOR UPDATE LOOP
    _sum := 0; _keep := '[]'::jsonb;
    FOR _it IN SELECT * FROM jsonb_array_elements(COALESCE(_p.pending_profit_details,'[]'::jsonb)) LOOP
      IF _it->>'invoiceId' = _inv.invoice_number THEN _sum := _sum + COALESCE((_it->>'amount')::numeric,0); ELSE _keep := _keep || _it; END IF;
    END LOOP;
    IF _sum <> 0 THEN
      UPDATE public.partners SET
        pending_profit = round(COALESCE(pending_profit,0)-_sum,4), confirmed_profit = round(COALESCE(confirmed_profit,0)+_sum,4),
        current_balance = round(COALESCE(current_balance,0)+_sum,4), total_profit_earned = round(COALESCE(total_profit_earned,0)+_sum,4),
        pending_profit_details = _keep,
        profit_history = COALESCE(profit_history,'[]'::jsonb) || jsonb_build_object('id',extract(epoch from now())::text||_p.id::text||'-rel','invoiceId',_inv.invoice_number,'amount',round(_sum,8),'category','تحرير دفعة دين','isRelease',true,'createdAt',now()),
        updated_at = now() WHERE id=_p.id;
      _tot := _tot + _sum;
    END IF;
  END LOOP;
  RETURN _tot;
END $f$;
REVOKE ALL ON FUNCTION public.release_pending_partner_profits_for_invoice(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._supplier_drawer_tx(_owner uuid, _shift uuid, _type text, _amount numeric, _ccy text, _ccy_amount numeric, _rate numeric, _ref text, _note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE _s uuid := _shift;
BEGIN
  PERFORM 1 FROM public.cash_shifts WHERE id=_s AND user_id=_owner AND closed_at IS NULL;
  IF NOT FOUND THEN
    SELECT id INTO _s FROM public.cash_shifts WHERE user_id=_owner AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1;
    IF _s IS NULL THEN RETURN; END IF;
  END IF;
  INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,reference_id,notes,currency,currency_amount,exchange_rate)
  VALUES (_s,_owner,_type,round(_amount,4),_ref,_note,COALESCE(_ccy,'USD'),COALESCE(_ccy_amount,_amount),_rate)
  ON CONFLICT DO NOTHING;
END $f$;

DO $m$
DECLARE _def text; _new text;
BEGIN
  -- refund: release leftover pending once the invoice is fully paid
  SELECT replace(pg_get_functiondef(p.oid),E'\r','') INTO _def FROM pg_proc p WHERE p.proname='refund_invoice_partial_atomic' AND p.pronamespace='public'::regnamespace;
  _new := replace(_def,
    E'    PERFORM public.revert_invoice_partner_profits_atomic(_inv.id, _profit_ratio);\n  END IF;\n',
    E'    PERFORM public.revert_invoice_partner_profits_atomic(_inv.id, _profit_ratio);\n  END IF;\n  IF _inv.payment_type=''debt'' AND NOT _full AND _new_debt<=0 THEN\n    PERFORM public.release_pending_partner_profits_for_invoice(_inv.id);\n  END IF;\n');
  IF _new = _def THEN RAISE EXCEPTION 'patch refund failed'; END IF;
  EXECUTE _new;

  -- cancel purchase: reverse drawer cash + serials
  SELECT replace(pg_get_functiondef(p.oid),E'\r','') INTO _def FROM pg_proc p WHERE p.proname='cancel_purchase_invoice_atomic' AND p.pronamespace='public'::regnamespace;
  _new := replace(_def,
    E'  -- 3) وسم الفاتورة كملغاة مع توثيق السبب\n',
    E'  IF COALESCE(_orig_inv.amount_paid,0) > 0 AND _orig_inv.paid_from = ''drawer'' THEN\n    DECLARE _t record;\n    BEGIN\n      SELECT currency, currency_amount, exchange_rate INTO _t FROM public.shift_transactions WHERE reference_id = ''purchase:''||_invoice_id::text AND type = ''supplier_payment'' LIMIT 1;\n      PERFORM public._supplier_drawer_tx(_owner, _orig_inv.paid_shift_id, ''supplier_refund'', _orig_inv.amount_paid, _t.currency, _t.currency_amount, _t.exchange_rate, ''purchase_cancel:''||_invoice_id::text, ''إلغاء فاتورة شراء ''||COALESCE(_orig_inv.invoice_number,''''));\n    END;\n  END IF;\n  IF EXISTS (SELECT 1 FROM public.product_serials WHERE purchase_invoice_id=_invoice_id AND user_id=_owner AND status <> ''in_stock'') THEN RAISE EXCEPTION ''لا يمكن إلغاء الفاتورة: بعض أرقامها التسلسلية بيعت أو أُخرجت''; END IF;\n  UPDATE public.product_serials SET status=''returned_to_supplier'', updated_at=now() WHERE purchase_invoice_id=_invoice_id AND user_id=_owner AND status=''in_stock'';\n  -- 3) وسم الفاتورة كملغاة مع توثيق السبب\n');
  IF _new = _def THEN RAISE EXCEPTION 'patch cancel failed'; END IF;
  EXECUTE _new;

  -- edit purchase: keep original date and the supplier credit
  SELECT replace(pg_get_functiondef(p.oid),E'\r','') INTO _def FROM pg_proc p WHERE p.proname='edit_purchase_invoice_atomic' AND p.pronamespace='public'::regnamespace;
  _new := replace(replace(replace(_def,
    '_orig_inv.supplier_company, now(), COALESCE(', '_orig_inv.supplier_company, _orig_inv.invoice_date, COALESCE('),
    'IF LEAST(COALESCE(_orig_inv.amount_paid,0),_grand_total) > 0 THEN', 'IF COALESCE(_orig_inv.amount_paid,0) > 0 THEN'),
    '-round(LEAST(_orig_inv.amount_paid,_grand_total),4)', '-round(_orig_inv.amount_paid,4)');
  IF _new = _def THEN RAISE EXCEPTION 'patch edit failed'; END IF;
  EXECUTE _new;

  -- damage: deduct from warehouse_stock as well
  SELECT replace(pg_get_functiondef(p.oid),E'\r','') INTO _def FROM pg_proc p WHERE p.proname='record_stock_damage_atomic' AND p.pronamespace='public'::regnamespace;
  _new := replace(_def,
    E'UPDATE public.products SET quantity = round(quantity - _quantity,3), updated_at=now() WHERE id=_product_id;\n',
    E'UPDATE public.products SET quantity = round(quantity - _quantity,3), updated_at=now() WHERE id=_product_id;\n    IF _warehouse_id IS NOT NULL THEN\n      UPDATE public.warehouse_stock SET quantity = GREATEST(round(quantity - _quantity,3),0), last_updated=now() WHERE warehouse_id=_warehouse_id AND product_id=_product_id;\n    END IF;\n');
  IF _new = _def THEN RAISE EXCEPTION 'patch damage failed'; END IF;
  EXECUTE _new;
END $m$;

ALTER TABLE public.store_settings ADD COLUMN IF NOT EXISTS surplus_as_profit boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_invoices_user_date ON public.invoices (user_id, date);
CREATE INDEX IF NOT EXISTS idx_debts_user_invoice ON public.debts (user_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_shift_tx_shift_ccy ON public.shift_transactions (shift_id, currency);
DROP INDEX IF EXISTS public.idx_shift_tx_shift;
