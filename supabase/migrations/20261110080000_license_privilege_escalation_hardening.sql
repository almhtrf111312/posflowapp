-- =====================================================================
-- خطة الإصلاح الأمني - المرحلة الثانية: إغلاق ثغرات التراخيص والاشتراكات
-- =====================================================================

-- 1. ترقيع محفز منع الترقية الذاتية في app_licenses وحماية كافة الأعمدة الحساسة
CREATE OR REPLACE FUNCTION public.prevent_license_self_upgrade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- يُسمح فقط للسيرفر الموثوق (Service Role) أو للمدير العام (Boss) بتعديل بيانات الترخيص
  IF auth.uid() IS NULL OR current_setting('role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF public.is_boss(auth.uid()) THEN
    RETURN NEW;
  END IF;

  -- منع المستخدم العادي من تعديل أي حقل من حقول الباقة والترخيص:
  -- يُسمح له فقط بتحديث معرف جهازه (device_id) في الحالات المسموح بها نظامياً
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
  THEN
    RAISE EXCEPTION 'انتهاك أمني: غير مصرح لك بتعديل بيانات أو حدود ترخيص النظام';
  END IF;

  RETURN NEW;
END;
$$;

-- التأكد من ربط التريجر بجدول التراخيص
DROP TRIGGER IF EXISTS trg_prevent_license_self_upgrade ON public.app_licenses;
CREATE TRIGGER trg_prevent_license_self_upgrade
BEFORE UPDATE ON public.app_licenses
FOR EACH ROW
EXECUTE FUNCTION public.prevent_license_self_upgrade();

-- 2. إغلاق ثغرة الموافقة الذاتية في subscription_requests
-- حذف السياسة القديمة التي كانت تمنح صلاحية تعديل عامة
DROP POLICY IF EXISTS "Users update own pending requests" ON public.subscription_requests;
DROP POLICY IF EXISTS "Users manage own requests" ON public.subscription_requests;
DROP POLICY IF EXISTS "Users create requests" ON public.subscription_requests;
DROP POLICY IF EXISTS "Users read own requests" ON public.subscription_requests;
DROP POLICY IF EXISTS "Users update own pending proof only" ON public.subscription_requests;
DROP POLICY IF EXISTS "Boss manage all subscription requests" ON public.subscription_requests;

-- أ) إنشاء الطلب: للمستخدم نفسه فقط مع فرض حالة 'pending' إجبارياً
CREATE POLICY "Users create requests"
ON public.subscription_requests FOR INSERT TO authenticated
WITH CHECK (
  user_id = auth.uid() 
  AND (status IS NULL OR status = 'pending' OR status = 'paid_claimed')
  AND confirmed_by IS NULL
  AND confirmed_at IS NULL
);

-- ب) قراءة الطلبات: المستخدم يقرأ طلباته الخاصة، والمدير العام يقرأ كافة الطلبات
CREATE POLICY "Users read own requests"
ON public.subscription_requests FOR SELECT TO authenticated
USING (user_id = auth.uid() OR public.is_boss(auth.uid()));

-- ج) تحديث الطلب من قِبل المستخدم: يُسمح له فقط بتعديل إثبات الدفع واسم المحول طالما أن الطلب قيد الانتظار
CREATE POLICY "Users update own pending proof only"
ON public.subscription_requests FOR UPDATE TO authenticated
USING (user_id = auth.uid() AND (status = 'pending' OR status = 'paid_claimed'))
WITH CHECK (
  user_id = auth.uid() 
  AND (status = 'pending' OR status = 'paid_claimed') 
  AND confirmed_by IS NULL 
  AND confirmed_at IS NULL
);

-- د) اعتماد أو رفض الطلبات: محصور حصرياً بالمدير العام (Boss)
CREATE POLICY "Boss manage all subscription requests"
ON public.subscription_requests FOR ALL TO authenticated
USING (public.is_boss(auth.uid()))
WITH CHECK (public.is_boss(auth.uid()));

