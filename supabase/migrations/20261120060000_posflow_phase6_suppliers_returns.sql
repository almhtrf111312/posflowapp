-- المرحلة 6: الموردون + دفتر ذمم الموردين + مرتجع المشتريات. التراجع: ROLLBACK_stage_6.sql
CREATE TABLE IF NOT EXISTS public.suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  company text, phone text, notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_name ON public.suppliers(user_id, lower(name));

CREATE TABLE IF NOT EXISTS public.supplier_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  entry_type text NOT NULL CHECK (entry_type IN ('purchase','payment','purchase_return','adjustment')),
  amount numeric(18,4) NOT NULL CHECK (amount <> 0),   -- موجب = يزيد ما ندين به للمورد ، سالب = يخفضه
  reference_type text, reference_id text,
  payment_method text, note text, operation_id text,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_ledger_supplier ON public.supplier_ledger_entries(supplier_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_ledger_op ON public.supplier_ledger_entries(user_id, operation_id, entry_type) WHERE operation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.purchase_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES public.purchase_invoices(id) ON DELETE RESTRICT,
  supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  return_number text NOT NULL,
  total_amount numeric(18,4) NOT NULL,
  reason text, operation_id text, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, operation_id)
);
CREATE TABLE IF NOT EXISTS public.purchase_return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES public.purchase_returns(id) ON DELETE RESTRICT,
  invoice_item_id uuid NOT NULL REFERENCES public.purchase_invoice_items(id) ON DELETE RESTRICT,
  product_id uuid, product_name text,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_cost numeric(18,4) NOT NULL, total_cost numeric(18,4) NOT NULL
);

ALTER TABLE public.purchase_invoices
  ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS amount_paid numeric(18,4) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['suppliers','supplier_ledger_entries','purchase_returns','purchase_return_items'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon, authenticated', t);
 END LOOP; END $$;
DROP POLICY IF EXISTS "owner reads suppliers" ON public.suppliers;
CREATE POLICY "owner reads suppliers" ON public.suppliers FOR SELECT TO authenticated USING (user_id = public.get_owner_id(auth.uid()) AND public.is_store_owner(auth.uid()));
DROP POLICY IF EXISTS "owner reads supplier ledger" ON public.supplier_ledger_entries;
CREATE POLICY "owner reads supplier ledger" ON public.supplier_ledger_entries FOR SELECT TO authenticated USING (user_id = public.get_owner_id(auth.uid()) AND public.is_store_owner(auth.uid()));
DROP POLICY IF EXISTS "owner reads purchase returns" ON public.purchase_returns;
CREATE POLICY "owner reads purchase returns" ON public.purchase_returns FOR SELECT TO authenticated USING (user_id = public.get_owner_id(auth.uid()) AND public.is_store_owner(auth.uid()));
DROP POLICY IF EXISTS "owner reads purchase return items" ON public.purchase_return_items;
CREATE POLICY "owner reads purchase return items" ON public.purchase_return_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.purchase_returns r WHERE r.id = return_id AND r.user_id = public.get_owner_id(auth.uid()) AND public.is_store_owner(auth.uid())));

CREATE OR REPLACE VIEW public.supplier_balances WITH (security_invoker = true) AS
SELECT s.id, s.user_id, s.name, s.company, s.phone, s.is_active, round(COALESCE(SUM(l.amount),0),4) AS balance_due
  FROM public.suppliers s LEFT JOIN public.supplier_ledger_entries l ON l.supplier_id = s.id GROUP BY s.id;

CREATE OR REPLACE FUNCTION public._supplier_owner() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _c uuid := auth.uid();
BEGIN
  IF _c IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.is_store_owner(_c) THEN RAISE EXCEPTION 'إدارة الموردين لمالك المتجر ومديره فقط' USING ERRCODE='42501'; END IF;
  RETURN public.get_owner_id(_c);
