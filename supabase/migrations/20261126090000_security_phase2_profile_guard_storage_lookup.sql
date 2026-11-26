-- Security audit 2026-11-26, phase 2 (owner-approved):
-- S-4) A user could PATCH their own profile and set allowed_pages / user_type (page access is enforced from these) or pin_hash.
--      Direct writes (role authenticated/anon) may change them only for a boss, or a store admin on their own cashier.
--      SECURITY DEFINER functions (set_user_pin) and Edge Functions (service_role) are not affected.
-- S-8) product-images had no size or type limit: 2 MB, images only (the app uploads ~30 KB WebP/JPEG).
-- S-6) check_phone_email_availability let any signed-in user probe which e-mails exist. E-mail lookup is now for store owners
--      and boss only (they create users); every caller is limited to 30 lookups per 10 minutes. Phone lookup stays for everyone
--      (the unique phone index reveals it on save anyway).

-- SECURITY INVOKER on purpose: current_user is then the caller (authenticated for a REST write, the definer's owner inside a
-- SECURITY DEFINER function such as set_user_pin, service_role in Edge Functions).
CREATE OR REPLACE FUNCTION public.guard_profile_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _privileged boolean;
BEGIN
  -- Only direct client writes are checked; definer functions run as their owner, Edge Functions as service_role.
  IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;
  _privileged := _uid IS NOT NULL AND (
    public.is_boss(_uid)
    OR (public.has_role(_uid, 'admin'::app_role)
        AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = NEW.user_id AND ur.owner_id = _uid)));
  IF TG_OP = 'INSERT' THEN
    IF NOT _privileged AND ((NEW.allowed_pages IS NOT NULL AND jsonb_typeof(NEW.allowed_pages) = 'array' AND jsonb_array_length(NEW.allowed_pages) > 0)
                            OR COALESCE(NEW.user_type, 'cashier') <> 'cashier' OR NEW.pin_hash IS NOT NULL) THEN
      RAISE EXCEPTION 'لا يمكن تعيين الصلاحيات أو رمز PIN مباشرة' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.pin_hash IS DISTINCT FROM OLD.pin_hash THEN
    RAISE EXCEPTION 'رمز PIN يُغيَّر عبر الدالة الآمنة فقط' USING ERRCODE = '42501';
  END IF;
  IF (NEW.allowed_pages IS DISTINCT FROM OLD.allowed_pages OR NEW.user_type IS DISTINCT FROM OLD.user_type) AND NOT _privileged THEN
    RAISE EXCEPTION 'تعديل صلاحيات الصفحات أو نوع المستخدم مخصص لمدير المتجر' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $function$;
REVOKE EXECUTE ON FUNCTION public.guard_profile_privileged_columns() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_guard_profile_privileged_columns ON public.profiles;
CREATE TRIGGER a_guard_profile_privileged_columns
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_privileged_columns();

UPDATE storage.buckets
   SET file_size_limit = 2097152,
       allowed_mime_types = ARRAY['image/webp', 'image/jpeg', 'image/png', 'image/gif']
 WHERE id = 'product-images';

CREATE TABLE IF NOT EXISTS public.rpc_rate_limits (
  user_id uuid NOT NULL,
  bucket text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  calls integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, bucket)
);
ALTER TABLE public.rpc_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rpc_rate_limits FROM PUBLIC, anon, authenticated;

-- Returns false when the caller used more than _max calls of _bucket within _window.
CREATE OR REPLACE FUNCTION public._rpc_rate_ok(_bucket text, _max integer, _window interval)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _calls integer;
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  INSERT INTO public.rpc_rate_limits(user_id, bucket, window_started_at, calls) VALUES (auth.uid(), _bucket, now(), 1)
  ON CONFLICT (user_id, bucket) DO UPDATE SET
    calls = CASE WHEN rpc_rate_limits.window_started_at > now() - _window THEN rpc_rate_limits.calls + 1 ELSE 1 END,
    window_started_at = CASE WHEN rpc_rate_limits.window_started_at > now() - _window THEN rpc_rate_limits.window_started_at ELSE now() END
  RETURNING calls INTO _calls;
  RETURN _calls <= _max;
END $function$;
REVOKE EXECUTE ON FUNCTION public._rpc_rate_ok(text, integer, interval) FROM PUBLIC, anon, authenticated;

ALTER FUNCTION public.check_phone_email_availability(text, text, uuid) RENAME TO check_phone_email_availability__impl;
REVOKE EXECUTE ON FUNCTION public.check_phone_email_availability__impl(text, text, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.check_phone_email_availability(_phone text, _email text, _exclude_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _uid uuid := auth.uid();
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF NOT public._rpc_rate_ok('check_phone_email', 30, interval '10 minutes') THEN
    RAISE EXCEPTION 'محاولات تحقق كثيرة، انتظر قليلاً ثم أعد المحاولة' USING ERRCODE = '42501';
  END IF;
  -- E-mail lookup only for whoever creates users (store owner/admin or boss).
  IF NULLIF(trim(COALESCE(_email, '')), '') IS NOT NULL AND NOT (public.is_store_owner(_uid) OR public.has_role(_uid, 'admin'::app_role)) THEN
    _email := '';
  END IF;
  RETURN public.check_phone_email_availability__impl(_phone, _email, _exclude_user_id);
END $function$;
REVOKE EXECUTE ON FUNCTION public.check_phone_email_availability(text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_phone_email_availability(text, text, uuid) TO authenticated, service_role;