-- 3. دالة ذرية لاعتماد الطلب وترقية الحساب وتاريخ الانتهاء بواسطة البوس حصراً
CREATE OR REPLACE FUNCTION public.approve_subscription_request_atomic(
  p_request_id uuid,
  p_admin_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req record;
  v_caller uuid := auth.uid();
  v_new_expires timestamptz;
  v_current_expires timestamptz;
  v_plan record;
BEGIN
  -- التحقق من صلاحية البوس
  IF NOT public.is_boss(v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error', 'غير مصرح: هذه العملية مخصصة للمدير العام فقط');
  END IF;

  -- قفل السجل لمنع أي تكرار
  SELECT * INTO v_req 
  FROM public.subscription_requests 
  WHERE id = p_request_id 
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'طلب الاشتراك غير موجود');
  END IF;

  IF v_req.status = 'approved' OR v_req.status = 'confirmed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'تم اعتماد هذا الطلب مسبقاً');
  END IF;

  -- جلب بيانات الباقة لمعرفة المدة والحدود
  SELECT * INTO v_plan FROM public.subscription_plans WHERE id = v_req.plan_id;

  -- جلب تاريخ الانتهاء الحالي
  SELECT expires_at INTO v_current_expires FROM public.app_licenses WHERE user_id = v_req.user_id;

  -- إذا كان الاشتراك سارياً، يتم التمديد عليه، وإن كان منتهياً يبدأ من الآن
  IF v_current_expires IS NOT NULL AND v_current_expires > now() THEN
    v_new_expires := v_current_expires + (COALESCE(v_req.plan_days, v_plan.duration_days, 30) || ' days')::interval;
  ELSE
    v_new_expires := now() + (COALESCE(v_req.plan_days, v_plan.duration_days, 30) || ' days')::interval;
  END IF;

  -- تحديث ترخيص المستخدم
  INSERT INTO public.app_licenses (
    user_id, activated_at, expires_at, is_trial, is_revoked,
    license_tier, max_cashiers, max_products, total_days, plan_id, plan_name
  ) VALUES (
    v_req.user_id, now(), v_new_expires, false, false,
    COALESCE(v_plan.tier_code, 'pro'),
    COALESCE(v_plan.max_cashiers, 1),
    COALESCE(v_plan.max_products, 1000),
    COALESCE(v_req.plan_days, v_plan.duration_days, 30),
    v_req.plan_id, v_req.plan_name
  )
  ON CONFLICT (user_id) DO UPDATE SET
    expires_at = v_new_expires,
    is_trial = false,
    is_revoked = false,
    license_tier = COALESCE(v_plan.tier_code, EXCLUDED.license_tier),
    max_cashiers = COALESCE(v_plan.max_cashiers, EXCLUDED.max_cashiers),
    max_products = COALESCE(v_plan.max_products, EXCLUDED.max_products),
    total_days = COALESCE(v_req.plan_days, EXCLUDED.total_days),
    plan_id = v_req.plan_id,
    plan_name = v_req.plan_name,
    updated_at = now();

  -- تحديث حالة الطلب
  UPDATE public.subscription_requests
  SET status = 'approved',
      confirmed_by = v_caller,
      confirmed_at = now(),
      admin_note = p_admin_note
  WHERE id = p_request_id;

  -- إرسال إشعار فوري للعميل بنجاح التفعيل
  INSERT INTO public.user_notifications (
    user_id, title, message, type, action_url
  ) VALUES (
    v_req.user_id,
    '🎉 تم تفعيل اشتراكك بنجاح',
    'تم اعتماد طلب الاشتراك وتمديد صلاحية متجرك حتى ' || to_char(v_new_expires, 'YYYY-MM-DD'),
    'license_activated',
    '/settings'
  );

  RETURN jsonb_build_object(
    'success', true,
    'expires_at', v_new_expires,
    'message', 'تم تفعيل الحساب وتمديد الصلاحية بنجاح'
  );
END;
$$;