END $$;
REVOKE ALL ON FUNCTION public._supplier_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._supplier_owner() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_supplier_atomic(_name text, _company text DEFAULT NULL, _phone text DEFAULT NULL, _notes text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _o uuid := public._supplier_owner(); _id uuid;
BEGIN
  IF COALESCE(trim(_name),'') = '' THEN RAISE EXCEPTION 'اسم المورد مطلوب'; END IF;
  SELECT id INTO _id FROM public.suppliers WHERE user_id=_o AND lower(name)=lower(trim(_name));
  IF _id IS NOT NULL THEN RETURN _id; END IF;
  INSERT INTO public.suppliers(user_id,name,company,phone,notes,created_by) VALUES (_o,trim(_name),_company,_phone,_notes,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END $$;

-- ربط فاتورة شراء بمورد وتسجيل ما علينا (المتبقي) في دفتر المورد
CREATE OR REPLACE FUNCTION public.link_purchase_to_supplier_atomic(_invoice_id uuid, _supplier_id uuid, _paid_amount numeric DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _o uuid := public._supplier_owner(); _inv record; _total numeric; _paid numeric := GREATEST(COALESCE(_paid_amount,0),0);
BEGIN
  SELECT * INTO _inv FROM public.purchase_invoices WHERE id=_invoice_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'فاتورة الشراء غير موجودة'; END IF;
  PERFORM 1 FROM public.suppliers WHERE id=_supplier_id AND user_id=_o AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'المورد غير موجود أو غير فعّال'; END IF;
  IF _inv.supplier_id IS NOT NULL THEN RETURN jsonb_build_object('success',true,'already_linked',true); END IF;
  IF COALESCE(_inv.payment_status,'') = 'cancelled' OR COALESCE(_inv.status,'') = 'cancelled' THEN RAISE EXCEPTION 'الفاتورة ملغاة'; END IF;
  PERFORM public.assert_period_open(_o, _inv.invoice_date::date, 'ربط فاتورة شراء بمورد');
  _total := COALESCE(_inv.actual_grand_total, _inv.expected_grand_total, 0);
  IF _total <= 0 THEN RAISE EXCEPTION 'إجمالي الفاتورة صفر'; END IF;
  IF _paid > _total THEN RAISE EXCEPTION 'المدفوع أكبر من إجمالي الفاتورة'; END IF;
  INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,reference_id,note,created_by)
  VALUES (_o,_supplier_id,'purchase',round(_total,4),'purchase_invoice',_invoice_id::text,'فاتورة شراء '||_inv.invoice_number,auth.uid());
  IF _paid > 0 THEN
    INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,reference_id,payment_method,note,created_by)
    VALUES (_o,_supplier_id,'payment',-round(_paid,4),'purchase_invoice',_invoice_id::text,_inv.payment_method,'دفعة عند الشراء '||_inv.invoice_number,auth.uid());
  END IF;
  UPDATE public.purchase_invoices SET supplier_id=_supplier_id, amount_paid=_paid, updated_at=now() WHERE id=_invoice_id;
  RETURN jsonb_build_object('success',true,'total',_total,'paid',_paid,'due',_total-_paid);
END $$;

CREATE OR REPLACE FUNCTION public.pay_supplier_atomic(_supplier_id uuid, _amount numeric, _method text, _note text, _operation_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _o uuid := public._supplier_owner(); _id uuid;
BEGIN
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  IF COALESCE(_operation_id,'') = '' THEN RAISE EXCEPTION 'معرّف العملية مطلوب'; END IF;
  PERFORM 1 FROM public.suppliers WHERE id=_supplier_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'المورد غير موجود'; END IF;
  SELECT id INTO _id FROM public.supplier_ledger_entries WHERE user_id=_o AND operation_id=_operation_id AND entry_type='payment';
  IF _id IS NOT NULL THEN RETURN _id; END IF;
  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'دفعة لمورد');
  IF _amount > COALESCE((SELECT SUM(amount) FROM public.supplier_ledger_entries WHERE supplier_id=_supplier_id),0) + 0.0001 THEN
    RAISE EXCEPTION 'الدفعة أكبر من المستحق للمورد';
  END IF;
  INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,payment_method,note,operation_id,created_by)
  VALUES (_o,_supplier_id,'payment',-round(_amount,4),'supplier_payment',_method,_note,_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END $$;

-- مرتجع مشتريات جزئي/كلي. _lines = [{"item_id":"uuid","quantity":n}]
CREATE OR REPLACE FUNCTION public.purchase_return_atomic(_invoice_id uuid, _lines jsonb, _reason text, _operation_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _o uuid := public._supplier_owner(); _inv record; _rid uuid; _l jsonb; _it record; _qty numeric; _returned numeric; _stock numeric;
  _total numeric := 0; _num text;
BEGIN
  IF COALESCE(_operation_id,'') = '' THEN RAISE EXCEPTION 'معرّف العملية مطلوب'; END IF;
  SELECT id INTO _rid FROM public.purchase_returns WHERE user_id=_o AND operation_id=_operation_id;
  IF _rid IS NOT NULL THEN RETURN _rid; END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN RAISE EXCEPTION 'لا توجد بنود للمرتجع'; END IF;
  SELECT * INTO _inv FROM public.purchase_invoices WHERE id=_invoice_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'فاتورة الشراء غير موجودة'; END IF;
  IF COALESCE(_inv.payment_status,'') = 'cancelled' OR COALESCE(_inv.status,'') = 'cancelled' THEN RAISE EXCEPTION 'الفاتورة ملغاة'; END IF;
  IF _inv.replaced_by IS NOT NULL THEN RAISE EXCEPTION 'الفاتورة استُبدلت بفاتورة معدّلة'; END IF;
  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'مرتجع مشتريات');
  _num := 'PR-' || to_char(now(),'YYYYMMDD') || '-' || substr(gen_random_uuid()::text,1,6);
  INSERT INTO public.purchase_returns(user_id,invoice_id,supplier_id,return_number,total_amount,reason,operation_id,created_by)
  VALUES (_o,_invoice_id,_inv.supplier_id,_num,0,_reason,_operation_id,auth.uid()) RETURNING id INTO _rid;
  PERFORM set_config('app.stock_movement_type','purchase_return',true);
  PERFORM set_config('app.stock_actor_id',auth.uid()::text,true);
  PERFORM set_config('app.stock_source','purchase_return_atomic',true);
  FOR _l IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _qty := (_l->>'quantity')::numeric;
    IF _qty IS NULL OR _qty <= 0 THEN RAISE EXCEPTION 'كمية غير صالحة'; END IF;
    SELECT * INTO _it FROM public.purchase_invoice_items WHERE id=(_l->>'item_id')::uuid AND invoice_id=_invoice_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'بند غير تابع للفاتورة'; END IF;
    SELECT COALESCE(SUM(quantity),0) INTO _returned FROM public.purchase_return_items WHERE invoice_item_id=_it.id;
    IF _returned + _qty > _it.quantity THEN RAISE EXCEPTION 'كمية المرتجع من "%" تتجاوز المشتراة (المتبقي %)', _it.product_name, _it.quantity - _returned; END IF;
    IF _it.product_id IS NOT NULL THEN
      SELECT quantity INTO _stock FROM public.products WHERE id=_it.product_id AND user_id=_o FOR UPDATE;
      IF FOUND THEN
        IF COALESCE(_stock,0) < _qty THEN RAISE EXCEPTION 'مخزون "%" أقل من كمية المرتجع (بيع جزء منه)', _it.product_name; END IF;
        UPDATE public.products SET quantity = round(quantity - _qty,3), updated_at=now() WHERE id=_it.product_id;
      END IF;
    END IF;
    INSERT INTO public.purchase_return_items(return_id,invoice_item_id,product_id,product_name,quantity,unit_cost,total_cost)
    VALUES (_rid,_it.id,_it.product_id,_it.product_name,_qty,COALESCE(_it.cost_price,0),round(_qty*COALESCE(_it.cost_price,0),4));
    _total := _total + round(_qty*COALESCE(_it.cost_price,0),4);
  END LOOP;
  UPDATE public.purchase_returns SET total_amount=_total WHERE id=_rid;
  IF _inv.supplier_id IS NOT NULL AND _total > 0 THEN
    INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,reference_id,note,operation_id,created_by)
    VALUES (_o,_inv.supplier_id,'purchase_return',-_total,'purchase_return',_rid::text,'مرتجع '||_num||' للفاتورة '||_inv.invoice_number,_operation_id,auth.uid());
  END IF;
  RETURN _rid;
