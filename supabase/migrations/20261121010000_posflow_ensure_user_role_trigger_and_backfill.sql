-- =============================================================================
-- Migration: 20261121010000_posflow_ensure_user_role_trigger_and_backfill.sql
-- Target DB: PosFlow (bwlqfxfvchjvehnbvwaz)
-- Rollback:  supabase/live-snapshots/rollbacks/ROLLBACK_ensure_user_role_trigger.sql
--
-- Purpose:
--   1. Ensure handle_new_user_role() exists, sets owner_id = NEW.id, and is
--      attached as AFTER INSERT trigger on auth.users so new signups NEVER end
--      up with missing user_roles (which causes role = null -> cashier menus).
--   2. Backfill any existing auth.users missing a user_roles row as 'admin'
--      (only when they have NO row in public.user_roles at all).
--   3. Ensure RLS SELECT policy "Users can view own role" exists on
--      public.user_roles so authenticated users can always read their own role.
--
-- Safety:
--   - Idempotent (safe to re-run).
--   - Does NOT touch any accounting tables, invoices, stock, or existing roles.
-- =============================================================================

BEGIN;

-- 1) Ensure trigger function assigns admin + owner_id safely on direct signup
CREATE OR REPLACE FUNCTION public.handle_new_user_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.id) THEN
    INSERT INTO public.user_roles (user_id, role, owner_id, is_active)
    VALUES (NEW.id, 'admin', NEW.id, true)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- 2) Ensure trigger is attached on auth.users
DROP TRIGGER IF EXISTS on_auth_user_created_role ON auth.users;
CREATE TRIGGER on_auth_user_created_role
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user_role();

-- 3) Backfill any orphaned auth.users who have no role row at all
INSERT INTO public.user_roles (user_id, role, owner_id, is_active)
SELECT u.id, 'admin', u.id, true
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_roles r WHERE r.user_id = u.id
)
ON CONFLICT DO NOTHING;

-- 4) Ensure owner_id is populated for admin/boss rows where owner_id IS NULL
UPDATE public.user_roles
   SET owner_id = user_id
 WHERE role IN ('admin', 'boss')
   AND owner_id IS NULL;

-- 5) Guarantee every authenticated user can read their own role under RLS
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own role" ON public.user_roles;
CREATE POLICY "Users can view own role"
  ON public.user_roles
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

NOTIFY pgrst, 'reload schema';

COMMIT;
