-- ROLLBACK لمرحلتي 1 و 2 (20261120030000_posflow_phase1_2_critical_fixes.sql)
-- تنبيه: الديون الملغاة (status='cancelled') تبقى كما هي؛ لا تُعاد صفوف محذوفة لأنها لم تعد تُحذف.
CREATE OR REPLACE FUNCTION pg_temp.posflow_patch(_fname text, _olds text[], _news text[])
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE _oid oid; _def text; i int; _cnt int;
BEGIN
  SELECT p.oid INTO _oid FROM pg_proc p WHERE p.proname=_fname AND p.pronamespace='public'::regnamespace;
  _def := pg_get_functiondef(_oid);
  FOR i IN 1..array_length(_olds,1) LOOP
    _cnt := (length(_def) - length(replace(_def,_olds[i],''))) / length(_olds[i]);
    IF _cnt <> 1 THEN RAISE EXCEPTION 'anchor % in % matched % times', i, _fname, _cnt; END IF;
    _def := replace(_def, _olds[i], _news[i]);
  END LOOP;
  EXECUTE _def;
END $f$;

SELECT pg_temp.posflow_patch('recalc_pos_invoice_profit',
 ARRAY['THEN (CASE WHEN COALESCE(p.bulk_cost_price,0) > 0 AND COALESCE(p.cost_price,0) > 0 THEN p.bulk_cost_price / p.cost_price ELSE GREATEST(COALESCE(ii.conversion_factor, 1), 1) END)'],
 ARRAY['THEN GREATEST(COALESCE(ii.conversion_factor, 1), 1)']);
SELECT pg_temp.posflow_patch('close_accounting_period_atomic',
 ARRAY[chr(13)||chr(10)||'  END IF;'||chr(13)||chr(10)||'  IF _period_end >= (now() AT TIME ZONE _tz)::date THEN'||chr(13)||chr(10)||'    RAISE EXCEPTION ''لا يمكن إقفال فترة لم تنتهِ بعد'';'],
 ARRAY['']);
SELECT pg_temp.posflow_patch('add_expense_atomic',
 ARRAY['PERFORM public.assert_period_open(_owner, COALESCE(_date, CURRENT_DATE), ''تسجيل مصروف'');'||chr(13)||chr(10)||'  '],
 ARRAY['']);
SELECT pg_temp.posflow_patch('process_pos_sale_atomic',
 ARRAY['PERFORM public.assert_period_open(_owner, CURRENT_DATE, ''إنشاء فاتورة بيع'');'||chr(13)||chr(10)||'  ','invoice_id, customer_id, customer_name','_new_invoice.invoice_number, _cust, COALESCE'],
 ARRAY['','invoice_id, customer_name','_new_invoice.invoice_number, COALESCE']);
SELECT pg_temp.posflow_patch('refund_invoice_partial_atomic',
 ARRAY[' debt_paid=CASE WHEN payment_type=''debt'' THEN GREATEST(round(COALESCE(debt_paid,0)-_cash,8),0) ELSE debt_paid END,',
  'UPDATE public.debts SET status=''cancelled'', remaining_debt=0, notes=concat_ws(E''\n'',NULLIF(notes,''''),''ملغى بسبب مرتجع كامل ''||now()::text), updated_at=now() WHERE user_id=_owner AND (invoice_id=_inv.invoice_number OR invoice_id=_inv.id::text);',
  'ELSIF _debt_red > 0 OR _cash > 0 THEN',
  'total_debt=GREATEST(round(COALESCE(total_debt,0)-_refund,8),0), total_paid=GREATEST(round(COALESCE(total_paid,0)-_cash,8),0),',
  chr(13)||chr(10)||'    PERFORM public.recalc_customer_open_debt(_owner, _inv.customer_id);'],
 ARRAY['','DELETE FROM public.debts WHERE user_id=_owner AND (invoice_id=_inv.invoice_number OR invoice_id=_inv.id::text);','ELSIF _debt_red > 0 THEN','total_debt=GREATEST(round(COALESCE(total_debt,0)-_debt_red,8),0),','']);
SELECT pg_temp.posflow_patch('refund_invoice_atomic',
 ARRAY['UPDATE public.debts d SET status = ''cancelled'', remaining_debt = 0, notes = concat_ws(E''\n'', NULLIF(d.notes,''''), ''ملغى بسبب مرتجع الفاتورة ''||now()::text), updated_at = now() WHERE d.user_id = _owner AND (d.invoice_id = _invoice.invoice_number OR d.invoice_id = _invoice.id::text);',
  'IF _invoice.customer_id IS NOT NULL THEN PERFORM public.recalc_customer_open_debt(_owner, _invoice.customer_id); END IF;'||chr(13)||chr(10)||'  '],
 ARRAY['DELETE FROM public.debts d WHERE d.user_id = _owner AND (d.invoice_id = _invoice.invoice_number OR d.invoice_id = _invoice.id::text);','']);

DROP FUNCTION IF EXISTS public.record_stock_damage_atomic(uuid,uuid,numeric,numeric,text,text,boolean,text,text);
DROP FUNCTION IF EXISTS public.recalc_customer_open_debt(uuid,uuid);
DROP INDEX IF EXISTS public.idx_debts_customer_id;
ALTER TABLE public.debts DROP COLUMN IF EXISTS customer_id;
ALTER TABLE public.shift_transactions DROP CONSTRAINT IF EXISTS shift_transactions_type_check;
ALTER TABLE public.shift_transactions ADD CONSTRAINT shift_transactions_type_check CHECK (type IN
 ('sale','deposit_capital','deposit_revenue','deposit_purchase_cover','debt_payment','expense','refund','writeoff','withdrawal','surplus','shortage'));
-- stock_damages.quantity يبقى numeric(14,3) (توسيع آمن)
