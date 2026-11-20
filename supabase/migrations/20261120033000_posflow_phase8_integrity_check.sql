-- المرحلة 8: فحص النزاهة الأساسي (قراءة فقط). التراجع: ROLLBACK_stage_8.sql
CREATE OR REPLACE FUNCTION public._posflow_integrity_core(_owner uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _res jsonb := '[]'::jsonb; _cnt int; _sample jsonb;
BEGIN
  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (SELECT p.id, row_number() over() rn FROM products p WHERE p.user_id=_owner AND p.quantity<0) x;
  _res := _res || jsonb_build_object('check','negative_stock','severity','high','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT c.id, row_number() over() rn FROM customers c
     WHERE c.user_id=_owner AND abs(COALESCE(c.total_debt,0) - COALESCE((SELECT SUM(d.remaining_debt) FROM debts d WHERE d.user_id=_owner AND COALESCE(d.status,'') NOT IN ('fully_paid','written_off','cancelled') AND (d.customer_id=c.id OR (d.customer_id IS NULL AND d.customer_name=c.name))),0)) > 0.01) x;
  _res := _res || jsonb_build_object('check','customer_debt_mismatch','severity','high','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT d.id, row_number() over() rn FROM debts d JOIN invoices i ON i.user_id=d.user_id AND (d.invoice_id=i.invoice_number OR d.invoice_id=i.id::text)
     WHERE d.user_id=_owner AND COALESCE(d.status,'') NOT IN ('fully_paid','written_off','cancelled') AND d.remaining_debt>0 AND i.status IN ('refunded','cancelled')) x;
  _res := _res || jsonb_build_object('check','open_debt_on_refunded_invoice','severity','high','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT i.id, row_number() over() rn FROM invoices i
     WHERE i.user_id=_owner AND i.payment_type='debt' AND i.status NOT IN ('refunded','cancelled')
       AND abs(COALESCE(i.debt_remaining,0) - COALESCE((SELECT SUM(d.remaining_debt) FROM debts d WHERE d.user_id=_owner AND d.status NOT IN ('cancelled') AND (d.invoice_id=i.invoice_number OR d.invoice_id=i.id::text)),0)) > 0.01) x;
  _res := _res || jsonb_build_object('check','invoice_debt_vs_debts','severity','high','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT d.id, row_number() over() rn FROM debts d
     WHERE d.user_id=_owner AND COALESCE(d.status,'') NOT IN ('cancelled','written_off')
       AND abs(COALESCE(d.total_debt,0)-COALESCE(d.total_paid,0)-COALESCE(d.remaining_debt,0)) > 0.01) x;
  _res := _res || jsonb_build_object('check','debt_math','severity','medium','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT i.id, row_number() over() rn FROM invoices i
     WHERE i.user_id=_owner AND i.status NOT IN ('refunded','cancelled')
       AND EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=i.id)
       AND abs(COALESCE(i.profit,0) - (SELECT COALESCE(SUM(ii.profit),0) FROM invoice_items ii WHERE ii.invoice_id=i.id)) > 0.05) x;
  _res := _res || jsonb_build_object('check','invoice_profit_vs_items','severity','medium','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT p.id, row_number() over() rn FROM partners p
     WHERE p.user_id=_owner AND abs(COALESCE(p.pending_profit,0) - COALESCE((SELECT SUM((e->>'amount')::numeric) FROM jsonb_array_elements(COALESCE(p.pending_profit_details,'[]'::jsonb)) e),0)) > 0.01) x;
  _res := _res || jsonb_build_object('check','partner_pending_vs_details','severity','medium','count',_cnt,'sample',_sample);

  RETURN jsonb_build_object('checked_at', now(), 'issues_total', (SELECT COALESCE(SUM((e->>'count')::int),0) FROM jsonb_array_elements(_res) e), 'checks', _res);
END $$;
REVOKE ALL ON FUNCTION public._posflow_integrity_core(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._posflow_integrity_core(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.posflow_integrity_check()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _caller uuid := auth.uid(); _owner uuid;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.is_store_owner(_caller) THEN RAISE EXCEPTION 'فحص النزاهة مخصص لمالك المتجر فقط' USING ERRCODE='42501'; END IF;
  _owner := public.get_owner_id(_caller);
  RETURN public._posflow_integrity_core(_owner);
END $$;
REVOKE ALL ON FUNCTION public.posflow_integrity_check() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.posflow_integrity_check() TO authenticated, service_role;
