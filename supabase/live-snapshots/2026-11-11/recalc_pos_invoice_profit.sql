CREATE OR REPLACE FUNCTION public.recalc_pos_invoice_profit(_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE 
  _inv public.invoices%ROWTYPE; 
  _cogs numeric; 
  _sub numeric; 
  _f numeric := 1;
BEGIN
  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- الضريبة ليست ربحاً: استخراج معامل الإيراد الصافي في الوضع الشامل
  IF COALESCE(_inv.tax_inclusive, false) AND COALESCE(_inv.tax_rate, 0) > 0 THEN
    _f := 1 / (1 + _inv.tax_rate / 100);
  END IF;

  -- تصحيح احتساب التكلفة: لا يُضرب بمعامل التحويل إلا إذا كان البند مباعاً بالكرتونة (bulk)
  UPDATE public.invoice_items ii
     SET cost_price = round(
           COALESCE(p.cost_price, 0) * (
             CASE 
               WHEN COALESCE(ii.unit, 'piece') = 'bulk' THEN GREATEST(COALESCE(ii.conversion_factor, 1), 1)
               ELSE 1 
             END
           ), 8),
         warranty_until = CASE WHEN p.warranty_months IS NOT NULL THEN (_inv.date + make_interval(months => p.warranty_months))::date ELSE NULL END
    FROM public.products p
   WHERE ii.invoice_id = _invoice_id AND p.id = ii.product_id AND p.user_id = _inv.user_id;

  SELECT COALESCE(SUM(COALESCE(cost_price, 0) * COALESCE(quantity, 0)), 0),
         COALESCE(SUM(COALESCE(unit_price, 0) * COALESCE(quantity, 0)), 0)
    INTO _cogs, _sub FROM public.invoice_items WHERE invoice_id = _invoice_id;

  UPDATE public.invoice_items
     SET profit = round(((COALESCE(unit_price, 0) * COALESCE(quantity, 0))
                  - CASE WHEN _sub > 0 THEN COALESCE(_inv.discount, 0) * (COALESCE(unit_price, 0) * COALESCE(quantity, 0)) / _sub ELSE 0 END) * _f
                  - COALESCE(cost_price, 0) * COALESCE(quantity, 0), 8)
   WHERE invoice_id = _invoice_id;

  UPDATE public.invoices
     SET profit = round((COALESCE(subtotal, _sub) - COALESCE(discount, 0)) * _f - _cogs, 8)
   WHERE id = _invoice_id;
END;
$function$
