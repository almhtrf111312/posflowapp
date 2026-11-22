-- =============================================================================
-- Rollback for 20261121010000_posflow_ensure_user_role_trigger_and_backfill.sql
-- =============================================================================
-- Note:
--   - Keeping the trigger on_auth_user_created_role and the SELECT policy
--     "Users can view own role" is required for normal authentication.
--   - To revert only handle_new_user_role() to the prior version without owner_id:
CREATE OR REPLACE FUNCTION public.handle_new_user_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.id) THEN
    INSERT INTO public.user_roles (user_id, role, is_active)
    VALUES (NEW.id, 'admin', true);
  END IF;
  RETURN NEW;
END;
$$;
