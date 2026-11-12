-- receive_stock_wac(_product_id uuid, _quantity numeric, _unit_cost numeric, _reference text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.receive_stock_wac(_product_id uuid, _quantity numeric, _unit_cost numeric, _reference text DEFAULT NULL::text)
 RETURNS TABLE(new_quantity numeric, new_cost numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE 
  _caller uuid := auth.uid(); 
  _owner uuid; 
  _cur_qty numeric; 
  _cur_cost numeric; 
  _pos_qty numeric; 
  _calc_cost numeric;
BEGIN
  IF _caller IS NULL THEN 
    RAISE EXCEPTION 'المستخدم غير مسجل'; 
  END IF;
  
  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'حساب المالك غير موجود';
  END IF;

  IF COALESCE(_quantity, 0) <= 0 OR COALESCE(_unit_cost, -1) < 0 THEN 
    RAISE EXCEPTION 'قيم الكمية والتكلفة غير صالحة'; 
  END IF;

  -- جلب بيانات المخزون والتكلفة الحالية مع القفل
  SELECT COALESCE(p.quantity, 0), COALESCE(p.cost_price, 0) 
    INTO _cur_qty, _cur_cost 
    FROM public.products p
   WHERE p.id = _product_id AND p.user_id = _owner 
     FOR UPDATE;

  IF NOT FOUND THEN 
    RAISE EXCEPTION 'المنتج غير موجود'; 
  END IF;

  _pos_qty := GREATEST(_cur_qty, 0);

  -- معادلة WAC الدقيقة
  IF _pos_qty = 0 THEN
    _calc_cost := _unit_cost;
  ELSIF _unit_cost = 0 THEN 
    _calc_cost := _cur_cost;
  ELSE 
    _calc_cost := round(((_pos_qty * _cur_cost) + (_quantity * _unit_cost)) / (_pos_qty + _quantity), 8);
  END IF;

  -- تحديث المنتج بالكمية الجديدة والتكلفة المرجحة
  UPDATE public.products 
     SET quantity = _cur_qty + _quantity, 
         cost_price = _calc_cost, 
         updated_at = now() 
   WHERE id = _product_id;

  -- توثيق حركة المخزون في السجل
  INSERT INTO public.stock_movements (
    user_id, product_id, movement_type, quantity, reference_id, notes, created_at
  ) VALUES (
    _owner, _product_id, 'purchase', _quantity, 
    _reference, 'استلام بضاعة WAC: ' || COALESCE(_reference, ''), now()
  );

  RETURN QUERY SELECT (_cur_qty + _quantity), _calc_cost;
END;
$function$
;
