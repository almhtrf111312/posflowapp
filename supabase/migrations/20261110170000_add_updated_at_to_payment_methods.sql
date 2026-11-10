-- =========================================================================
-- إضافة الأعمدة المتبقية لطرق الدفع وطلبات التجديد وتحديث كاش PostgREST
-- =========================================================================

-- 1. إضافة عمود updated_at لجدول طرق الدفع payment_methods
ALTER TABLE IF EXISTS public.payment_methods 
ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- 2. تحديث جدول طلبات الاشتراك subscription_requests بنفس العمودين للحماية
ALTER TABLE IF EXISTS public.subscription_requests 
ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now(),
ADD COLUMN IF NOT EXISTS notes text;

-- 3. إعادة تحميل كاش المخطط في Supabase فوراً
NOTIFY pgrst, 'reload schema';
