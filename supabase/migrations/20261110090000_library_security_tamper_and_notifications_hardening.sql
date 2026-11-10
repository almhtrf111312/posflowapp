-- =====================================================================
-- خطة الإصلاح الأمني - المرحلة الثالثة: تحصين جداول المكتبة والأمان والإشعارات
-- =====================================================================

-- 1. تصحيح وحصر سياسات جداول المكتبة والاستعارات (library_members & book_loans)
ALTER TABLE IF EXISTS public.library_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.book_loans ENABLE ROW LEVEL SECURITY;

-- سحب أي صلاحيات عامة ممنوحة لدور anon
REVOKE ALL ON public.library_members FROM anon;
REVOKE ALL ON public.book_loans FROM anon;
GRANT ALL ON public.library_members TO authenticated;
GRANT ALL ON public.book_loans TO authenticated;

-- إعادة بناء السياسات لربطها بدور authenticated ومالك المتجر حصراً
DROP POLICY IF EXISTS "Users manage own library members" ON public.library_members;
CREATE POLICY "Users manage own library members"
ON public.library_members FOR ALL TO authenticated
USING (user_id = public.get_owner_id(auth.uid()))
WITH CHECK (user_id = public.get_owner_id(auth.uid()));

DROP POLICY IF EXISTS "Users manage own book loans" ON public.book_loans;
CREATE POLICY "Users manage own book loans"
ON public.book_loans FOR ALL TO authenticated
USING (user_id = public.get_owner_id(auth.uid()))
WITH CHECK (user_id = public.get_owner_id(auth.uid()));


-- 2. تحصين سجلات العبث الأمني (security_tamper_logs)
ALTER TABLE IF EXISTS public.security_tamper_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.security_tamper_logs FROM anon;
GRANT INSERT ON public.security_tamper_logs TO authenticated;
GRANT SELECT, UPDATE, DELETE ON public.security_tamper_logs TO authenticated;

DROP POLICY IF EXISTS "Users can insert security logs" ON public.security_tamper_logs;
DROP POLICY IF EXISTS "Admins can view security logs" ON public.security_tamper_logs;
DROP POLICY IF EXISTS "Devices report security tamper logs" ON public.security_tamper_logs;
DROP POLICY IF EXISTS "Boss and admin view security tamper logs" ON public.security_tamper_logs;

-- أ) السماح للأجهزة المسجلة بالإبلاغ عن محاولات التلاعب وتغيير الوقت
CREATE POLICY "Devices report security tamper logs"
ON public.security_tamper_logs FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

-- ب) حصر الاطلاع على السجلات التحذيرية بالمدير العام والمسؤولين فقط
CREATE POLICY "Boss and admin view security tamper logs"
ON public.security_tamper_logs FOR SELECT TO authenticated
USING (
  public.is_boss(auth.uid()) OR EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE user_id = auth.uid() AND role IN ('admin', 'boss')
  )
);


-- 3. ضبط سياسات إشعارات المستخدمين (user_notifications)
ALTER TABLE IF EXISTS public.user_notifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.user_notifications FROM anon;
GRANT ALL ON public.user_notifications TO authenticated;

DROP POLICY IF EXISTS "Users own notifications" ON public.user_notifications;
DROP POLICY IF EXISTS "Users manage own notifications" ON public.user_notifications;
DROP POLICY IF EXISTS "Users read own notifications" ON public.user_notifications;
DROP POLICY IF EXISTS "Users update own notifications" ON public.user_notifications;
DROP POLICY IF EXISTS "Boss insert notifications" ON public.user_notifications;
DROP POLICY IF EXISTS "Users delete own notifications" ON public.user_notifications;

-- أ) المستخدم يقرأ إشعاراته فقط، والبوس يقرأ كافة الإشعارات
CREATE POLICY "Users read own notifications"
ON public.user_notifications FOR SELECT TO authenticated
USING (user_id = auth.uid() OR public.is_boss(auth.uid()));

-- ب) المستخدم يُحدّث حالة إشعاراته فقط (تحديد كمقروء / أرشفة)
CREATE POLICY "Users update own notifications"
ON public.user_notifications FOR UPDATE TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- ج) المدير العام يحق له إرسال إشعارات لأي مستخدم في النظام
CREATE POLICY "Boss insert notifications"
ON public.user_notifications FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() OR public.is_boss(auth.uid()));

-- د) المستخدم يحذف إشعاراته الخاصة فقط
CREATE POLICY "Users delete own notifications"
ON public.user_notifications FOR DELETE TO authenticated
USING (user_id = auth.uid() OR public.is_boss(auth.uid()));
