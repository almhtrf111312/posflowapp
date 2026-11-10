-- =========================================================================
-- دالة التفعيل المباشر لأي حساب عبر اختيار باقة مسبقة من لوحة المدير
-- =========================================================================
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
DECLARE
  v_caller_id uuid := auth.uid();
  v_plan record;
  v_current_license record;
  v_duration_days integer;
  v_max_prod integer;
  v_max_cashiers integer;
  v_plan_name text;
  v_plan_tier text;
  v_custom_msg text;
  v_new_expires_at timestamptz;
BEGIN
  -- 1. التحقق من صلاحية المدير العام (Boss) حصراً
  IF NOT public.is_boss(v_caller_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'غير مصرح: هذا الإجراء مخصص للمدير العام فقط');
  END IF;

  -- 2. تحديد تفاصيل الباقة أو القيم اليدوية
  IF p_plan_id IS NOT NULL THEN
    SELECT * INTO v_plan FROM public.subscription_plans WHERE id = p_plan_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'الباقة المختارة غير موجودة');
    END IF;

    v_duration_days := COALESCE(v_plan.duration_days, 180);
    v_max_prod      := COALESCE(v_plan.max_products, 600);
    v_max_cashiers  := COALESCE(v_plan.max_cashiers, 1);
    v_plan_name     := v_plan.name;
    v_plan_tier     := COALESCE(v_plan.audience, 'standard');
    v_custom_msg    := COALESCE(v_plan.activation_message, 'تم تفعيل باقة ' || v_plan.name || ' لحسابك بنجاح!');
  ELSE
    -- تفعيل حر بعدد أيام مخصص
    v_duration_days := COALESCE(p_custom_days, 90);
    v_max_prod      := 600;
    v_max_cashiers  := 1;
    v_plan_name     := 'تفعيل مباشر مخصص (' || v_duration_days || ' يوم)';
    v_plan_tier     := 'standard';
    v_custom_msg    := 'تم تمديد ترخيص حسابك لمدة ' || v_duration_days || ' يوم بنجاح!';
  END IF;

  -- 3. جلب الترخيص الحالي للعميل لحساب تاريخ الانتهاء (تمديد أو بداية جديدة)
  SELECT * INTO v_current_license FROM public.app_licenses WHERE user_id = p_target_user_id FOR UPDATE;

  IF v_current_license.id IS NOT NULL THEN
    IF v_current_license.expires_at > now() THEN
      v_new_expires_at := v_current_license.expires_at + (v_duration_days || ' days')::interval;
    ELSE
      v_new_expires_at := now() + (v_duration_days || ' days')::interval;
    END IF;

    UPDATE public.app_licenses
    SET expires_at   = v_new_expires_at,
        is_trial     = false,
        is_revoked   = false,
        plan_id      = p_plan_id,
        plan_name    = v_plan_name,
        plan_audience= v_plan_tier,
        license_tier = v_plan_tier,
        max_products = v_max_prod,
        max_cashiers = v_max_cashiers,
        total_days   = COALESCE(total_days, 0) + v_duration_days,
        activated_at = now(),
        updated_at   = now()
    WHERE id = v_current_license.id;
  ELSE
    v_new_expires_at := now() + (v_duration_days || ' days')::interval;

    INSERT INTO public.app_licenses (
      user_id, expires_at, is_trial, is_revoked, plan_id, plan_name,
      plan_audience, license_tier, max_products, max_cashiers, total_days, activated_at
    ) VALUES (
      p_target_user_id, v_new_expires_at, false, false, p_plan_id, v_plan_name,
      v_plan_tier, v_plan_tier, v_max_prod, v_max_cashiers, v_duration_days, now()
    );
  END IF;

  -- 4. إرسال إشعار للمستخدم في حسابه
  INSERT INTO public.user_notifications (
    user_id, title, message, type, action_url
  ) VALUES (
    p_target_user_id,
    '🎉 تم تفعيل باقة الاشتراك!',
    v_custom_msg || ' (صالح حتى: ' || to_char(v_new_expires_at, 'YYYY-MM-DD') || ')',
    'license',
    '/settings'
  );

  RETURN jsonb_build_object(
    'success', true,
    'expires_at', v_new_expires_at,
    'plan_name', v_plan_name,
    'duration_days', v_duration_days,
    'max_products', v_max_prod,
    'max_cashiers', v_max_cashiers
  );
END;
$$;
