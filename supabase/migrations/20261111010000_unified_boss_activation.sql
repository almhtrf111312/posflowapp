-- =========================================================================
-- FlowPOS Pro — توحيد تفعيل التراخيص من لوحة المالك (Boss) + إصلاح الإشعارات
-- آمن لإعادة التشغيل أكثر من مرة. لا يحذف أي جدول أو عمود أو بيانات.
--
-- 1. دالة واحدة شاملة للتفعيل: boss_activate_license
--    (باقة أو أيام مخصصة، إضافة على التاريخ الحالي أو بدء من اليوم، وربط اختياري بطلب تجديد)
-- 2. الدوال الثلاث القديمة تبقى بأسمائها وتستدعي الدالة الجديدة (توافق مع النسخ المثبتة)
-- 3. إشعار للمالك (Boss) عند وصول أي طلب تجديد جديد
-- 4. السماح بتعليم رسائل الدعم "مقروءة / تم التنبيه" (كان التحديث مرفوضاً بصمت)
-- 5. إسكات تنبيهات رسائل الدعم القديمة المتراكمة
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- 1. الدالة الموحدة للتفعيل
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.boss_activate_license(
  p_target_user_id uuid    DEFAULT NULL,
  p_plan_id        uuid    DEFAULT NULL,
  p_custom_days    integer DEFAULT NULL,
  p_mode           text    DEFAULT 'extend',   -- 'extend' = إضافة على التاريخ الحالي | 'reset' = بدء من اليوم
  p_request_id     uuid    DEFAULT NULL,
  p_admin_note     text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller        uuid := auth.uid();
  v_mode          text := lower(trim(COALESCE(p_mode, 'extend')));
  v_req           public.subscription_requests%ROWTYPE;
  v_has_req       boolean := false;
  v_plan          public.subscription_plans%ROWTYPE;
  v_has_plan      boolean := false;
  v_lic           public.app_licenses%ROWTYPE;
  v_has_lic       boolean := false;
  v_target        uuid := p_target_user_id;
  v_requester     uuid;
  v_owner         uuid;
  v_plan_id       uuid := p_plan_id;
  v_days          integer;
  v_max_prod      integer;
  v_max_cashiers  integer;
  v_plan_name     text;
  v_audience      text;
  v_msg           text;
  v_old_expires   timestamptz;
  v_new_expires   timestamptz;
  v_total_days    integer;
BEGIN
  -- أ) الصلاحية: المالك (Boss) حصراً
  IF NOT public.is_boss(v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error', 'غير مصرح: هذا الإجراء مخصص للمدير العام فقط');
  END IF;

  IF v_mode NOT IN ('extend', 'reset') THEN
    RETURN jsonb_build_object('success', false, 'error', 'طريقة التفعيل غير صحيحة (extend أو reset)');
  END IF;

  -- ب) طلب التجديد (اختياري): قفل السجل ومنع التأكيد المكرر
  IF p_request_id IS NOT NULL THEN
    SELECT * INTO v_req FROM public.subscription_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'طلب الاشتراك غير موجود');
    END IF;
    IF v_req.status IN ('confirmed', 'approved') THEN
      RETURN jsonb_build_object('success', false, 'error', 'هذا الطلب تم تأكيده وتفعيله مسبقاً');
    END IF;
    v_has_req   := true;
    v_requester := v_req.user_id;
    v_target    := COALESCE(v_target, v_req.user_id);
    -- إن لم يحدد المالك باقة أو أياماً، تُستخدم باقة الطلب نفسه
    IF v_plan_id IS NULL AND p_custom_days IS NULL THEN
      v_plan_id := v_req.plan_id;
    END IF;
  END IF;

  IF v_target IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'لم يتم تحديد الحساب المطلوب تفعيله');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_target) THEN
    RETURN jsonb_build_object('success', false, 'error', 'الحساب المطلوب تفعيله غير موجود');
  END IF;

  -- ج) الترخيص يُسجَّل على صاحب المتجر: إن كان الحساب كاشيراً نفعّل مالكه
  SELECT ur.owner_id INTO v_owner
  FROM public.user_roles ur
  WHERE ur.user_id = v_target AND ur.role::text = 'cashier' AND ur.owner_id IS NOT NULL
  LIMIT 1;
  IF v_owner IS NOT NULL THEN
    v_target := v_owner;
  END IF;

  -- د) الترخيص الحالي (مع القفل)
  SELECT * INTO v_lic FROM public.app_licenses WHERE user_id = v_target FOR UPDATE;
  v_has_lic := FOUND;
  IF v_has_lic THEN
    v_old_expires := v_lic.expires_at;
  END IF;

  -- هـ) الباقة
  IF v_plan_id IS NOT NULL THEN
    SELECT * INTO v_plan FROM public.subscription_plans WHERE id = v_plan_id;
    v_has_plan := FOUND;
    IF NOT v_has_plan AND NOT v_has_req THEN
      RETURN jsonb_build_object('success', false, 'error', 'الباقة المختارة غير موجودة');
    END IF;
  END IF;

  -- و) المدة والحدود
  IF v_has_plan THEN
    -- باقة جاهزة: تُطبَّق مدتها وحدودها كاملة
    v_days         := COALESCE(p_custom_days, v_plan.duration_days, 180);
    v_max_prod     := COALESCE(v_plan.max_products, 600);
    v_max_cashiers := COALESCE(v_plan.max_cashiers, 1);
    v_plan_name    := v_plan.name;
    v_audience     := COALESCE(v_plan.audience, 'standard');
    v_msg          := COALESCE(NULLIF(trim(v_plan.activation_message), ''),
                               'تم تفعيل باقة ' || v_plan.name || ' لحسابك بنجاح!');
  ELSIF v_has_req AND p_custom_days IS NULL THEN
    -- طلب تجديد بباقة افتراضية غير مخزنة: نعتمد بيانات الطلب نفسه
    v_days         := COALESCE(v_req.plan_days, 180);
    v_audience     := COALESCE(v_req.plan_audience, 'standard');
    v_plan_name    := COALESCE(v_req.plan_name, 'اشتراك');
    v_max_prod     := CASE v_audience
                        WHEN 'institution' THEN 5000
                        WHEN 'pro'         THEN 1000
                        WHEN 'standard'    THEN 600
                        ELSE 100
                      END;
    v_max_cashiers := COALESCE(v_lic.max_cashiers, 1);
    v_msg          := 'تم تفعيل ' || v_plan_name || ' بنجاح! شكراً لاشتراكك مع FlowPOS Pro.';
  ELSE
    -- أيام مخصصة بدون باقة: نحافظ على حدود واسم باقة العميل الحالية ولا نغيّرها
    v_days         := p_custom_days;
    v_max_prod     := COALESCE(v_lic.max_products, 600);
    v_max_cashiers := COALESCE(v_lic.max_cashiers, 1);
    v_audience     := COALESCE(v_lic.plan_audience, v_lic.license_tier, 'standard');
    v_plan_name    := COALESCE(v_lic.plan_name, 'تفعيل مباشر مخصص');
    v_plan_id      := v_lic.plan_id;
    v_msg          := 'تم تفعيل ترخيص حسابك لمدة ' || COALESCE(v_days, 0) || ' يوم بنجاح!';
  END IF;

  IF v_days IS NULL OR v_days < 1 OR v_days > 3650 THEN
    RETURN jsonb_build_object('success', false, 'error', 'عدد الأيام غير صحيح (بين 1 و 3650)');
  END IF;

  -- ز) تاريخ الانتهاء الجديد
  IF v_mode = 'extend' AND v_old_expires IS NOT NULL AND v_old_expires > now() THEN
    v_new_expires := v_old_expires + make_interval(days => v_days);
  ELSE
    v_new_expires := now() + make_interval(days => v_days);
  END IF;
  -- إجمالي مدة الاشتراك من اليوم حتى الانتهاء (يُستخدم لشريط المدة المتبقية في الإعدادات)
  v_total_days := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_new_expires - now())) / 86400.0)::integer);

  -- ح) كتابة الترخيص (سجل واحد لكل مستخدم)
  IF v_has_lic THEN
    UPDATE public.app_licenses
    SET expires_at     = v_new_expires,
        is_trial       = false,
        is_revoked     = false,
        revoked_at     = NULL,
        revoked_reason = NULL,
        plan_id        = v_plan_id,
        plan_name      = v_plan_name,
        plan_audience  = v_audience,
        license_tier   = v_audience,
        max_products   = v_max_prod,
        max_cashiers   = v_max_cashiers,
        total_days     = v_total_days,
        activated_at   = now(),
        updated_at     = now()
    WHERE id = v_lic.id;
  ELSE
    INSERT INTO public.app_licenses (
      user_id, expires_at, is_trial, is_revoked, plan_id, plan_name,
      plan_audience, license_tier, max_products, max_cashiers, total_days, activated_at
    ) VALUES (
      v_target, v_new_expires, false, false, v_plan_id, v_plan_name,
      v_audience, v_audience, v_max_prod, v_max_cashiers, v_total_days, now()
    );
  END IF;

  -- ط) إغلاق طلب التجديد
  IF v_has_req THEN
    UPDATE public.subscription_requests
    SET status       = 'confirmed',
        confirmed_by = v_caller,
        confirmed_at = now(),
        admin_note   = COALESCE(p_admin_note, admin_note)
    WHERE id = p_request_id;
  END IF;

  -- ي) إشعار العميل (صاحب المتجر، ومقدّم الطلب إن كان حساباً آخر)
  INSERT INTO public.user_notifications (user_id, title, message, type, action_url, is_read, is_archived)
  SELECT u, '🎉 تم تفعيل اشتراكك بنجاح!',
         v_msg || ' (صالح حتى: ' || to_char(v_new_expires, 'YYYY-MM-DD') || ')',
         'license_renewed', '/settings?tab=license', false, false
  FROM (SELECT v_target AS u
        UNION
        SELECT v_requester WHERE v_requester IS NOT NULL) t;

  RETURN jsonb_build_object(
    'success',             true,
    'mode',                v_mode,
    'target_user_id',      v_target,
    'previous_expires_at', v_old_expires,
    'expires_at',          v_new_expires,
    'new_expires_at',      v_new_expires,
    'plan_name',           v_plan_name,
    'duration_days',       v_days,
    'total_days',          v_total_days,
    'max_products',        v_max_prod,
    'max_cashiers',        v_max_cashiers
  );