END $$;

-- إلغاء فاتورة الشراء: منع النزول تحت الصفر + منع الإلغاء بعد وجود مرتجع + عكس قيود المورد
DO $$
DECLARE _oid oid; _def text; _a2 text := '-- 3) وسم الفاتورة كملغاة مع توثيق السبب'; _a3 text := '_new_stock := GREATEST(0, COALESCE(_cur_stock, 0) - COALESCE(_old_item.quantity, 0));';
BEGIN
  SELECT oid INTO _oid FROM pg_proc WHERE proname='cancel_purchase_invoice_atomic' AND pronamespace='public'::regnamespace;
  _def := pg_get_functiondef(_oid);
  IF (length(_def)-length(replace(_def,_a2,'')))/length(_a2) <> 1 OR (length(_def)-length(replace(_def,_a3,'')))/length(_a3) <> 1 THEN RAISE EXCEPTION 'cancel anchors mismatch'; END IF;
  _def := replace(_def,_a3,'IF COALESCE(_cur_stock,0) < COALESCE(_old_item.quantity,0) THEN RAISE EXCEPTION ''لا يمكن إلغاء الفاتورة: جزء من كمية "%" بيع أو أُخرج من المخزون'', _old_item.product_name; END IF;'||chr(13)||chr(10)||'        _new_stock := COALESCE(_cur_stock, 0) - COALESCE(_old_item.quantity, 0);');
  _def := replace(_def,_a2,'IF EXISTS (SELECT 1 FROM public.purchase_returns WHERE invoice_id = _invoice_id) THEN RAISE EXCEPTION ''لا يمكن إلغاء فاتورة لها مرتجعات''; END IF;'||chr(13)||chr(10)||'  INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,reference_id,note,created_by)'||chr(13)||chr(10)||'  SELECT user_id,supplier_id,''adjustment'',-amount,''purchase_cancel'',reference_id,''عكس بسبب إلغاء الفاتورة'',_caller FROM public.supplier_ledger_entries WHERE reference_type=''purchase_invoice'' AND reference_id=_invoice_id::text AND entry_type IN (''purchase'',''payment'');'||chr(13)||chr(10)||'  '||_a2);
  EXECUTE _def;
