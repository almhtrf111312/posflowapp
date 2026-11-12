-- create_subscription_request(p_plan_id uuid, p_method_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.create_subscription_request(p_plan_id uuid, p_method_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_plan record;
  v_method record;
  v_ref_code text;
  v_request_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير مسجل الدخول';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.subscription_requests 
    WHERE user_id = v_user_id AND status IN ('pending', 'paid_claimed')
  ) THEN
    RAISE EXCEPTION 'لديك طلب تجديد قيد المراجعة بالفعل، يمكنك تعديله أو إلغاؤه';
  END IF;

  SELECT * INTO v_plan FROM public.subscription_plans WHERE id = p_plan_id AND enabled = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'باقة الاشتراك المحددة غير متوفرة أو معطلة';
  END IF;

  SELECT * INTO v_method FROM public.payment_methods WHERE id = p_method_id AND enabled = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'طريقة الدفع المحددة غير متوفرة';
  END IF;

  v_ref_code := 'FP-' || upper(substr(md5(random()::text), 1, 5));

  INSERT INTO public.subscription_requests (
    user_id, ref_code, plan_id, plan_name, plan_audience, plan_days,
    price_usd, equivalents_snapshot, method_id, method_name, status
  ) VALUES (
    v_user_id, v_ref_code, v_plan.id, v_plan.name, v_plan.audience, v_plan.duration_days,
    v_plan.price_usd, v_plan.equivalents, v_method.id, v_method.name, 'pending'
  ) RETURNING id INTO v_request_id;

  RETURN jsonb_build_object(
    'success', true,
    'request_id', v_request_id,
    'ref_code', v_ref_code
  );
END;
$function$
;
