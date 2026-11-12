-- can_add_cashier(_owner_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}

CREATE OR REPLACE FUNCTION public.can_add_cashier(_owner_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _max_cashiers integer;
  _current_cashiers integer;
  _is_revoked boolean;
  _expires_at timestamptz;
BEGIN
  -- التحقق من الترخيص
  SELECT max_cashiers, is_revoked, expires_at 
  INTO _max_cashiers, _is_revoked, _expires_at
  FROM public.app_licenses
  WHERE user_id = _owner_id
  ORDER BY created_at DESC
  LIMIT 1;

  -- إذا لم يوجد ترخيص أو ملغى أو منتهي الصلاحية
  IF _max_cashiers IS NULL OR _is_revoked IS TRUE OR (_expires_at IS NOT NULL AND _expires_at < now()) THEN
    RETURN false;
  END IF;

  -- حساب عدد الكاشيرات النشطة التابعة لهذا المالك
  SELECT count(*) INTO _current_cashiers
  FROM public.user_roles
  WHERE owner_id = _owner_id AND role = 'cashier';

  RETURN _current_cashiers < _max_cashiers;
END;
$function$
;
