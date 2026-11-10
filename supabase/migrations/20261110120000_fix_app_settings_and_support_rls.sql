-- =====================================================================
-- Migration: 20261110120000_fix_app_settings_and_support_rls.sql
-- Description:
-- 1. Restore authenticated SELECT on app_settings to prevent RLS blindness
-- 2. Restore store employee / cashier access to support conversations & messages
-- 3. Clean up user profile allowed_pages for root admin account
-- =====================================================================

-- 1. إعادة سياسة القراءة العامة للمستخدمين المسجلين في app_settings
DROP POLICY IF EXISTS "Authenticated users can read app settings" ON public.app_settings;
CREATE POLICY "Authenticated users can read app settings"
ON public.app_settings FOR SELECT TO authenticated
USING (true);

-- 2. إعادة صلاحية وصول موظفي المتجر والكاشيرات لمحادثات ورسائل الدعم الفني
DROP POLICY IF EXISTS "Users and boss view support conversations" ON public.support_conversations;
CREATE POLICY "Users and boss view support conversations"
ON public.support_conversations FOR SELECT TO authenticated
USING (
  user_id = auth.uid() 
  OR owner_id = public.get_owner_id(auth.uid()) 
  OR public.is_boss(auth.uid())
);

DROP POLICY IF EXISTS "Users and boss view support messages" ON public.support_messages;
CREATE POLICY "Users and boss view support messages"
ON public.support_messages FOR SELECT TO authenticated
USING (
  public.is_boss(auth.uid()) 
  OR EXISTS (
    SELECT 1 FROM public.support_conversations c
    WHERE c.id = support_messages.conversation_id
      AND (c.user_id = auth.uid() OR c.owner_id = public.get_owner_id(auth.uid()))
  )
);

-- 3. تنظيف قيود الصفحات للحساب الأساسي وترقيته ليكون Boss أو Admin كامل الصلاحيات
UPDATE public.profiles
SET allowed_pages = NULL,
    user_type = 'admin'
WHERE user_id = '098213f7-2f51-49e3-b0eb-d10c1c7f301a';
