-- Security audit 2026-11-26, phase 1 (owner-approved):
-- 1) revert_invoice_partner_profits_atomic is an internal helper (called only by the refund RPCs, which run as the definer).
--    Any signed-in user could call it with another store's invoice id and revert that store's partner profits. No client grant.
-- 2) verify_user_pin checked any user's PIN for any caller, with no attempt limit (a 4-digit PIN falls in minutes).
--    Now: only the caller's own PIN, and 5 failed tries lock checks for 15 minutes.
-- 3) REVOKE ... FROM anon had no effect where EXECUTE came from PUBLIC: revoke PUBLIC and grant authenticated explicitly.

REVOKE EXECUTE ON FUNCTION public.revert_invoice_partner_profits_atomic(uuid, numeric, jsonb) FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.pin_verify_attempts (
  user_id uuid PRIMARY KEY,
  failed_count integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pin_verify_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pin_verify_attempts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.verify_user_pin(_user_id uuid, _entered_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  _stored_hash text;
  _att public.pin_verify_attempts%ROWTYPE;
  _ok boolean;
BEGIN
  IF auth.uid() IS NULL OR _user_id IS DISTINCT FROM auth.uid() THEN RETURN false; END IF;
  SELECT * INTO _att FROM public.pin_verify_attempts WHERE user_id = _user_id FOR UPDATE;
  IF FOUND AND _att.window_started_at > now() - interval '15 minutes' AND _att.failed_count >= 5 THEN
    RETURN false;
  END IF;
  SELECT pin_hash INTO _stored_hash FROM public.profiles WHERE user_id = _user_id;
  IF _stored_hash IS NULL THEN RETURN false; END IF;
  _ok := (_stored_hash = crypt(trim(_entered_pin), _stored_hash));
  IF _ok THEN
    DELETE FROM public.pin_verify_attempts WHERE user_id = _user_id;
  ELSE
    INSERT INTO public.pin_verify_attempts(user_id, failed_count, window_started_at) VALUES (_user_id, 1, now())
    ON CONFLICT (user_id) DO UPDATE SET
      failed_count = CASE WHEN pin_verify_attempts.window_started_at > now() - interval '15 minutes' THEN pin_verify_attempts.failed_count + 1 ELSE 1 END,
      window_started_at = CASE WHEN pin_verify_attempts.window_started_at > now() - interval '15 minutes' THEN pin_verify_attempts.window_started_at ELSE now() END;
  END IF;
  RETURN _ok;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.verify_user_pin(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_user_pin(uuid, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.create_manual_debt_atomic(uuid, text, text, text, numeric, date, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_manual_debt_atomic(uuid, text, text, text, numeric, date, text, boolean) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.record_sale_profit_snapshot(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_sale_profit_snapshot(text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public._owner_purge_allowed() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._owner_purge_allowed() TO authenticated, service_role;
