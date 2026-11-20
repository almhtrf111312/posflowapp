-- المرحلة 5 (طبقة قاعدة البيانات): الصناديق المتعددة وسند المصارفة. التراجع: ROLLBACK_stage_5.sql
CREATE TABLE IF NOT EXISTS public.cash_boxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3,5}$'),
  kind text NOT NULL DEFAULT 'cash' CHECK (kind IN ('cash','bank','wallet')),
  opening_balance numeric(18,4) NOT NULL DEFAULT 0 CHECK (opening_balance >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS public.cash_box_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  box_id uuid NOT NULL REFERENCES public.cash_boxes(id) ON DELETE RESTRICT,
  entry_type text NOT NULL CHECK (entry_type IN ('manual_in','manual_out','transfer_in','transfer_out','fx_in','fx_out')),
  amount numeric(18,4) NOT NULL CHECK (amount <> 0),          -- موجب يزيد الرصيد وسالب ينقصه
  currency_code text NOT NULL,
  exchange_rate numeric(18,8),                                  -- للمصارفة: وحدات العملة المستلمة لكل وحدة مدفوعة
  group_id uuid,                                                -- يربط قيدَي التحويل/المصارفة
  reason text,
  operation_id text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_box_entries_op ON public.cash_box_entries(user_id, operation_id, box_id) WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cash_box_entries_box ON public.cash_box_entries(box_id, created_at);

ALTER TABLE public.cash_boxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_box_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner reads cash boxes" ON public.cash_boxes;
CREATE POLICY "owner reads cash boxes" ON public.cash_boxes FOR SELECT TO authenticated
  USING (user_id = public.get_owner_id(auth.uid()) AND public.is_store_owner(auth.uid()));
DROP POLICY IF EXISTS "owner reads cash box entries" ON public.cash_box_entries;
CREATE POLICY "owner reads cash box entries" ON public.cash_box_entries FOR SELECT TO authenticated
  USING (user_id = public.get_owner_id(auth.uid()) AND public.is_store_owner(auth.uid()));
-- لا سياسات كتابة: كل التعديل عبر الدوال الذرية فقط، والقيود لا تُعدَّل ولا تُحذف
REVOKE INSERT, UPDATE, DELETE ON public.cash_boxes, public.cash_box_entries FROM anon, authenticated;

CREATE OR REPLACE VIEW public.cash_box_balances WITH (security_invoker = true) AS
SELECT b.id, b.user_id, b.name, b.currency_code, b.kind, b.is_active,
       round(b.opening_balance + COALESCE(SUM(e.amount),0), 4) AS balance
  FROM public.cash_boxes b LEFT JOIN public.cash_box_entries e ON e.box_id = b.id
 GROUP BY b.id;

CREATE OR REPLACE FUNCTION public._cash_box_owner() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _c uuid := auth.uid();
BEGIN
  IF _c IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.is_store_owner(_c) THEN RAISE EXCEPTION 'الصناديق مخصصة لمالك المتجر فقط' USING ERRCODE='42501'; END IF;
  RETURN public.get_owner_id(_c);
END $$;
REVOKE ALL ON FUNCTION public._cash_box_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._cash_box_owner() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._cash_box_balance(_box uuid) RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.opening_balance + COALESCE((SELECT SUM(amount) FROM public.cash_box_entries e WHERE e.box_id=b.id),0) FROM public.cash_boxes b WHERE b.id=_box;
$$;
REVOKE ALL ON FUNCTION public._cash_box_balance(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._cash_box_balance(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.create_cash_box_atomic(_name text, _currency_code text, _kind text DEFAULT 'cash', _opening_balance numeric DEFAULT 0)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _owner uuid := public._cash_box_owner(); _id uuid;
BEGIN
  IF COALESCE(trim(_name),'') = '' THEN RAISE EXCEPTION 'اسم الصندوق مطلوب'; END IF;
  INSERT INTO public.cash_boxes(user_id,name,currency_code,kind,opening_balance,created_by)
  VALUES (_owner, trim(_name), upper(trim(_currency_code)), COALESCE(_kind,'cash'), COALESCE(_opening_balance,0), auth.uid())
  RETURNING id INTO _id;
  RETURN _id;
END $$;

-- قيد يدوي (إيداع/سحب) بسبب إلزامي
CREATE OR REPLACE FUNCTION public.cash_box_manual_entry_atomic(_box_id uuid, _amount numeric, _reason text, _operation_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _owner uuid := public._cash_box_owner(); _b public.cash_boxes%ROWTYPE; _id uuid;
BEGIN
  IF COALESCE(_amount,0) = 0 THEN RAISE EXCEPTION 'المبلغ لا يمكن أن يكون صفراً'; END IF;
  IF COALESCE(trim(_reason),'') = '' THEN RAISE EXCEPTION 'سبب القيد إلزامي'; END IF;
  SELECT * INTO _b FROM public.cash_boxes WHERE id=_box_id AND user_id=_owner AND is_active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الصندوق غير موجود أو غير فعّال'; END IF;
  SELECT id INTO _id FROM public.cash_box_entries WHERE user_id=_owner AND operation_id=_operation_id AND box_id=_box_id;
  IF _id IS NOT NULL THEN RETURN _id; END IF;
  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'قيد صندوق');
  IF _amount < 0 AND public._cash_box_balance(_box_id) + _amount < 0 THEN RAISE EXCEPTION 'رصيد الصندوق غير كافٍ'; END IF;
  INSERT INTO public.cash_box_entries(user_id,box_id,entry_type,amount,currency_code,reason,operation_id,created_by)
  VALUES (_owner,_box_id,CASE WHEN _amount>0 THEN 'manual_in' ELSE 'manual_out' END,round(_amount,4),_b.currency_code,_reason,_operation_id,auth.uid())
  RETURNING id INTO _id;
  RETURN _id;
END $$;

-- تحويل بين صندوقين بنفس العملة
CREATE OR REPLACE FUNCTION public.cash_box_transfer_atomic(_from uuid, _to uuid, _amount numeric, _reason text, _operation_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _owner uuid := public._cash_box_owner(); _a public.cash_boxes%ROWTYPE; _b public.cash_boxes%ROWTYPE; _g uuid;
BEGIN
  IF _from = _to THEN RAISE EXCEPTION 'لا يمكن التحويل لنفس الصندوق'; END IF;
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  PERFORM 1 FROM public.cash_boxes WHERE id IN (_from,_to) AND user_id=_owner ORDER BY id FOR UPDATE;
  SELECT * INTO _a FROM public.cash_boxes WHERE id=_from AND user_id=_owner AND is_active;
  SELECT * INTO _b FROM public.cash_boxes WHERE id=_to AND user_id=_owner AND is_active;
  IF _a.id IS NULL OR _b.id IS NULL THEN RAISE EXCEPTION 'صندوق غير موجود أو غير فعّال'; END IF;
  IF _a.currency_code <> _b.currency_code THEN RAISE EXCEPTION 'العملتان مختلفتان: استخدم سند المصارفة'; END IF;
  SELECT group_id INTO _g FROM public.cash_box_entries WHERE user_id=_owner AND operation_id=_operation_id AND box_id=_from;
  IF _g IS NOT NULL THEN RETURN _g; END IF;
  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'تحويل بين صناديق');
  IF public._cash_box_balance(_from) < _amount THEN RAISE EXCEPTION 'رصيد الصندوق المصدر غير كافٍ'; END IF;
  _g := gen_random_uuid();
  INSERT INTO public.cash_box_entries(user_id,box_id,entry_type,amount,currency_code,group_id,reason,operation_id,created_by) VALUES
   (_owner,_from,'transfer_out',-round(_amount,4),_a.currency_code,_g,_reason,_operation_id,auth.uid()),
   (_owner,_to,'transfer_in',round(_amount,4),_b.currency_code,_g,_reason,_operation_id,auth.uid());
  RETURN _g;
END $$;

-- سند مصارفة: _rate = وحدات عملة الوجهة مقابل وحدة واحدة من عملة المصدر
CREATE OR REPLACE FUNCTION public.cash_box_fx_exchange_atomic(_from uuid, _to uuid, _amount_from numeric, _rate numeric, _reason text, _operation_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _owner uuid := public._cash_box_owner(); _src public.cash_boxes%ROWTYPE; _dst public.cash_boxes%ROWTYPE; _g uuid; _amt_to numeric;
BEGIN
  IF _from = _to THEN RAISE EXCEPTION 'لا يمكن المصارفة لنفس الصندوق'; END IF;
  IF COALESCE(_amount_from,0) <= 0 OR COALESCE(_rate,0) <= 0 THEN RAISE EXCEPTION 'المبلغ وسعر الصرف يجب أن يكونا أكبر من الصفر'; END IF;
  PERFORM 1 FROM public.cash_boxes WHERE id IN (_from,_to) AND user_id=_owner ORDER BY id FOR UPDATE;
  SELECT * INTO _src FROM public.cash_boxes WHERE id=_from AND user_id=_owner AND is_active;
  SELECT * INTO _dst FROM public.cash_boxes WHERE id=_to AND user_id=_owner AND is_active;
  IF _src.id IS NULL OR _dst.id IS NULL THEN RAISE EXCEPTION 'صندوق غير موجود أو غير فعّال'; END IF;
  IF _src.currency_code = _dst.currency_code THEN RAISE EXCEPTION 'العملتان متطابقتان: استخدم التحويل العادي'; END IF;
  SELECT group_id INTO _g FROM public.cash_box_entries WHERE user_id=_owner AND operation_id=_operation_id AND box_id=_from;
  IF _g IS NOT NULL THEN RETURN _g; END IF;
  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'سند مصارفة');
  IF public._cash_box_balance(_from) < _amount_from THEN RAISE EXCEPTION 'رصيد الصندوق المصدر غير كافٍ'; END IF;
  _amt_to := round(_amount_from * _rate, 4);
  IF _amt_to <= 0 THEN RAISE EXCEPTION 'المبلغ الناتج صفر'; END IF;
  _g := gen_random_uuid();
  INSERT INTO public.cash_box_entries(user_id,box_id,entry_type,amount,currency_code,exchange_rate,group_id,reason,operation_id,created_by) VALUES
   (_owner,_from,'fx_out',-round(_amount_from,4),_src.currency_code,_rate,_g,_reason,_operation_id,auth.uid()),
   (_owner,_to,'fx_in',_amt_to,_dst.currency_code,_rate,_g,_reason,_operation_id,auth.uid());
  RETURN _g;
END $$;

DO $$ DECLARE f text; BEGIN
 FOREACH f IN ARRAY ARRAY['create_cash_box_atomic(text,text,text,numeric)','cash_box_manual_entry_atomic(uuid,numeric,text,text)','cash_box_transfer_atomic(uuid,uuid,numeric,text,text)','cash_box_fx_exchange_atomic(uuid,uuid,numeric,numeric,text,text)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', f);
 END LOOP; END $$;
