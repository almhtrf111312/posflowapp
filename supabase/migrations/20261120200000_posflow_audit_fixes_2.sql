-- audit fixes part 2: bulk serial sale, purchase return WAC, edit moves serials, trim partner history arrays
DO $m$
DECLARE _def text; _new text;
BEGIN
  SELECT replace(pg_get_functiondef(p.oid),E'\r','') INTO _def FROM pg_proc p WHERE p.proname='process_pos_sale_atomic' AND p.pronamespace='public'::regnamespace;
  _new := replace(_def, 'SELECT psi.product_id, psi.quantity, p.name, COALESCE(p.warranty_months,0) AS wm FROM pg_temp.pos_sale_items psi',
    'SELECT psi.product_id, (psi.quantity * CASE WHEN psi.unit = ''bulk'' THEN GREATEST(COALESCE(psi.conversion_factor,1),1) ELSE 1 END) AS quantity, p.name, COALESCE(p.warranty_months,0) AS wm FROM pg_temp.pos_sale_items psi');
  IF _new = _def THEN RAISE EXCEPTION 'patch sale failed'; END IF;
  EXECUTE _new;

  SELECT replace(pg_get_functiondef(p.oid),E'\r','') INTO _def FROM pg_proc p WHERE p.proname='purchase_return_atomic' AND p.pronamespace='public'::regnamespace;
  _new := replace(_def, 'UPDATE public.products SET quantity = round(quantity - _qty,3), updated_at=now() WHERE id=_it.product_id;',
    'UPDATE public.products SET cost_price = CASE WHEN quantity - _qty > 0 THEN GREATEST(0, round((quantity*COALESCE(cost_price,0) - _qty*COALESCE(_it.cost_price,0))/(quantity - _qty),8)) ELSE cost_price END, quantity = round(quantity - _qty,3), updated_at=now() WHERE id=_it.product_id;');
  IF _new = _def THEN RAISE EXCEPTION 'patch return failed'; END IF;
  EXECUTE _new;

  SELECT replace(pg_get_functiondef(p.oid),E'\r','') INTO _def FROM pg_proc p WHERE p.proname='edit_purchase_invoice_atomic' AND p.pronamespace='public'::regnamespace;
  _new := replace(_def, E'RETURNING id INTO _new_invoice_id;\n', E'RETURNING id INTO _new_invoice_id;\n  UPDATE public.product_serials SET purchase_invoice_id=_new_invoice_id, updated_at=now() WHERE purchase_invoice_id=_invoice_id AND user_id=_owner AND status=''in_stock'';\n');
  IF _new = _def THEN RAISE EXCEPTION 'patch edit serials failed'; END IF;
  EXECUTE _new;
END $m$;

CREATE OR REPLACE FUNCTION public._partners_trim_history() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $f$
DECLARE _cut timestamptz := now() - interval '400 days';
BEGIN
  IF jsonb_typeof(NEW.profit_history)='array' AND jsonb_array_length(NEW.profit_history) > 1500 THEN
    NEW.profit_history := COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(NEW.profit_history) x WHERE COALESCE(x->>'createdAt','') !~ '^\d{4}-' OR (x->>'createdAt')::timestamptz >= _cut), '[]'::jsonb);
  END IF;
  IF jsonb_typeof(NEW.expense_history)='array' AND jsonb_array_length(NEW.expense_history) > 1500 THEN
    NEW.expense_history := COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(NEW.expense_history) x WHERE COALESCE(x->>'createdAt','') !~ '^\d{4}-' OR (x->>'createdAt')::timestamptz >= _cut), '[]'::jsonb);
  END IF;
  IF jsonb_typeof(NEW.withdrawal_history)='array' AND jsonb_array_length(NEW.withdrawal_history) > 1500 THEN
    NEW.withdrawal_history := COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(NEW.withdrawal_history) x WHERE COALESCE(x->>'createdAt',x->>'date','') !~ '^\d{4}-' OR COALESCE(x->>'createdAt',x->>'date')::timestamptz >= _cut), '[]'::jsonb);
  END IF;
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_partners_trim_history ON public.partners;
CREATE TRIGGER trg_partners_trim_history BEFORE UPDATE ON public.partners FOR EACH ROW EXECUTE FUNCTION public._partners_trim_history();
