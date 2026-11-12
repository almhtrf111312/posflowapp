-- notify_boss_on_subscription_request()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.notify_boss_on_subscription_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
