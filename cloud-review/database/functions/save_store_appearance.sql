-- save_store_appearance(_font_family text, _theme text, _appearance jsonb)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.save_store_appearance(_font_family text, _theme text DEFAULT NULL::text, _appearance jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _owner uuid;
BEGIN
  IF _uid IS NULL THEN 
    RAISE EXCEPTION 'غير مصرح'; 
  END IF;

  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN 
    RAISE EXCEPTION 'لم يتم العثور على مالك المتجر'; 
  END IF;

  UPDATE public.stores
  SET 
    font_family = COALESCE(NULLIF(trim(_font_family), ''), font_family, 'Cairo'),
    theme = COALESCE(_theme, theme),
    appearance_settings = COALESCE(_appearance, appearance_settings),
    updated_at = now()
  WHERE user_id = _owner;

  RETURN jsonb_build_object(
    'success', true,
    'font_family', _font_family,
    'theme', _theme
  );
END;
$function$
;
