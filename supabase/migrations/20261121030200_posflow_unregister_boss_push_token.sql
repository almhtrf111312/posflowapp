-- =============================================================================
-- Migration: 20261121030200_posflow_unregister_boss_push_token.sql
-- Rollback:  DROP FUNCTION public.unregister_boss_push_token(text);
--
-- Audit finding: the Boss app never removed the device FCM token from
-- boss_push_tokens on sign-out, so a signed-out device kept receiving customer
-- chat notifications. This adds the missing unregister RPC. A user can only
-- delete their own token. Additive and idempotent.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.unregister_boss_push_token(p_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Access denied: authentication required';
  END IF;
  IF p_token IS NULL OR length(p_token) < 20 THEN
    RETURN;
  END IF;
  -- A user can only remove their own device token (no cross-user deletes).
  DELETE FROM public.boss_push_tokens
   WHERE token = p_token
     AND user_id = auth.uid();
END
$function$;

REVOKE EXECUTE ON FUNCTION public.unregister_boss_push_token(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unregister_boss_push_token(text) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
