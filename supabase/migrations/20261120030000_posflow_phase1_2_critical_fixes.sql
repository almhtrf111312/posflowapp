-- PosFlow — المرحلتان 1 و 2: إصلاحات SQL الحرجة (قاعدة PosFlow فقط)
-- (أ) shift_transactions_type_check  (ب) إلغاء الديون بدل حذفها + total_debt من الديون المفتوحة
-- (ج) debts.customer_id  (د) assert_period_open في البيع والمصاريف + إقفال الفترات المنتهية فقط
-- (هـ) record_stock_damage_atomic  (و) bulk_cost_price في recalc_pos_invoice_profit
-- التراجع: supabase/live-snapshots/rollbacks/ROLLBACK_stage_1_2.sql

-- أداة ترقيع آمنة: تفشل الهجرة كاملة إن لم يوجد المقطع بالضبط مرة واحدة
CREATE OR REPLACE FUNCTION pg_temp.posflow_patch(_fname text, _olds text[], _news text[])
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE _oid oid; _def text; i int; _cnt int;
BEGIN
  SELECT p.oid INTO _oid FROM pg_proc p WHERE p.proname=_fname AND p.pronamespace='public'::regnamespace;
  IF _oid IS NULL THEN RAISE EXCEPTION 'function % not found', _fname; END IF;
  _def := pg_get_functiondef(_oid);
  FOR i IN 1..array_length(_olds,1) LOOP
    _cnt := (length(_def) - length(replace(_def,_olds[i],''))) / length(_olds[i]);
    IF _cnt <> 1 THEN RAISE EXCEPTION 'patch anchor % in % matched % times: %', i, _fname, _cnt, _olds[i]; END IF;
    _def := replace(_def, _olds[i], _news[i]);
  END LOOP;
  EXECUTE _def;
END $f$;

-- (أ) قيد أنواع حركات الوردية
ALTER TABLE public.shift_transactions DROP CONSTRAINT IF EXISTS shift_transactions_type_check;
ALTER TABLE public.shift_transactions ADD CONSTRAINT shift_transactions_type_check CHECK (type IN (
  'sale','deposit','deposit_capital','deposit_revenue','deposit_purchase_cover','debt_payment','expense','expense_refund',
  'refund','writeoff','withdrawal','surplus','shortage','transfer_in','transfer_out','fx_in','fx_out','supplier_payment','store_credit_refund'));

-- (ج) debts.customer_id + ترحيل البيانات
ALTER TABLE public.debts ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_debts_customer_id ON public.debts(customer_id) WHERE customer_id IS NOT NULL;
UPDATE public.debts d SET customer_id = i.customer_id
  FROM public.invoices i
 WHERE d.customer_id IS NULL AND i.customer_id IS NOT NULL AND i.user_id = d.user_id
   AND (d.invoice_id = i.invoice_number OR d.invoice_id = i.id::text);
UPDATE public.debts d SET customer_id = c.id
  FROM public.customers c
 WHERE d.customer_id IS NULL AND c.user_id = d.user_id AND c.name = d.customer_name
   AND (SELECT count(*) FROM public.customers c2 WHERE c2.user_id = d.user_id AND c2.name = d.customer_name) = 1;

