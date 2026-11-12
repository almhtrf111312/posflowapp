-- delete_owner_cascade(_owner_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.delete_owner_cascade(_owner_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only boss can delete owners
  IF NOT is_boss(auth.uid()) THEN
    RETURN false;
  END IF;
  
  -- Delete all cashiers linked to this owner
  DELETE FROM public.user_roles WHERE owner_id = _owner_id;
  
  -- Delete owner's license
  DELETE FROM public.app_licenses WHERE user_id = _owner_id;
  
  -- Delete owner's data (cascade will handle related records)
  DELETE FROM public.products WHERE user_id = _owner_id;
  DELETE FROM public.customers WHERE user_id = _owner_id;
  DELETE FROM public.invoices WHERE user_id = _owner_id;
  DELETE FROM public.debts WHERE user_id = _owner_id;
  DELETE FROM public.expenses WHERE user_id = _owner_id;
  DELETE FROM public.partners WHERE user_id = _owner_id;
  DELETE FROM public.categories WHERE user_id = _owner_id;
  DELETE FROM public.stores WHERE user_id = _owner_id;
  DELETE FROM public.maintenance_services WHERE user_id = _owner_id;
  DELETE FROM public.recurring_expenses WHERE user_id = _owner_id;
  DELETE FROM public.profiles WHERE user_id = _owner_id;
  DELETE FROM public.user_roles WHERE user_id = _owner_id;
  
  RETURN true;
END;
$function$
;
