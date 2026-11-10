-- =========================================================================
-- المرحلة الثالثة: المحادثة الفورية وتنبيهات أندرويد وإشعار بوت تليجرام للمدير
-- 1. إضافة أعمدة الإشعار والملحقات لجدول رسائل الدعم
-- 2. دالة تسجيل إشعار سحابي آلي عند وصول أي رسالة من المدير إلى العميل
-- 3. تفعيل المشغل السحابي بعد إدراج الرسالة
-- =========================================================================

-- 1. التأكد من وجود أعمدة الإشعار والملحقات في جدول رسائل الدعم
ALTER TABLE public.support_messages 
ADD COLUMN IF NOT EXISTS attachment_url text,
ADD COLUMN IF NOT EXISTS notified_native boolean DEFAULT false;

-- 2. دالة تسجيل إشعار سحابي آلي عند وصول أي رسالة من المدير إلى العميل
CREATE OR REPLACE FUNCTION public.notify_on_support_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- إذا كان المرسل هو المدير العام (boss أو admin)، فوجه الإشعار للعميل صاحب المحادثة
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
$$;

DROP TRIGGER IF EXISTS trg_notify_support_message ON public.support_messages;
CREATE TRIGGER trg_notify_support_message
AFTER INSERT ON public.support_messages
FOR EACH ROW
EXECUTE FUNCTION public.notify_on_support_message();
