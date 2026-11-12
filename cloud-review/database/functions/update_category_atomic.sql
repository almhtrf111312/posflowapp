-- update_category_atomic(_category_id uuid, _new_name text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.update_category_atomic(_category_id uuid, _new_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _owner uuid := public.get_owner_id(auth.uid());
  _old_name text;
  _partner record;
  _updated_shares jsonb;
  _item jsonb;
BEGIN
  IF auth.uid() IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  _new_name := trim(_new_name);
  IF _new_name IS NULL OR length(_new_name) = 0 THEN
    RAISE EXCEPTION 'اسم التصنيف لا يمكن أن يكون فارغاً';
  END IF;

  -- 1) قفل التصنيف وجلب الاسم القديم
  SELECT name INTO _old_name
  FROM public.categories
  WHERE id = _category_id AND user_id = _owner
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'التصنيف غير موجود';
  END IF;

  IF _old_name = _new_name THEN
    RETURN jsonb_build_object('success', true, 'updated', false);
  END IF;

  -- 2) تحديث اسم التصنيف
  UPDATE public.categories
  SET name = _new_name, updated_at = now()
  WHERE id = _category_id;

  -- 3) تحديث اسم التصنيف في كافة المنتجات التابعة لهذا المتجر
  UPDATE public.products
  SET category = _new_name, updated_at = now()
  WHERE user_id = _owner AND category = _old_name;

  -- 4) تحديث نسب الشركاء لهذا التصنيف في مصفوفة category_shares
  FOR _partner IN
    SELECT id, category_shares FROM public.partners
    WHERE user_id = _owner AND category_shares IS NOT NULL
    FOR UPDATE
  LOOP
    _updated_shares := '[]'::jsonb;
    FOR _item IN SELECT * FROM jsonb_array_elements(_partner.category_shares) LOOP
      IF (_item->>'categoryName') = _old_name THEN
        _updated_shares := _updated_shares || jsonb_set(_item, '{categoryName}', to_jsonb(_new_name));
      ELSE
        _updated_shares := _updated_shares || _item;
      END IF;
    END LOOP;

    UPDATE public.partners
    SET category_shares = _updated_shares, updated_at = now()
    WHERE id = _partner.id;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'old_name', _old_name,
    'new_name', _new_name
  );
END;
$function$
;
