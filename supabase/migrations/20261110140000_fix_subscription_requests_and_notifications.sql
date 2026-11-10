-- =========================================================================
-- تهجير إصلاح طلبات التجديد subscription_requests وتحديث الإصدار السحابي
-- =========================================================================

-- 1. التأكد من سماح أعمدة plan_id و method_id بالقيمة NULL للباقات الافتراضية
ALTER TABLE IF EXISTS public.subscription_requests 
ALTER COLUMN plan_id DROP NOT NULL,
ALTER COLUMN method_id DROP NOT NULL;

-- 2. ضبط القيمة الافتراضية لعمود equivalents_snapshot
ALTER TABLE IF EXISTS public.subscription_requests 
ALTER COLUMN equivalents_snapshot SET DEFAULT '[]'::jsonb;

-- 3. تحديث سياسة إدخال الطلبات للمستخدمين لتشمل كلاً من 'pending' و 'paid_claimed'
DROP POLICY IF EXISTS "Users create requests" ON public.subscription_requests;
CREATE POLICY "Users create requests"
ON public.subscription_requests FOR INSERT TO authenticated
WITH CHECK (
  user_id = auth.uid() 
  AND (status IS NULL OR status = 'pending' OR status = 'paid_claimed')
  AND confirmed_by IS NULL
  AND confirmed_at IS NULL
);

-- 4. تحديث سياسة تعديل الطلب المعلق
DROP POLICY IF EXISTS "Users update own pending proof only" ON public.subscription_requests;
CREATE POLICY "Users update own pending proof only"
ON public.subscription_requests FOR UPDATE TO authenticated
USING (user_id = auth.uid() AND (status = 'pending' OR status = 'paid_claimed'))
WITH CHECK (
  user_id = auth.uid() 
  AND (status = 'pending' OR status = 'paid_claimed') 
  AND confirmed_by IS NULL 
  AND confirmed_at IS NULL
);

-- 5. تحديث رقم الإصدار النشط في سجل release_config بجدول app_settings
INSERT INTO public.app_settings (key, value, updated_at)
VALUES (
  'release_config',
  '{"latest_version_name": "1.5.99", "latest_version_code": 487, "min_version_code": 0, "grace_days": 3, "update_url": "", "telegram_url": "https://t.me/flowpospro"}',
  now()
)
ON CONFLICT (key) DO UPDATE 
SET value = jsonb_set(
  jsonb_set(
    COALESCE(public.app_settings.value::jsonb, '{}'::jsonb),
    '{latest_version_name}',
    '"1.5.99"'
  ),
  '{latest_version_code}',
  '487'
)::text,
updated_at = now();
