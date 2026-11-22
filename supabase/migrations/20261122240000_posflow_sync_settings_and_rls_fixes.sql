-- 1. Deduplicate public.stores (keep most recently updated row per user_id) and enforce UNIQUE (user_id)
DELETE FROM public.stores s
USING (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC) AS rn
  FROM public.stores
) d
WHERE s.id = d.id AND d.rn > 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.stores'::regclass
      AND contype = 'u'
      AND conname = 'stores_user_id_key'
  ) THEN
    ALTER TABLE public.stores ADD CONSTRAINT stores_user_id_key UNIQUE (user_id);
  END IF;
END $$;

-- 2. Align shift settings columns on public.stores and backfill public.store_settings
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS shift_variance_tolerance_usd numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS surplus_as_profit boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.stores'::regclass
      AND conname = 'stores_shift_variance_tolerance_non_negative'
  ) THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_shift_variance_tolerance_non_negative
      CHECK (shift_variance_tolerance_usd >= 0);
  END IF;
END $$;

INSERT INTO public.store_settings (
  user_id, name, store_type, phone, email, address, logo_url,
  primary_currency, exchange_rates, tax_enabled, tax_rate, sync_settings,
  shift_variance_tolerance_usd, surplus_as_profit, created_at, updated_at
)
SELECT
  s.user_id,
  COALESCE(NULLIF(trim(s.name), ''), 'متجري'),
  s.store_type,
  s.phone,
  s.email,
  s.address,
  s.logo_url,
  s.primary_currency,
  s.exchange_rates,
  s.tax_enabled,
  s.tax_rate,
  s.sync_settings,
  COALESCE(s.shift_variance_tolerance_usd, 1),
  COALESCE(s.surplus_as_profit, true),
  COALESCE(s.created_at, now()),
  COALESCE(s.updated_at, now())
FROM public.stores s
ON CONFLICT (user_id) DO UPDATE SET
  name = EXCLUDED.name,
  store_type = EXCLUDED.store_type,
  phone = EXCLUDED.phone,
  email = EXCLUDED.email,
  address = EXCLUDED.address,
  logo_url = EXCLUDED.logo_url,
  primary_currency = EXCLUDED.primary_currency,
  exchange_rates = EXCLUDED.exchange_rates,
  tax_enabled = EXCLUDED.tax_enabled,
  tax_rate = EXCLUDED.tax_rate,
  sync_settings = EXCLUDED.sync_settings,
  shift_variance_tolerance_usd = EXCLUDED.shift_variance_tolerance_usd,
  surplus_as_profit = EXCLUDED.surplus_as_profit,
  updated_at = now();

-- 3. Automatic trigger to keep store_settings synced whenever stores is inserted/updated + updated_at trigger
CREATE OR REPLACE FUNCTION public.set_store_settings_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_store_settings_updated_at ON public.store_settings;
CREATE TRIGGER set_store_settings_updated_at
  BEFORE UPDATE ON public.store_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.set_store_settings_updated_at();

