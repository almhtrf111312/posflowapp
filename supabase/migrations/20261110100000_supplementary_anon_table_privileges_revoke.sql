-- =====================================================================
-- خطة الإصلاح الأمني - الإغلاق التكميلي الفوري: سحب صلاحيات anon على مستوى الجداول
-- وتأمين محادثات ورسائل الدعم الفني بشكل كامل
-- =====================================================================

-- 1. تفعيل RLS وسحب كافة الصلاحيات من دور anon على الجداول الحساسة
ALTER TABLE IF EXISTS public.app_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.subscription_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.support_messages ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON public.app_licenses FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.app_settings FROM anon;
REVOKE ALL ON public.subscription_requests FROM anon;
REVOKE ALL ON public.support_conversations FROM anon;
REVOKE ALL ON public.support_messages FROM anon;

GRANT ALL ON public.support_conversations TO authenticated;
GRANT ALL ON public.support_messages TO authenticated;

-- 2. تحصين RLS لجدول محادثات الدعم (support_conversations)
DROP POLICY IF EXISTS "Users and boss view support conversations" ON public.support_conversations;
CREATE POLICY "Users and boss view support conversations"
ON public.support_conversations FOR SELECT TO authenticated
USING (user_id = auth.uid() OR public.is_boss(auth.uid()));

DROP POLICY IF EXISTS "Users and boss create support conversations" ON public.support_conversations;
CREATE POLICY "Users and boss create support conversations"
ON public.support_conversations FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() OR public.is_boss(auth.uid()));

DROP POLICY IF EXISTS "Users and boss update support conversations" ON public.support_conversations;
CREATE POLICY "Users and boss update support conversations"
ON public.support_conversations FOR UPDATE TO authenticated
USING (user_id = auth.uid() OR public.is_boss(auth.uid()))
WITH CHECK (user_id = auth.uid() OR public.is_boss(auth.uid()));

-- 3. تحصين RLS لجدول رسائل الدعم (support_messages)
DROP POLICY IF EXISTS "Users and boss view support messages" ON public.support_messages;
CREATE POLICY "Users and boss view support messages"
ON public.support_messages FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.support_conversations c
    WHERE c.id = conversation_id
      AND (c.user_id = auth.uid() OR public.is_boss(auth.uid()))
  )
);

DROP POLICY IF EXISTS "Users and boss insert support messages" ON public.support_messages;
CREATE POLICY "Users and boss insert support messages"
ON public.support_messages FOR INSERT TO authenticated
WITH CHECK (
  sender_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.support_conversations c
    WHERE c.id = conversation_id
      AND (c.user_id = auth.uid() OR public.is_boss(auth.uid()))
  )
);

DROP POLICY IF EXISTS "Users and boss update support messages" ON public.support_messages;
CREATE POLICY "Users and boss update support messages"
ON public.support_messages FOR UPDATE TO authenticated
USING (
  public.is_boss(auth.uid()) 
  OR EXISTS (
    SELECT 1 FROM public.support_conversations c
    WHERE c.id = conversation_id AND c.user_id = auth.uid()
  )
);

-- 4. التأكد من قصر القراءة في app_settings على المفاتيح المصرح بها فقط
DROP POLICY IF EXISTS "Anyone can read app settings" ON public.app_settings;
DROP POLICY IF EXISTS "Authenticated users can read app settings" ON public.app_settings;

-- 5. تأكيد تحصين مسار البحث للدوال الحساسة
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'activate_code_strict'
  ) THEN
    ALTER FUNCTION public.activate_code_strict(text, uuid, text, text) SET search_path = public;
  END IF;
END $$;