END;
$$;

REVOKE ALL ON FUNCTION public.boss_activate_license(uuid, uuid, integer, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.boss_activate_license(uuid, uuid, integer, text, uuid, text) TO authenticated;

-- -------------------------------------------------------------------------
-- 2. الدوال القديمة: نفس الأسماء والمعاملات، لكنها تستدعي الدالة الموحدة
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.boss_direct_activate_by_plan(
  p_target_user_id uuid,
  p_plan_id uuid DEFAULT NULL,
  p_custom_days integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.boss_activate_license(
    p_target_user_id, p_plan_id,
    CASE WHEN p_plan_id IS NULL THEN COALESCE(p_custom_days, 90) ELSE NULL END,
    'extend', NULL, NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_subscription_request_atomic(
  p_request_id uuid,
  p_admin_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.boss_activate_license(NULL, NULL, NULL, 'extend', p_request_id, p_admin_note);
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_subscription_request(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.boss_activate_license(NULL, NULL, NULL, 'extend', p_request_id, NULL);
  IF NOT COALESCE((v_result->>'success')::boolean, false) THEN
    RAISE EXCEPTION '%', COALESCE(v_result->>'error', 'فشل تأكيد الطلب');
  END IF;
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.boss_direct_activate_by_plan(uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_subscription_request_atomic(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_subscription_request(uuid) TO authenticated;

-- -------------------------------------------------------------------------
-- 3. إشعار المالك (Boss) عند وصول طلب تجديد جديد
--    النقر على الإشعار يفتح حساب المتجر وواجهة التفعيل: /boss?request=<id>
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_boss_on_subscription_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    INSERT INTO public.user_notifications (user_id, title, message, type, action_url, metadata, is_read, is_archived)
    SELECT DISTINCT ur.user_id,
           '🧾 طلب تجديد اشتراك جديد',
           COALESCE(NEW.payer_name, 'عميل') || ' — ' || COALESCE(NEW.plan_name, 'باقة')
             || COALESCE(' ($' || NEW.price_usd::text || ')', '')
             || ' — مرجع: ' || COALESCE(NEW.ref_code, '-'),
           'subscription_request',
           '/boss?request=' || NEW.id::text,
           jsonb_build_object('request_id', NEW.id, 'requester_id', NEW.user_id),
           false, false
    FROM public.user_roles ur
    WHERE ur.role::text = 'boss';
  EXCEPTION WHEN OTHERS THEN
    -- لا نمنع حفظ طلب العميل بسبب فشل الإشعار
    NULL;
  END;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_boss_on_subscription_request() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_notify_boss_subscription_request ON public.subscription_requests;
CREATE TRIGGER trg_notify_boss_subscription_request
AFTER INSERT ON public.subscription_requests
FOR EACH ROW
EXECUTE FUNCTION public.notify_boss_on_subscription_request();

-- وصول الإشعارات فورياً للتطبيق المفتوح (Realtime)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'user_notifications'
     )
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_notifications;
  END IF;
END $$;

-- -------------------------------------------------------------------------
-- 4. رسائل الدعم: السماح بتعليمها "مقروءة" و"تم التنبيه" فقط
--    (لم تكن هناك سياسة UPDATE، فكانت الشارة والتنبيهات تتكرر بلا نهاية)
-- -------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users and boss update support messages" ON public.support_messages;
CREATE POLICY "Users and boss update support messages"
ON public.support_messages FOR UPDATE TO authenticated
USING (
  public.is_boss(auth.uid())
  OR EXISTS (
    SELECT 1 FROM public.support_conversations c
    WHERE c.id = support_messages.conversation_id
      AND (c.user_id = auth.uid() OR c.owner_id = public.get_owner_id(auth.uid()))
  )
)
WITH CHECK (
  public.is_boss(auth.uid())
  OR EXISTS (
    SELECT 1 FROM public.support_conversations c
    WHERE c.id = support_messages.conversation_id
      AND (c.user_id = auth.uid() OR c.owner_id = public.get_owner_id(auth.uid()))
  )
);

-- التعديل مسموح على عمودَي الحالة فقط، لا على نص الرسالة أو مرسلها
REVOKE UPDATE ON public.support_messages FROM authenticated;
GRANT UPDATE (is_read, notified_native) ON public.support_messages TO authenticated;

-- -------------------------------------------------------------------------
-- 5. إسكات تنبيهات الرسائل القديمة المتراكمة (لا يغيّر حالة "مقروءة")
-- -------------------------------------------------------------------------
UPDATE public.support_messages
SET notified_native = true
WHERE notified_native IS DISTINCT FROM true
  AND created_at < now() - interval '5 minutes';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- نتيجة التحقق (تظهر بعد التنفيذ)
SELECT
  to_regprocedure('public.boss_activate_license(uuid,uuid,integer,text,uuid,text)') IS NOT NULL AS unified_function_ready,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_boss_subscription_request') AS boss_request_trigger_ready,
  EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'support_messages' AND cmd = 'UPDATE') AS support_update_policy_ready;
