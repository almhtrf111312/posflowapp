-- sync_product_typed_fields()
-- SECURITY DEFINER: False
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.sync_product_typed_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE cf jsonb := COALESCE(NEW.custom_fields,'{}'::jsonb); _w text; _wp text;
BEGIN
  NEW.serial_number := NULLIF(left(trim(COALESCE(cf->>'serialNumber','')),64),'');
  NEW.batch_number  := NULLIF(left(trim(COALESCE(cf->>'batchNumber','')),64),'');
  NEW.weight        := NULLIF(left(trim(COALESCE(cf->>'weight','')),32),'');
  NEW.size          := NULLIF(left(trim(COALESCE(cf->>'size','')),32),'');
  NEW.color         := NULLIF(left(trim(COALESCE(cf->>'color','')),32),'');
  NEW.fabric_type   := NULLIF(left(trim(COALESCE(cf->>'fabricType','')),64),'');
  NEW.author        := NULLIF(left(trim(COALESCE(cf->>'author','')),120),'');
  NEW.publisher     := NULLIF(left(trim(COALESCE(cf->>'publisher','')),120),'');
  NEW.table_number  := NULLIF(left(trim(COALESCE(cf->>'tableNumber','')),16),'');
  NEW.order_notes   := NULLIF(left(trim(COALESCE(cf->>'orderNotes','')),500),'');
  _w := substring(COALESCE(cf->>'warranty','') from '([0-9]+)');
  NEW.warranty_months := CASE WHEN _w IS NULL THEN NULL
    WHEN COALESCE(cf->>'warranty','') ~* '(سنة|سنوات|year)' THEN LEAST(_w::int*12,600)
    ELSE LEAST(_w::int,600) END;
  _wp := COALESCE(cf->>'wholesalePrice','');
  NEW.wholesale_price := CASE WHEN _wp ~ '^[0-9]+([.][0-9]+)?$' AND _wp::numeric > 0 THEN round(_wp::numeric,2) ELSE NULL END;
  RETURN NEW;
END $function$
;
