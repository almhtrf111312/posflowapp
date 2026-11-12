-- handle_new_user_role()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.handle_new_user_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Check if user already has a role (e.g., created via edge function)
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.id) THEN
    -- Anyone who signs up directly becomes an admin (owner)
    INSERT INTO public.user_roles (user_id, role, is_active)
    VALUES (NEW.id, 'admin', true);
  END IF;
  
  RETURN NEW;
END;
$function$
;
