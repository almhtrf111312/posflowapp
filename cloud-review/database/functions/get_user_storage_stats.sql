-- get_user_storage_stats(_target_user_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.get_user_storage_stats(_target_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'storage'
AS $function$
DECLARE
  _caller UUID := auth.uid();
  _is_boss BOOLEAN := false;
  _caller_role TEXT;
  _categories_count BIGINT := 0;
  _products_count BIGINT := 0;
  _storage_bytes BIGINT := 0;
  _storage_formatted TEXT := '0 KB';
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير مسجل الدخول';
  END IF;

  -- 1. فحص الرتبة
  SELECT role INTO _caller_role FROM public.user_roles WHERE user_id = _caller LIMIT 1;
  _is_boss := (_caller_role = 'boss');

  -- السماح للـ Boss دائماً، أو للمالك بفحص حسابه وحسابات كاشيراته
  IF NOT _is_boss AND _caller <> _target_user_id AND public.get_owner_id(_target_user_id) <> _caller THEN
    RAISE EXCEPTION 'غير مصرح: هذا الإجراء مخصص للمدير العام أو مالك الحساب فقط';
  END IF;

  -- 2. حساب عدد الأصناف
  SELECT count(*) INTO _categories_count
  FROM public.categories
  WHERE user_id = _target_user_id;

  -- 3. حساب عدد المنتجات النشطة غير المؤرشفة
  SELECT count(*) INTO _products_count
  FROM public.products
  WHERE user_id = _target_user_id AND (archived IS NULL OR archived = false);

  -- 4. حساب المساحة التخزينية المستخدمة من storage.objects بأمان كامل
  SELECT coalesce(sum((metadata->>'size')::bigint), 0) INTO _storage_bytes
  FROM storage.objects
  WHERE (storage.foldername(name))[1] = _target_user_id::text 
     OR name LIKE _target_user_id::text || '/%'
     OR owner = _target_user_id
     OR owner_id = _target_user_id::text;

  -- 5. التنسيق
  IF _storage_bytes >= 1073741824 THEN
    _storage_formatted := round((_storage_bytes / 1073741824.0)::numeric, 2) || ' GB';
  ELSIF _storage_bytes >= 1048576 THEN
    _storage_formatted := round((_storage_bytes / 1048576.0)::numeric, 2) || ' MB';
  ELSIF _storage_bytes >= 1024 THEN
    _storage_formatted := round((_storage_bytes / 1024.0)::numeric, 2) || ' KB';
  ELSE
    _storage_formatted := _storage_bytes || ' B';
  END IF;

  RETURN jsonb_build_object(
    'categories_count', _categories_count,
    'products_count', _products_count,
    'storage_bytes', _storage_bytes,
    'storage_formatted', _storage_formatted
  );
END;
$function$
;
