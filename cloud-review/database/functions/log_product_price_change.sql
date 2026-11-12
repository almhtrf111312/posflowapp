-- log_product_price_change()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.log_product_price_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.cost_price IS DISTINCT FROM OLD.cost_price OR NEW.sale_price IS DISTINCT FROM OLD.sale_price THEN
    INSERT INTO public.activity_log(user_id, actor_id, action_type, entity_type, entity_id, entity_name, description, metadata)
    VALUES (NEW.user_id, auth.uid(), 'product_price_changed', 'product', NEW.id::text, NEW.name,
      'تغيير سعر المنتج ' || NEW.name,
      jsonb_build_object('old_cost',OLD.cost_price,'new_cost',NEW.cost_price,'old_sale',OLD.sale_price,'new_sale',NEW.sale_price,
        'source', COALESCE(NULLIF(current_setting('app.stock_source', true),''),'direct_update')));
  END IF;
  RETURN NEW;
END $function$
;
