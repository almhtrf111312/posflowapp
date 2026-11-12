-- get_user_role(_user_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.get_user_role(_user_id uuid)
 RETURNS app_role
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _role app_role;
  _caller_id uuid;
  _caller_is_admin boolean;
BEGIN
  -- Get the calling user's ID
  _caller_id := auth.uid();
  
  -- If no authenticated user, return null
  IF _caller_id IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- Allow users to query their own role
  IF _caller_id = _user_id THEN
    SELECT role INTO _role FROM public.user_roles WHERE user_id = _user_id LIMIT 1;
    RETURN _role;
  END IF;
  
  -- Check if caller is admin (direct query to avoid recursion)
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _caller_id AND role = 'admin'
  ) INTO _caller_is_admin;
  
  -- Only admins can query other users' roles
  IF _caller_is_admin THEN
    SELECT role INTO _role FROM public.user_roles WHERE user_id = _user_id LIMIT 1;
    RETURN _role;
  END IF;
  
  -- Non-admins cannot query other users' roles
  RETURN NULL;
END;
$function$
;