CREATE OR REPLACE FUNCTION public.sync_stores_to_store_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.store_settings (
    user_id, name, store_type, phone, email, address, logo_url,
    primary_currency, exchange_rates, tax_enabled, tax_rate, sync_settings,
    shift_variance_tolerance_usd, surplus_as_profit, updated_at
  )
  VALUES (
    NEW.user_id,
    COALESCE(NULLIF(trim(NEW.name), ''), 'متجري'),
    NEW.store_type,
    NEW.phone,
    NEW.email,
    NEW.address,
    NEW.logo_url,
    NEW.primary_currency,
    NEW.exchange_rates,
    NEW.tax_enabled,
    NEW.tax_rate,
    NEW.sync_settings,
    COALESCE(NEW.shift_variance_tolerance_usd, 1),
    COALESCE(NEW.surplus_as_profit, true),
    now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    name = EXCLUDED.name,
    store_type = EXCLUDED.store_type,
    phone = EXCLUDED.phone,
    email = EXCLUDED.email,
    address = EXCLUDED.address,
    logo_url = EXCLUDED.logo_url,
    primary_currency = EXCLUDED.primary_currency,
    exchange_rates = EXCLUDED.exchange_rates,
    tax_enabled = EXCLUDED.tax_enabled,
    tax_rate = EXCLUDED.tax_rate,
    sync_settings = EXCLUDED.sync_settings,
    shift_variance_tolerance_usd = EXCLUDED.shift_variance_tolerance_usd,
    surplus_as_profit = EXCLUDED.surplus_as_profit,
    updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_stores_to_store_settings ON public.stores;
CREATE TRIGGER trg_sync_stores_to_store_settings
  AFTER INSERT OR UPDATE ON public.stores
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_stores_to_store_settings();

-- 4. Fix RLS on store_settings (support get_owner_id for cashiers + WITH CHECK) and clean duplicate policies
DROP POLICY IF EXISTS "Users own their store settings" ON public.store_settings;
DROP POLICY IF EXISTS "Users manage own store settings" ON public.store_settings;
CREATE POLICY "Users manage own store settings"
  ON public.store_settings
  FOR ALL
  TO authenticated
  USING (user_id = public.get_owner_id((SELECT auth.uid())))
  WITH CHECK (user_id = public.get_owner_id((SELECT auth.uid())));

DROP POLICY IF EXISTS "Users can update their own store" ON public.stores;
DROP POLICY IF EXISTS "Store isolation debts" ON public.debts;

DROP POLICY IF EXISTS "Owners only view partners" ON public.partners;
DROP POLICY IF EXISTS "Owners can view partners" ON public.partners;
DROP POLICY IF EXISTS "Owners can update partners" ON public.partners;
DROP POLICY IF EXISTS "Owners can insert partners" ON public.partners;
DROP POLICY IF EXISTS "Owners can delete partners" ON public.partners;

-- 5. Fix check_store_phone_status bigint trim bug (telegram_chat_id is bigint)
CREATE OR REPLACE FUNCTION public.check_store_phone_status(_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
    _caller UUID := auth.uid();
    _normalized_phone TEXT;
    _current_user_phone TEXT;
    _existing_profile RECORD;
BEGIN
    IF _caller IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'يجب تسجيل الدخول أولاً');
    END IF;

    IF _phone IS NULL OR trim(_phone) = '' THEN
        RETURN jsonb_build_object(
            'ok', true,
            'status', 'empty',
            'normalized_phone', NULL
        );
    END IF;

    _normalized_phone := public.normalize_phone_number(_phone);

    SELECT phone INTO _current_user_phone
    FROM public.profiles
    WHERE user_id = _caller;

    IF _current_user_phone IS NOT NULL AND _current_user_phone = _normalized_phone THEN
        RETURN jsonb_build_object(
            'ok', true,
            'status', 'same_user',
            'normalized_phone', _normalized_phone,
            'message', 'الرقم مطابق لرقم حسابك الحالي'
        );
    END IF;

    SELECT user_id, full_name, telegram_chat_id INTO _existing_profile
    FROM public.profiles
    WHERE phone = _normalized_phone
      AND user_id <> _caller
    LIMIT 1;

    IF _existing_profile.user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', true,
            'status', 'available',
            'normalized_phone', _normalized_phone,
            'message', 'الرقم متاح ويتطلب تأكيد كلمة مرور الحساب لحفظه كافتراضي'
        );
    END IF;

    IF _existing_profile.telegram_chat_id IS NOT NULL AND trim(_existing_profile.telegram_chat_id::text) <> '' THEN
        RETURN jsonb_build_object(
            'ok', true,
            'status', 'requires_telegram_verification',
            'normalized_phone', _normalized_phone,
            'has_telegram', true,
            'message', 'الرقم مرتبط بحساب آخر، يلزم تأكيد النقل عبر رمز يصل لبوت Telegram للحساب الأصلي'
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', false,
        'status', 'conflict_no_telegram',
        'normalized_phone', _normalized_phone,
        'has_telegram', false,
        'error', 'هذا الرقم مرتبط بحساب مستخدم آخر وغير مفعل لديه التيليجرام لنقل الملكية. تواصل مع الدعم الفني.'
    );
END;
$function$;