-- (ب) إعادة احتساب دين العميل من الديون المفتوحة (تشمل الديون النقدية)
CREATE OR REPLACE FUNCTION public.recalc_customer_open_debt(_owner uuid, _customer uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.customers c SET total_debt = COALESCE((
      SELECT SUM(d.remaining_debt) FROM public.debts d
       WHERE d.user_id = _owner
         AND COALESCE(d.status,'') NOT IN ('fully_paid','written_off','cancelled')
         AND (d.customer_id = c.id OR (d.customer_id IS NULL AND d.customer_name = c.name))
    ), 0), updated_at = now()
  WHERE c.id = _customer AND c.user_id = _owner;
$$;
REVOKE ALL ON FUNCTION public.recalc_customer_open_debt(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recalc_customer_open_debt(uuid,uuid) TO service_role;

-- (ب) refund_invoice_atomic: إلغاء الدين بدل حذفه
SELECT pg_temp.posflow_patch('refund_invoice_atomic',
 ARRAY[
  'DELETE FROM public.debts d WHERE d.user_id = _owner AND (d.invoice_id = _invoice.invoice_number OR d.invoice_id = _invoice.id::text);',
  'UPDATE public.invoice_items ii SET profit = 0 WHERE ii.invoice_id = _invoice.id;'
 ],
 ARRAY[
  'UPDATE public.debts d SET status = ''cancelled'', remaining_debt = 0, notes = concat_ws(E''\n'', NULLIF(d.notes,''''), ''ملغى بسبب مرتجع الفاتورة ''||now()::text), updated_at = now() WHERE d.user_id = _owner AND (d.invoice_id = _invoice.invoice_number OR d.invoice_id = _invoice.id::text);',
  'IF _invoice.customer_id IS NOT NULL THEN PERFORM public.recalc_customer_open_debt(_owner, _invoice.customer_id); END IF;'||chr(13)||chr(10)||'  UPDATE public.invoice_items ii SET profit = 0 WHERE ii.invoice_id = _invoice.id;'
 ]);

-- (ب) المرتجع الجزئي: debt_paid/total_paid + إلغاء بدل حذف + دين العميل
SELECT pg_temp.posflow_patch('refund_invoice_partial_atomic',
 ARRAY[
  'debt_remaining=_new_debt,',
  'DELETE FROM public.debts WHERE user_id=_owner AND (invoice_id=_inv.invoice_number OR invoice_id=_inv.id::text);',
  'ELSIF _debt_red > 0 THEN',
  'total_debt=GREATEST(round(COALESCE(total_debt,0)-_debt_red,8),0),',
  '    WHERE c.id=_inv.customer_id AND c.user_id=_owner;'||chr(13)||chr(10)||'  END IF;'
 ],
 ARRAY[
  'debt_remaining=_new_debt, debt_paid=CASE WHEN payment_type=''debt'' THEN GREATEST(round(COALESCE(debt_paid,0)-_cash,8),0) ELSE debt_paid END,',
  'UPDATE public.debts SET status=''cancelled'', remaining_debt=0, notes=concat_ws(E''\n'',NULLIF(notes,''''),''ملغى بسبب مرتجع كامل ''||now()::text), updated_at=now() WHERE user_id=_owner AND (invoice_id=_inv.invoice_number OR invoice_id=_inv.id::text);',
  'ELSIF _debt_red > 0 OR _cash > 0 THEN',
  'total_debt=GREATEST(round(COALESCE(total_debt,0)-_refund,8),0), total_paid=GREATEST(round(COALESCE(total_paid,0)-_cash,8),0),',
  '    WHERE c.id=_inv.customer_id AND c.user_id=_owner;'||chr(13)||chr(10)||'    PERFORM public.recalc_customer_open_debt(_owner, _inv.customer_id);'||chr(13)||chr(10)||'  END IF;'
 ]);

-- (ج)+(د) process_pos_sale_atomic
SELECT pg_temp.posflow_patch('process_pos_sale_atomic',
 ARRAY[
  '_number := to_char(CURRENT_DATE, ''YYYYMMDD'')',
  'user_id, invoice_id, customer_name, customer_phone, total_debt,',
  '_owner, _new_invoice.invoice_number, COALESCE(_cname, ''عميل بيع مؤجل''),'
 ],
 ARRAY[
  'PERFORM public.assert_period_open(_owner, CURRENT_DATE, ''إنشاء فاتورة بيع'');'||chr(13)||chr(10)||'  _number := to_char(CURRENT_DATE, ''YYYYMMDD'')',
  'user_id, invoice_id, customer_id, customer_name, customer_phone, total_debt,',
  '_owner, _new_invoice.invoice_number, _cust, COALESCE(_cname, ''عميل بيع مؤجل''),'
 ]);

-- (د) المصاريف
SELECT pg_temp.posflow_patch('add_expense_atomic',
 ARRAY['-- تحويل المعرف إلى UUID بأمان'],
 ARRAY['PERFORM public.assert_period_open(_owner, COALESCE(_date, CURRENT_DATE), ''تسجيل مصروف'');'||chr(13)||chr(10)||'  -- تحويل المعرف إلى UUID بأمان']);

-- (د) لا يُقفل إلا فترة منتهية
SELECT pg_temp.posflow_patch('close_accounting_period_atomic',
 ARRAY['RAISE EXCEPTION ''تواريخ الفترة غير صحيحة'';'],
 ARRAY['RAISE EXCEPTION ''تواريخ الفترة غير صحيحة'';'||chr(13)||chr(10)||'  END IF;'||chr(13)||chr(10)||'  IF _period_end >= (now() AT TIME ZONE _tz)::date THEN'||chr(13)||chr(10)||'    RAISE EXCEPTION ''لا يمكن إقفال فترة لم تنتهِ بعد'';']);

-- (و) تكلفة الكرتونة الفعلية
SELECT pg_temp.posflow_patch('recalc_pos_invoice_profit',
 ARRAY['WHEN COALESCE(ii.unit, ''piece'') = ''bulk'' THEN GREATEST(COALESCE(ii.conversion_factor, 1), 1)'],
 ARRAY['WHEN COALESCE(ii.unit, ''piece'') = ''bulk'' THEN (CASE WHEN COALESCE(p.bulk_cost_price,0) > 0 AND COALESCE(p.cost_price,0) > 0 THEN p.bulk_cost_price / p.cost_price ELSE GREATEST(COALESCE(ii.conversion_factor, 1), 1) END)']);

-- (هـ) التالف الذري
ALTER TABLE public.stock_damages ALTER COLUMN quantity TYPE numeric(14,3);

CREATE OR REPLACE FUNCTION public.record_stock_damage_atomic(
  _product_id uuid, _warehouse_id uuid, _quantity numeric, _unit_cost numeric DEFAULT NULL,
  _reason text DEFAULT NULL, _notes text DEFAULT NULL, _apply_to_stock boolean DEFAULT true,
  _source text DEFAULT 'manual', _source_ref text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _caller uuid := auth.uid(); _owner uuid; _p record; _cost numeric; _id uuid; _name text;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN RAISE EXCEPTION 'owner not found'; END IF;
  IF COALESCE(_quantity,0) <= 0 THEN RAISE EXCEPTION 'الكمية يجب أن تكون أكبر من الصفر'; END IF;
  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'تسجيل تالف');
  SELECT id, name, quantity, cost_price INTO _p FROM public.products WHERE id=_product_id AND user_id=_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'المنتج غير موجود'; END IF;
  _cost := COALESCE(_unit_cost, _p.cost_price, 0);
  IF COALESCE(_apply_to_stock,true) THEN
    IF COALESCE(_p.quantity,0) < _quantity THEN RAISE EXCEPTION 'الكمية التالفة أكبر من المخزون المتاح'; END IF;
    PERFORM set_config('app.stock_movement_type','damage',true);
    PERFORM set_config('app.stock_actor_id',_caller::text,true);
    PERFORM set_config('app.stock_source','record_stock_damage_atomic',true);
    UPDATE public.products SET quantity = round(quantity - _quantity,3), updated_at=now() WHERE id=_product_id;
  END IF;
  SELECT COALESCE(full_name,'مستخدم') INTO _name FROM public.profiles WHERE user_id=_caller;
  INSERT INTO public.stock_damages(user_id, product_id, product_name, warehouse_id, quantity, unit_cost, cost_value,
      reason, notes, damaged_at, recorded_by, recorded_by_name, source, source_ref)
  VALUES (_owner, _product_id, _p.name, _warehouse_id, _quantity, _cost, round(_quantity*_cost,8),
      _reason, _notes, now(), _caller, COALESCE(_name,'مستخدم'), COALESCE(_source,'manual'), _source_ref)
  RETURNING id INTO _id;
  RETURN _id;
END $$;
REVOKE ALL ON FUNCTION public.record_stock_damage_atomic(uuid,uuid,numeric,numeric,text,text,boolean,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_stock_damage_atomic(uuid,uuid,numeric,numeric,text,text,boolean,text,text) TO authenticated, service_role;

-- تحقق للقراءة فقط
SELECT
  (SELECT pg_get_constraintdef(oid) LIKE '%expense_refund%' FROM pg_constraint WHERE conname='shift_transactions_type_check') AS check_shift_type,
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='debts' AND column_name='customer_id') AS check_debts_customer_id,
  (SELECT pg_get_functiondef('public.process_pos_sale_atomic'::regproc) LIKE '%assert_period_open%') AS check_sale_period,
  (SELECT pg_get_functiondef('public.add_expense_atomic'::regproc) LIKE '%assert_period_open%') AS check_expense_period,
  (SELECT pg_get_functiondef('public.refund_invoice_atomic'::regproc) NOT LIKE '%DELETE FROM public.debts%') AS check_no_debt_delete,
  EXISTS(SELECT 1 FROM pg_proc WHERE proname='record_stock_damage_atomic') AS check_damage_fn;
