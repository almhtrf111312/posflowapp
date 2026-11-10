-- =========================================================================
-- المرحلة الأولى: إدارة الباقات والتراخيص والرسائل المخصصة
-- 1. إضافة حقول الكاشيرات والرسالة المخصصة لجدول subscription_plans
-- 2. تحديث دالة تأكيد التفعيل confirm_subscription_request لتطبيق قيود الباقة ورسالتها المخصصة
-- =========================================================================

-- 1. التأكد من وجود جدول subscription_plans مع الحقول الأساسية والإضافية
CREATE TABLE IF NOT EXISTS public.subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  audience text NOT NULL DEFAULT 'standard',
  duration_days integer NOT NULL DEFAULT 180,
  price_usd numeric NOT NULL DEFAULT 25,
  max_products integer NOT NULL DEFAULT 600,
  max_cashiers integer NOT NULL DEFAULT 1,
  badge text,
  features text[] DEFAULT '{}',
  activation_message text,
  allow_images_above_limit boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- إضافة حقول الكاشيرات والرسالة المخصصة لجدول الباقات إذا لم تكن موجودة
ALTER TABLE public.subscription_plans 
ADD COLUMN IF NOT EXISTS max_cashiers integer NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS activation_message text;

-- تفعيل RLS لجدول subscription_plans
ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view enabled subscription plans" ON public.subscription_plans;
CREATE POLICY "Anyone can view enabled subscription plans"
ON public.subscription_plans FOR SELECT TO authenticated, anon
USING (enabled = true OR public.is_boss(auth.uid()));

DROP POLICY IF EXISTS "Boss can manage subscription plans" ON public.subscription_plans;
CREATE POLICY "Boss can manage subscription plans"
ON public.subscription_plans FOR ALL TO authenticated
USING (public.is_boss(auth.uid()))
WITH CHECK (public.is_boss(auth.uid()));

-- 2. تحديث دالة تأكيد التفعيل لتطبيق قيود الباقة ورسالتها المخصصة بدقة
CREATE OR REPLACE FUNCTION public.confirm_subscription_request(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_req record;
  v_plan record;
  v_current_license record;
  v_new_expires_at timestamptz;
  v_total_days integer;
  v_max_prod integer;
  v_max_cashiers integer;
  v_custom_msg text;
  v_plan_days integer;
BEGIN
  -- التحقق من صلاحية المدير العام حصراً
  IF NOT public.is_boss(v_admin_id) THEN
    RAISE EXCEPTION 'غير مصرح: هذا الإجراء مخصص لمالك النظام فقط';
  END IF;

  -- جلب وقفل طلب الاشتراك
  SELECT * INTO v_req FROM public.subscription_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'طلب الاشتراك غير موجود';
  END IF;

  IF v_req.status = 'confirmed' THEN
    RAISE EXCEPTION 'هذا الطلب تم تأكيده وتفعيله مسبقاً';
  END IF;

  -- جلب بيانات الباقة المرتبطة لمعرفة القيود والرسالة المخصصة
  SELECT * INTO v_plan FROM public.subscription_plans WHERE id = v_req.plan_id;

  -- عدد الأيام المحدد إما من الباقة أو الطلب أو 180 يوماً كافتراضي
  v_plan_days := COALESCE(v_plan.duration_days, v_req.plan_days, 180);

  -- تحديد القيود إما من الباقة المخزنة أو من قيم الطلب كاحتياطي
  v_max_prod := COALESCE(v_plan.max_products, 
    CASE 
      WHEN v_req.plan_audience = 'institution' THEN 5000
      WHEN v_req.plan_audience = 'pro' THEN 1000
      WHEN v_req.plan_audience = 'standard' THEN 600
      ELSE 100
    END
  );

  v_max_cashiers := COALESCE(v_plan.max_cashiers, 1);
  
  v_custom_msg := COALESCE(
    v_plan.activation_message, 
    'تم تفعيل ' || COALESCE(v_req.plan_name, v_plan.name, 'الاشتراك') || ' بنجاح! شكراً لاشتراكك مع FlowPOS Pro.'
  );

  -- جلب الترخيص الحالي للعميل
  SELECT * INTO v_current_license FROM public.app_licenses WHERE user_id = v_req.user_id FOR UPDATE;

  -- حساب تاريخ الانتهاء الجديد (تمديد على المتبقي إذا لم ينتهِ بعد، أو من الآن)
  IF v_current_license.id IS NOT NULL THEN
    IF v_current_license.expires_at > now() THEN
      v_new_expires_at := v_current_license.expires_at + (v_plan_days || ' days')::interval;
    ELSE
      v_new_expires_at := now() + (v_plan_days || ' days')::interval;
    END IF;

    v_total_days := COALESCE(v_current_license.total_days, 0) + v_plan_days;

    UPDATE public.app_licenses
    SET expires_at = v_new_expires_at,
        is_trial = false,
        is_revoked = false,
        plan_id = v_req.plan_id,
        plan_name = COALESCE(v_req.plan_name, v_plan.name),
        plan_audience = COALESCE(v_req.plan_audience, v_plan.audience, 'standard'),
        license_tier = COALESCE(v_req.plan_audience, v_plan.audience, 'standard'),
        total_days = v_total_days,
        max_products = v_max_prod,
        max_cashiers = v_max_cashiers,
        updated_at = now()
    WHERE id = v_current_license.id;
  ELSE
    v_new_expires_at := now() + (v_plan_days || ' days')::interval;
    INSERT INTO public.app_licenses (
      user_id, expires_at, is_trial, plan_id, plan_name, plan_audience, license_tier, total_days, max_products, max_cashiers
    ) VALUES (
      v_req.user_id, v_new_expires_at, false, v_req.plan_id, COALESCE(v_req.plan_name, v_plan.name), COALESCE(v_req.plan_audience, v_plan.audience, 'standard'), COALESCE(v_req.plan_audience, v_plan.audience, 'standard'), v_plan_days, v_max_prod, v_max_cashiers
    );
  END IF;

  -- تحديث حالة الطلب إلى مؤكد
  UPDATE public.subscription_requests
  SET status = 'confirmed',
      confirmed_by = v_admin_id,
      confirmed_at = now()
  WHERE id = p_request_id;

  -- إرسال الإشعار السحابي الدائم متضمناً رسالة التفعيل المخصصة
  INSERT INTO public.user_notifications (
    user_id, title, message, type, action_url
  ) VALUES (
    v_req.user_id,
    '🎉 تم تفعيل اشتراكك بنجاح!',
    v_custom_msg || ' (صالح حتى: ' || to_char(v_new_expires_at, 'YYYY-MM-DD') || ')',
    'license_renewed',
    '/settings?tab=license'
  );

  RETURN jsonb_build_object(
    'success', true,
    'new_expires_at', v_new_expires_at,
    'total_days', v_total_days,
    'max_products', v_max_prod,
    'max_cashiers', v_max_cashiers
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_subscription_request(uuid) TO authenticated;
