-- =========================================================================
-- FlowPOS Pro — حظر الجهاز (Hardware ID) + تعديل الترخيص من لوحة Boss
-- إضافي فقط وآمن لإعادة التشغيل: لا يحذف ولا يعدّل بيانات موجودة.
--
-- 1. جدول banned_devices: الأجهزة المحظورة (يقرؤه Boss فقط، الكتابة عبر الدوال حصراً)
-- 2. is_device_banned(device_id): يُستدعى قبل تسجيل الدخول (anon) ويرجع true/false فقط
-- 3. boss_ban_user / boss_unban_user: حظر/رفع حظر جهاز حساب المالك
-- 4. boss_update_license: زيادة/إنقاص أيام، وتعديل حد المنتجات والكاشيرات
--
-- التراجع (Rollback):
--   DROP FUNCTION IF EXISTS public.boss_update_license(uuid, integer, integer, integer, text);
--   DROP FUNCTION IF EXISTS public.boss_unban_user(uuid);
--   DROP FUNCTION IF EXISTS public.boss_ban_user(uuid, text);
--   DROP FUNCTION IF EXISTS public.is_device_banned(text);
--   DROP TABLE IF EXISTS public.banned_devices;
-- =========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.banned_devices (
  device_id       text PRIMARY KEY,
  banned_user_id  uuid,
  banned_email    text,
  reason          text,
  banned_by       uuid,
  banned_at       timestamptz NOT NULL DEFAULT now(),
  revoked_license boolean NOT NULL DEFAULT false
);

ALTER TABLE public.banned_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Boss reads banned devices" ON public.banned_devices;
CREATE POLICY "Boss reads banned devices" ON public.banned_devices
  FOR SELECT TO authenticated
  USING (public.is_boss(auth.uid()));
-- لا سياسات INSERT/UPDATE/DELETE عمداً: الكتابة عبر الدوال SECURITY DEFINER فقط.

-- ----- فحص الجهاز قبل تسجيل الدخول (يرجع منطقياً فقط، لا يكشف أي بيانات) -----
CREATE OR REPLACE FUNCTION public.is_device_banned(p_device_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.banned_devices
    WHERE device_id = NULLIF(trim(p_device_id), '')
  );
$$;