END $$;


-- تعديل فاتورة الشراء: منع التعديل بعد مرتجع + نقل ذمة المورد للفاتورة الجديدة
DO $$
DECLARE _oid oid; _def text; _a text := 'UPDATE public.purchase_invoices SET payment_status=''cancelled'', replaced_by=_new_invoice_id'; _crlf text := chr(13)||chr(10);
BEGIN
  SELECT oid INTO _oid FROM pg_proc WHERE proname='edit_purchase_invoice_atomic' AND pronamespace='public'::regnamespace;
  _def := pg_get_functiondef(_oid);
  IF (length(_def)-length(replace(_def,_a,'')))/length(_a) <> 1 THEN RAISE EXCEPTION 'edit anchor mismatch'; END IF;
  _def := replace(_def,_a,
    'IF EXISTS (SELECT 1 FROM public.purchase_returns WHERE invoice_id = _invoice_id) THEN RAISE EXCEPTION ''لا يمكن تعديل فاتورة لها مرتجعات''; END IF;'||_crlf||
    '  IF _orig_inv.supplier_id IS NOT NULL THEN'||_crlf||
    '    INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,reference_id,note,created_by)'||_crlf||
    '    SELECT user_id,supplier_id,''adjustment'',-amount,''purchase_cancel'',reference_id,''عكس بسبب تعديل الفاتورة'',_caller FROM public.supplier_ledger_entries WHERE reference_type=''purchase_invoice'' AND reference_id=_invoice_id::text AND entry_type IN (''purchase'',''payment'');'||_crlf||
    '    INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,reference_id,note,created_by) VALUES (_owner,_orig_inv.supplier_id,''purchase'',round(_grand_total,4),''purchase_invoice'',_new_invoice_id::text,''فاتورة معدّلة '',_caller);'||_crlf||
    '    IF LEAST(COALESCE(_orig_inv.amount_paid,0),_grand_total) > 0 THEN INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,reference_id,note,created_by) VALUES (_owner,_orig_inv.supplier_id,''payment'',-round(LEAST(_orig_inv.amount_paid,_grand_total),4),''purchase_invoice'',_new_invoice_id::text,''دفعة منقولة من الفاتورة الأصلية'',_caller); END IF;'||_crlf||
    '    UPDATE public.purchase_invoices SET supplier_id=_orig_inv.supplier_id, amount_paid=LEAST(COALESCE(_orig_inv.amount_paid,0),_grand_total) WHERE id=_new_invoice_id;'||_crlf||
    '  END IF;'||_crlf||'  '||_a);
  EXECUTE _def;
END $$;

DO $$ DECLARE f text; BEGIN
 FOREACH f IN ARRAY ARRAY['create_supplier_atomic(text,text,text,text)','link_purchase_to_supplier_atomic(uuid,uuid,numeric)','pay_supplier_atomic(uuid,numeric,text,text,text)','purchase_return_atomic(uuid,jsonb,text,text)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', f);
 END LOOP; END $$;
