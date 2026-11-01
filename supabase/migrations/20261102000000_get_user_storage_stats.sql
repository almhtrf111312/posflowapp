-- دالة حساب إحصائيات التخزين والبيانات لمستخدم محدد (للمدير العام Boss فقط)
CREATE OR REPLACE FUNCTION public.get_user_storage_stats(_target_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $$
DECLARE
  _caller UUID := auth.uid();
  _is_boss BOOLEAN := false;
  _categories_count BIGINT := 0;
  _products_count BIGINT := 0;
  _storage_bytes BIGINT := 0;
  _storage_formatted TEXT := '0 KB';
BEGIN
  -- 1. التحقق الأمني: مخصص للمدير العام Boss فقط
  SELECT (role = 'boss') INTO _is_boss 
  FROM public.user_roles 
  WHERE user_id = _caller AND role = 'boss' 
  LIMIT 1;

  IF NOT _is_boss THEN
    RAISE EXCEPTION 'غير مصرح: هذا الإجراء مخصص للمدير العام فقط';
  END IF;

  -- 2. حساب عدد الأصناف (Categories)
  SELECT count(*) INTO _categories_count
  FROM public.categories
  WHERE user_id = _target_user_id;

  -- 3. حساب عدد المنتجات غير المؤرشفة (Products)
  SELECT count(*) INTO _products_count
  FROM public.products
  WHERE user_id = _target_user_id AND (archived IS NULL OR archived = false);

  -- 4. حساب المساحة التخزينية المستخدمة من storage.objects (الصور والنسخ الاحتياطية)
  SELECT coalesce(sum((metadata->>'size')::bigint), 0) INTO _storage_bytes
  FROM storage.objects
  WHERE (storage.foldername(name))[1] = _target_user_id::text 
     OR name LIKE _target_user_id::text || '/%'
     OR owner = _target_user_id::text;

  -- 5. تنسيق المساحة لوحدات مفهومة
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
$$;

-- منح صلاحية الاستدعاء للحسابات المسجلة
GRANT EXECUTE ON FUNCTION public.get_user_storage_stats(UUID) TO authenticated;