REVOKE ALL ON FUNCTION public.is_device_banned(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_device_banned(text) TO anon, authenticated;

-- ----- حظر المستخدم: يحظر رقم جهازه ويوقف ترخيصه -----
CREATE OR REPLACE FUNCTION public.boss_ban_user(p_target_user_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lic    public.app_licenses%ROWTYPE;
  v_email  text;
  v_reason text := NULLIF(trim(COALESCE(p_reason, '')), '');
  v_device text;
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'غير مصرح: هذا الإجراء مخصص للمدير العام فقط');
  END IF;
  IF p_target_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_target_user_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'الحساب غير موجود');
  END IF;
  IF public.is_boss(p_target_user_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'لا يمكن حظر حساب مدير عام');
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_target_user_id AND role::text = 'cashier') THEN
    RETURN jsonb_build_object('success', false, 'error', 'الحظر يُطبَّق على حساب المالك فقط');
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = p_target_user_id;
  SELECT * INTO v_lic FROM public.app_licenses WHERE user_id = p_target_user_id FOR UPDATE;
  v_device := NULLIF(trim(COALESCE(v_lic.device_id, '')), '');

  IF v_device IS NOT NULL THEN
    INSERT INTO public.banned_devices (device_id, banned_user_id, banned_email, reason, banned_by, revoked_license)
    VALUES (v_device, p_target_user_id, v_email, v_reason, auth.uid(), true)
    ON CONFLICT (device_id) DO UPDATE
      SET banned_user_id = EXCLUDED.banned_user_id,
          banned_email   = EXCLUDED.banned_email,
          reason         = EXCLUDED.reason,
          banned_by      = EXCLUDED.banned_by,
          banned_at      = now(),
          revoked_license = true;
  END IF;

  -- إيقاف ترخيص الحساب أيضاً حتى لا يعمل من جهاز آخر
  IF FOUND OR v_lic.user_id IS NOT NULL THEN
    UPDATE public.app_licenses
       SET is_revoked = true,
           revoked_at = now(),
           revoked_reason = 'حظر: ' || COALESCE(v_reason, 'بقرار الإدارة'),
           updated_at = now()
     WHERE user_id = p_target_user_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'device_banned', v_device IS NOT NULL,
    'device_id', v_device,
    'message', CASE WHEN v_device IS NULL
      THEN 'أُوقف الترخيص، لكن لا يوجد رقم جهاز مرتبط بهذا الحساب ليُحظر'
      ELSE 'تم حظر الجهاز وإيقاف الترخيص' END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.boss_ban_user(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.boss_ban_user(uuid, text) TO authenticated;

-- ----- رفع الحظر -----
CREATE OR REPLACE FUNCTION public.boss_unban_user(p_target_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'غير مصرح: هذا الإجراء مخصص للمدير العام فقط');
  END IF;

  DELETE FROM public.banned_devices WHERE banned_user_id = p_target_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- إعادة الترخيص فقط إن كان الإيقاف ناتجاً عن الحظر
  UPDATE public.app_licenses
     SET is_revoked = false, revoked_at = NULL, revoked_reason = NULL, updated_at = now()
   WHERE user_id = p_target_user_id
     AND is_revoked = true
     AND revoked_reason LIKE 'حظر:%';

  RETURN jsonb_build_object('success', true, 'devices_unbanned', v_deleted);
END;
$$;

REVOKE ALL ON FUNCTION public.boss_unban_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.boss_unban_user(uuid) TO authenticated;

-- ----- تعديل الترخيص: أيام (+/-) وحد المنتجات والكاشيرات -----
CREATE OR REPLACE FUNCTION public.boss_update_license(
  p_target_user_id uuid,
  p_add_days       integer DEFAULT 0,
  p_max_products   integer DEFAULT NULL,
  p_max_cashiers   integer DEFAULT NULL,
  p_note           text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lic     public.app_licenses%ROWTYPE;
  v_add     integer := COALESCE(p_add_days, 0);
  v_expires timestamptz;
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'غير مصرح: هذا الإجراء مخصص للمدير العام فقط');
  END IF;
  IF v_add < -3650 OR v_add > 3650 THEN
    RETURN jsonb_build_object('success', false, 'error', 'عدد الأيام خارج المدى المسموح');
  END IF;
  IF p_max_products IS NOT NULL AND (p_max_products < 1 OR p_max_products > 1000000) THEN
    RETURN jsonb_build_object('success', false, 'error', 'حد المنتجات غير صحيح');
  END IF;
  IF p_max_cashiers IS NOT NULL AND (p_max_cashiers < 1 OR p_max_cashiers > 1000) THEN
    RETURN jsonb_build_object('success', false, 'error', 'حد الكاشيرات غير صحيح');
  END IF;

  SELECT * INTO v_lic FROM public.app_licenses WHERE user_id = p_target_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'لا يوجد ترخيص لهذا الحساب. فعّله أولاً ثم عدّل');
  END IF;

  v_expires := v_lic.expires_at;
  IF v_add > 0 THEN
    v_expires := GREATEST(v_lic.expires_at, now()) + make_interval(days => v_add);
  ELSIF v_add < 0 THEN
    v_expires := v_lic.expires_at + make_interval(days => v_add);
  END IF;

  UPDATE public.app_licenses
     SET expires_at   = v_expires,
         total_days   = CASE WHEN v_add > 0 THEN COALESCE(total_days, 0) + v_add ELSE total_days END,
         max_products = COALESCE(p_max_products, max_products),
         max_cashiers = COALESCE(p_max_cashiers, max_cashiers),
         updated_at   = now()
   WHERE id = v_lic.id;

  RETURN jsonb_build_object(
    'success', true,
    'old_expires_at', v_lic.expires_at,
    'new_expires_at', v_expires,
    'max_products', COALESCE(p_max_products, v_lic.max_products),
    'max_cashiers', COALESCE(p_max_cashiers, v_lic.max_cashiers)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.boss_update_license(uuid, integer, integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.boss_update_license(uuid, integer, integer, integer, text) TO authenticated;

COMMIT;
