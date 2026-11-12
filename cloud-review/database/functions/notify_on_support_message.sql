-- notify_on_support_message()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.notify_on_support_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_conv record;
  v_target_user uuid;
  v_title text;
  v_body text;
BEGIN
  -- جلب بيانات المحادثة لمعرفة الطرف الآخر
  SELECT * INTO v_conv FROM public.support_conversations WHERE id = NEW.conversation_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- إذا كان المرسل هو المدير العام (boss)، فوجه الإشعار للعميل صاحب المحادثة
  IF NEW.sender_role IN ('boss', 'admin') THEN
    v_target_user := v_conv.user_id;
    v_title := '💬 رسالة جديدة من الدعم الفني';
    v_body := substring(NEW.message from 1 for 100);

    INSERT INTO public.user_notifications (
      user_id, title, message, type, action_url
    ) VALUES (
      v_target_user,
      v_title,
      v_body,
      'support_reply',
      '/contact'
    );
  END IF;

  RETURN NEW;
END;
$function$
;
