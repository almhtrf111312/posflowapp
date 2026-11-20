-- PosFlow phase 4: serial numbers / IMEI tracking (per-unit), integrated with purchase finalize, POS sale and refunds.
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS track_serials boolean NOT NULL DEFAULT false;
ALTER TABLE public.purchase_invoice_items ADD COLUMN IF NOT EXISTS serials text[];

CREATE TABLE IF NOT EXISTS public.product_serials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  serial text NOT NULL CHECK (length(trim(serial)) > 0),
  status text NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','sold','defective','returned_to_supplier')),
  cost_price numeric(18,6),
  purchase_invoice_id uuid,
  sold_invoice_id uuid,
  sold_invoice_number text,
  sold_at timestamptz,
  customer_name text,
  warranty_until date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_serials ON public.product_serials(user_id, product_id, lower(serial));
CREATE INDEX IF NOT EXISTS ix_product_serials_lookup ON public.product_serials(user_id, lower(serial));
CREATE INDEX IF NOT EXISTS ix_product_serials_stock ON public.product_serials(product_id, status);

CREATE TABLE IF NOT EXISTS public.product_serial_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  serial_id uuid NOT NULL REFERENCES public.product_serials(id) ON DELETE RESTRICT,
  event text NOT NULL,
  ref text,
  actor uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_serial_events ON public.product_serial_events(serial_id, created_at);

ALTER TABLE public.product_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_serial_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS serials_select ON public.product_serials;
CREATE POLICY serials_select ON public.product_serials FOR SELECT TO authenticated USING (user_id = public.get_owner_id(auth.uid()));
DROP POLICY IF EXISTS serial_events_select ON public.product_serial_events;
CREATE POLICY serial_events_select ON public.product_serial_events FOR SELECT TO authenticated USING (user_id = public.get_owner_id(auth.uid()));
REVOKE ALL ON public.product_serials, public.product_serial_events FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.product_serials, public.product_serial_events FROM authenticated;

CREATE OR REPLACE FUNCTION public._register_serials(_owner uuid, _product uuid, _serials text[], _cost numeric, _invoice uuid, _qty numeric)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _clean text[]; _s text; _id uuid; _n int := 0; _track boolean; _name text;
BEGIN
  SELECT track_serials, name INTO _track, _name FROM public.products WHERE id=_product AND user_id=_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'المنتج غير موجود'; END IF;
  SELECT COALESCE(array_agg(DISTINCT trim(x)) FILTER (WHERE trim(x) <> ''), '{}') INTO _clean FROM unnest(COALESCE(_serials,'{}')) x;
  IF cardinality(_clean) <> cardinality(COALESCE(_serials,'{}')) THEN RAISE EXCEPTION 'أرقام تسلسلية مكررة أو فارغة للمنتج %', _name; END IF;
  IF _qty IS NOT NULL AND cardinality(_clean) > 0 AND cardinality(_clean) <> _qty THEN
    RAISE EXCEPTION 'عدد الأرقام التسلسلية (%) لا يطابق الكمية (%) للمنتج %', cardinality(_clean), _qty, _name;
  END IF;
  FOREACH _s IN ARRAY _clean LOOP
    IF EXISTS (SELECT 1 FROM public.product_serials WHERE user_id=_owner AND product_id=_product AND lower(serial)=lower(_s) AND status='in_stock') THEN
      RAISE EXCEPTION 'الرقم التسلسلي % مسجّل مسبقاً ومتوفر في المخزون', _s;
    END IF;
    SELECT id INTO _id FROM public.product_serials WHERE user_id=_owner AND product_id=_product AND lower(serial)=lower(_s);
    IF _id IS NULL THEN
      INSERT INTO public.product_serials(user_id,product_id,serial,status,cost_price,purchase_invoice_id) VALUES (_owner,_product,_s,'in_stock',_cost,_invoice) RETURNING id INTO _id;
    ELSE
      UPDATE public.product_serials SET status='in_stock', cost_price=_cost, purchase_invoice_id=_invoice, sold_invoice_id=NULL, sold_invoice_number=NULL, sold_at=NULL, customer_name=NULL, warranty_until=NULL, updated_at=now() WHERE id=_id;
    END IF;
    INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) VALUES (_owner,_id,'received',_invoice::text,auth.uid());
    _n := _n + 1;
  END LOOP;
  RETURN _n;
END $$;
REVOKE ALL ON FUNCTION public._register_serials(uuid,uuid,text[],numeric,uuid,numeric) FROM PUBLIC, anon, authenticated;