-- 6. Fix issue_offline_lease 400 error blocked by prevent_license_self_upgrade on last_lease_issued_at
CREATE OR REPLACE FUNCTION public.prevent_license_self_upgrade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_internal_lease boolean := (current_setting('app.internal_lease_issue', true) = '1');
BEGIN
  IF auth.uid() IS NULL OR current_setting('role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF public.is_boss(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF NEW.expires_at           IS DISTINCT FROM OLD.expires_at
  OR NEW.is_revoked           IS DISTINCT FROM OLD.is_revoked
  OR NEW.license_tier         IS DISTINCT FROM OLD.license_tier
  OR NEW.max_cashiers         IS DISTINCT FROM OLD.max_cashiers
  OR NEW.allow_multi_device   IS DISTINCT FROM OLD.allow_multi_device
  OR NEW.is_trial             IS DISTINCT FROM OLD.is_trial
  OR NEW.activation_code_id   IS DISTINCT FROM OLD.activation_code_id
  OR NEW.user_id              IS DISTINCT FROM OLD.user_id
  OR NEW.max_offline_days     IS DISTINCT FROM OLD.max_offline_days
  OR NEW.max_offline_invoices IS DISTINCT FROM OLD.max_offline_invoices
  OR NEW.device_reset_count   IS DISTINCT FROM OLD.device_reset_count
  OR NEW.offline_lease_secret IS DISTINCT FROM OLD.offline_lease_secret
  OR NEW.activated_at         IS DISTINCT FROM OLD.activated_at
  OR NEW.current_cashiers     IS DISTINCT FROM OLD.current_cashiers
  OR NEW.max_products         IS DISTINCT FROM OLD.max_products
  OR NEW.total_days           IS DISTINCT FROM OLD.total_days
  OR NEW.plan_id              IS DISTINCT FROM OLD.plan_id
  OR NEW.plan_name            IS DISTINCT FROM OLD.plan_name
  OR NEW.plan_audience        IS DISTINCT FROM OLD.plan_audience
  OR NEW.revoked_at           IS DISTINCT FROM OLD.revoked_at
  OR NEW.revoked_reason       IS DISTINCT FROM OLD.revoked_reason
  OR NEW.bound_device_id      IS DISTINCT FROM OLD.bound_device_id
  OR NEW.last_reset_at        IS DISTINCT FROM OLD.last_reset_at
  OR NEW.last_device_reset_at IS DISTINCT FROM OLD.last_device_reset_at
  OR (NOT v_internal_lease AND NEW.last_lease_issued_at IS DISTINCT FROM OLD.last_lease_issued_at)
  OR NEW.license_key          IS DISTINCT FROM OLD.license_key
  OR (
    OLD.device_id IS NOT NULL
    AND NEW.device_id IS DISTINCT FROM OLD.device_id
    AND NOT (
      NEW.device_id IS NOT NULL
      AND OLD.device_id NOT LIKE 'CAP-%'
      AND NEW.device_id LIKE 'CAP-%'
    )
  )
  THEN
    RAISE EXCEPTION 'انتهاك أمني: غير مصرح لك بتعديل بيانات أو حدود ترخيص النظام';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.issue_offline_lease(p_device_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'extensions'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_owner_id uuid;
  v_license record;
  v_expires_at timestamptz;
  v_valid_until_epoch bigint;
  v_payload text;
  v_secret text;
  v_signature text;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Unauthorized: User not authenticated'; END IF;
  v_owner_id := public.get_owner_id(v_user_id);
  SELECT * INTO v_license FROM public.app_licenses WHERE user_id = v_owner_id AND (is_revoked IS FALSE OR is_revoked IS NULL) LIMIT 1;
  IF v_license IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'NO_ACTIVE_LICENSE'); END IF;
  IF v_license.device_id IS NOT NULL AND v_license.allow_multi_device IS NOT TRUE AND v_license.device_id <> p_device_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'DEVICE_MISMATCH');
  END IF;
  v_expires_at := LEAST(v_license.expires_at, now() + (COALESCE(v_license.max_offline_days, 15) || ' days')::interval);
  v_valid_until_epoch := EXTRACT(EPOCH FROM v_expires_at)::bigint;
  v_secret := COALESCE(v_license.offline_lease_secret, 'FLOWPOS_PRO_FALLBACK_SALT_2026');
  v_payload := v_license.id || ':' || p_device_id || ':' || v_valid_until_epoch || ':' || COALESCE(v_license.max_offline_invoices, 100);
  v_signature := encode(sha256((v_payload || ':' || v_secret)::bytea), 'hex');
  PERFORM set_config('app.internal_lease_issue', '1', true);
  UPDATE public.app_licenses SET last_lease_issued_at = now() WHERE id = v_license.id;
  RETURN jsonb_build_object('success', true, 'license_id', v_license.id, 'device_id', p_device_id, 'valid_until_epoch', v_valid_until_epoch,
    'max_offline_invoices', COALESCE(v_license.max_offline_invoices, 100), 'signature', v_signature, 'issued_at_epoch', EXTRACT(EPOCH FROM now())::bigint);
END;
$function$;
