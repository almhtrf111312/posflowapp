-- Repo sync only (no behaviour change): these objects already exist on the live database exactly as written here, but no file in
-- supabase/migrations created them, so a database rebuilt from the repo differed from live (found by `npm run db:drift-sql`).
-- Non-financial: push-notification tokens and triggers, the push_sent flags, and the live version of boss_activate_license.
-- Every statement is idempotent, so applying this file to the live database changes nothing.

-- Push tokens (devices of users and of the boss).
CREATE TABLE IF NOT EXISTS public.user_push_tokens (
  token text PRIMARY KEY,
  user_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_push_tokens_user_idx ON public.user_push_tokens USING btree (user_id);
ALTER TABLE public.user_push_tokens ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.boss_push_tokens (
  token text PRIMARY KEY,
  user_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.boss_push_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.user_push_tokens FROM anon, authenticated;
REVOKE ALL ON public.boss_push_tokens FROM anon, authenticated;
GRANT ALL ON public.user_push_tokens TO service_role;
GRANT ALL ON public.boss_push_tokens TO service_role;

CREATE OR REPLACE FUNCTION public.register_push_token(p_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if p_token is null or length(p_token) < 20 then raise exception 'invalid token'; end if;
  insert into public.user_push_tokens(token, user_id, updated_at)
  values (p_token, auth.uid(), now())
  on conflict (token) do update set user_id = excluded.user_id, updated_at = now();
end $function$;

CREATE OR REPLACE FUNCTION public.unregister_push_token(p_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then return; end if;
  delete from public.user_push_tokens where token = p_token and user_id = auth.uid();
end $function$;

CREATE OR REPLACE FUNCTION public.register_boss_push_token(p_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null or not public.is_boss(auth.uid()) then
    raise exception 'Access denied: boss role required';
  end if;
  if p_token is null or length(p_token) < 20 then raise exception 'invalid token'; end if;
  insert into public.boss_push_tokens(token, user_id, updated_at)
  values (p_token, auth.uid(), now())
  on conflict (token) do update set user_id = excluded.user_id, updated_at = now();
end $function$;

GRANT EXECUTE ON FUNCTION public.register_push_token(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unregister_push_token(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_boss_push_token(text) TO authenticated, service_role;

-- Push flags and the triggers that send pushes (the trigger functions already exist in the repo).
ALTER TABLE public.app_broadcasts ADD COLUMN IF NOT EXISTS push_sent boolean NOT NULL DEFAULT false;
ALTER TABLE public.support_messages ADD COLUMN IF NOT EXISTS push_sent boolean NOT NULL DEFAULT false;

DROP TRIGGER IF EXISTS trg_push_app_broadcast ON public.app_broadcasts;
CREATE TRIGGER trg_push_app_broadcast AFTER INSERT ON public.app_broadcasts FOR EACH ROW EXECUTE FUNCTION public.push_app_broadcast();
DROP TRIGGER IF EXISTS trg_push_customer_message ON public.support_messages;
CREATE TRIGGER trg_push_customer_message AFTER INSERT ON public.support_messages FOR EACH ROW EXECUTE FUNCTION public.push_customer_message();

-- Live version of boss_activate_license (the repo still had the older body from 20261111010000).
CREATE OR REPLACE FUNCTION public.boss_activate_license(p_target_user_id uuid DEFAULT NULL::uuid, p_plan_id uuid DEFAULT NULL::uuid, p_custom_days integer DEFAULT NULL::integer, p_mode text DEFAULT 'extend'::text, p_request_id uuid DEFAULT NULL::uuid, p_admin_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    v_msg          := 'تم تفعيل ' || v_plan_name || ' بنجاح! شكراً لاشتراكك مع POS Flow App.';
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
$function$;