-- تسجيل أرقام لمخزون موجود مسبقاً (دون تغيير الكمية)
CREATE OR REPLACE FUNCTION public.register_serials_atomic(_product_id uuid, _serials text[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _o uuid := public.get_owner_id(auth.uid()); _cost numeric; _n int;
BEGIN
  IF auth.uid() IS NULL OR _o IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT cost_price INTO _cost FROM public.products WHERE id=_product_id AND user_id=_o;
  IF NOT FOUND THEN RAISE EXCEPTION 'المنتج غير موجود'; END IF;
  _n := public._register_serials(_o,_product_id,_serials,_cost,NULL,NULL);
  UPDATE public.products SET track_serials=true WHERE id=_product_id AND NOT track_serials;
  RETURN _n;
END $$;
GRANT EXECUTE ON FUNCTION public.register_serials_atomic(uuid,text[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.lookup_serial(_serial text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _o uuid := public.get_owner_id(auth.uid());
BEGIN
  IF auth.uid() IS NULL OR _o IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'serial', s.serial, 'status', s.status, 'product_id', s.product_id, 'product_name', p.name,
      'sold_invoice_number', s.sold_invoice_number, 'sold_at', s.sold_at, 'customer_name', s.customer_name,
      'warranty_until', s.warranty_until, 'cost_price', s.cost_price,
      'events', (SELECT COALESCE(jsonb_agg(jsonb_build_object('event',e.event,'ref',e.ref,'at',e.created_at) ORDER BY e.created_at),'[]'::jsonb) FROM public.product_serial_events e WHERE e.serial_id=s.id)))
    FROM public.product_serials s JOIN public.products p ON p.id=s.product_id
    WHERE s.user_id=_o AND lower(s.serial)=lower(trim(_serial))), '[]'::jsonb);
END $$;
GRANT EXECUTE ON FUNCTION public.lookup_serial(text) TO authenticated, service_role;

-- إرجاع أرقام لمخزون بعد مرتجع جزئي
CREATE OR REPLACE FUNCTION public.release_serials_atomic(_invoice_number text, _serials text[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _o uuid := public.get_owner_id(auth.uid()); _n int := 0; _r record;
BEGIN
  IF auth.uid() IS NULL OR _o IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  FOR _r IN SELECT id FROM public.product_serials WHERE user_id=_o AND sold_invoice_number=_invoice_number AND status='sold' AND lower(serial)=ANY(SELECT lower(x) FROM unnest(_serials) x) FOR UPDATE LOOP
    UPDATE public.product_serials SET status='in_stock', sold_invoice_id=NULL, sold_invoice_number=NULL, sold_at=NULL, customer_name=NULL, warranty_until=NULL, updated_at=now() WHERE id=_r.id;
    INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) VALUES (_o,_r.id,'customer_return',_invoice_number,auth.uid());
    _n := _n + 1;
  END LOOP;
  IF _n <> cardinality(_serials) THEN RAISE EXCEPTION 'بعض الأرقام غير مرتبطة بهذه الفاتورة'; END IF;
  RETURN _n;
END $$;
GRANT EXECUTE ON FUNCTION public.release_serials_atomic(text,text[]) TO authenticated, service_role;

-- مرتجع كامل للفاتورة يُعيد أرقامها للمخزون تلقائياً
CREATE OR REPLACE FUNCTION public._release_serials_on_invoice_refund() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _r record;
BEGIN
  IF NEW.status IN ('refunded','cancelled') AND OLD.status IS DISTINCT FROM NEW.status THEN
    FOR _r IN SELECT id, user_id FROM public.product_serials WHERE sold_invoice_id = NEW.id AND status='sold' LOOP
      UPDATE public.product_serials SET status='in_stock', sold_invoice_id=NULL, sold_invoice_number=NULL, sold_at=NULL, customer_name=NULL, warranty_until=NULL, updated_at=now() WHERE id=_r.id;
      INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) VALUES (_r.user_id,_r.id,'customer_return',NEW.invoice_number,auth.uid());
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_release_serials_on_refund ON public.invoices;
CREATE TRIGGER trg_release_serials_on_refund AFTER UPDATE OF status ON public.invoices FOR EACH ROW EXECUTE FUNCTION public._release_serials_on_invoice_refund();

-- اعتماد فاتورة الشراء يسجّل الأرقام التسلسلية ذرّياً
DO $$
DECLARE _oid oid; _def text; _a text := '  IF _inv.supplier_id IS NOT NULL THEN'; _crlf text := chr(13)||chr(10);
BEGIN
  SELECT oid INTO _oid FROM pg_proc WHERE proname='finalize_purchase_invoice_atomic' AND pronamespace='public'::regnamespace;
  _def := pg_get_functiondef(_oid);
  IF (length(_def)-length(replace(_def,_a,'')))/length(_a) <> 1 THEN RAISE EXCEPTION 'finalize anchor mismatch'; END IF;
  _def := replace(_def,_a,
   '  DECLARE _sr record;'||_crlf||
   '  BEGIN'||_crlf||
   '    FOR _sr IN SELECT i.product_id, i.quantity, i.cost_price, i.serials, p.track_serials, p.name FROM public.purchase_invoice_items i JOIN public.products p ON p.id=i.product_id WHERE i.invoice_id=_invoice_id AND (p.track_serials OR cardinality(COALESCE(i.serials,''{}''::text[]))>0) LOOP'||_crlf||
   '      IF _sr.track_serials AND cardinality(COALESCE(_sr.serials,''{}''::text[])) = 0 THEN RAISE EXCEPTION ''المنتج % يتطلب إدخال أرقام تسلسلية'', _sr.name; END IF;'||_crlf||
   '      PERFORM public._register_serials(_owner,_sr.product_id,_sr.serials,_sr.cost_price,_invoice_id,_sr.quantity);'||_crlf||
   '      UPDATE public.products SET track_serials=true WHERE id=_sr.product_id AND NOT track_serials;'||_crlf||
   '    END LOOP;'||_crlf||
   '  END;'||_crlf||_crlf||_a);
  EXECUTE _def;
END $$;

-- البيع من نقطة البيع يُلزم اختيار رقم لكل وحدة ويحجزها ذرّياً
DO $$
DECLARE _oid oid; _def text; _a text := '  -- 1) حساب الأرباح آلياً بدقة 8 منازل واستبعاد الضريبة'; _crlf text := chr(13)||chr(10);
BEGIN
  SELECT oid INTO _oid FROM pg_proc WHERE proname='process_pos_sale_atomic' AND pronamespace='public'::regnamespace;
  _def := pg_get_functiondef(_oid);
  IF (length(_def)-length(replace(_def,_a,'')))/length(_a) <> 1 THEN RAISE EXCEPTION 'sale anchor mismatch'; END IF;
  _def := replace(_def,_a,
   '  DECLARE _sv record; _ser text[]; _cnt int;'||_crlf||
   '  BEGIN'||_crlf||
   '    FOR _sv IN SELECT psi.product_id, psi.quantity, p.name, COALESCE(p.warranty_months,0) AS wm FROM pg_temp.pos_sale_items psi JOIN public.products p ON p.id=psi.product_id WHERE p.track_serials LOOP'||_crlf||
   '      SELECT COALESCE(array_agg(x),''{}''::text[]) INTO _ser FROM jsonb_array_elements(_items) it, LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(it.value->''serials'')=''array'' THEN it.value->''serials'' ELSE ''[]''::jsonb END) x WHERE (it.value->>''product_id'')::uuid=_sv.product_id;'||_crlf||
   '      IF cardinality(_ser) <> _sv.quantity OR cardinality(_ser) <> (SELECT count(DISTINCT lower(trim(y))) FROM unnest(_ser) y) THEN RAISE EXCEPTION ''المنتج % يتطلب اختيار % رقم تسلسلي مختلف'', _sv.name, _sv.quantity; END IF;'||_crlf||
   '      UPDATE public.product_serials ps SET status=''sold'', sold_invoice_id=_new_invoice.id, sold_invoice_number=_new_invoice.invoice_number, sold_at=now(), customer_name=_cname, warranty_until=CASE WHEN _sv.wm>0 THEN (CURRENT_DATE + (_sv.wm||'' months'')::interval)::date END, updated_at=now() WHERE ps.user_id=_owner AND ps.product_id=_sv.product_id AND ps.status=''in_stock'' AND lower(ps.serial)=ANY(SELECT lower(trim(y)) FROM unnest(_ser) y);'||_crlf||
   '      GET DIAGNOSTICS _cnt = ROW_COUNT;'||_crlf||
   '      IF _cnt <> cardinality(_ser) THEN RAISE EXCEPTION ''رقم تسلسلي غير متوفر في المخزون للمنتج %'', _sv.name; END IF;'||_crlf||
   '      INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) SELECT _owner, ps.id, ''sold'', _new_invoice.invoice_number, _caller FROM public.product_serials ps WHERE ps.sold_invoice_id=_new_invoice.id AND ps.product_id=_sv.product_id;'||_crlf||
   '    END LOOP;'||_crlf||
   '  END;'||_crlf||_crlf||_a);
  EXECUTE _def;
END $$;
