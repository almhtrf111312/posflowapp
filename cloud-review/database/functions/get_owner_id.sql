-- get_owner_id(_user_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.get_owner_id(_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _role app_role;
  _owner_id uuid;
  _is_active boolean;
  _owner_active boolean;
BEGIN
  IF _user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- استخراج الدور وحالة النشاط ومعرف المالك
  SELECT role, owner_id, COALESCE(is_active, true)
    INTO _role, _owner_id, _is_active
  FROM public.user_roles
  WHERE user_id = _user_id
  LIMIT 1;

  -- إذا كان الحساب غير نشط (معطل) يتم قطع الوصول فوراً
  IF _is_active IS FALSE THEN
    RETURN NULL;
  END IF;

  -- إذا كان كاشيراً، يجب التحقق أيضاً من أن متجر المالك ليس معطلاً
  IF _role = 'cashier' AND _owner_id IS NOT NULL THEN
    SELECT COALESCE(is_active, true) INTO _owner_active
    FROM public.user_roles
    WHERE user_id = _owner_id
    LIMIT 1;

    IF _owner_active IS FALSE THEN
      RETURN NULL;
    END IF;

    RETURN _owner_id;
  END IF;

  -- إذا كان مديراً أو Boss ونشطاً، فهو صاحب المتجر
  IF _role IN ('admin', 'boss') OR _owner_id IS NULL THEN
    RETURN _user_id;
  END IF;

  RETURN _owner_id;
END;
$function$
;
