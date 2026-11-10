-- =========================================================================
-- المرحلة الثانية: طرق الدفع الديناميكية والـ QR وقنوات التواصل
-- 1. تحديث جدول payment_methods لدعم الأزرار والـ QR والروابط
-- 2. تطبيق سياسات الأمان RLS لجدول payment_methods
-- 3. دالة سريعة لجلب إعدادات قنوات التواصل والدعم الفني get_public_contact_links
-- =========================================================================

-- 1. التأكد من وجود جدول طرق الدفع payment_methods
CREATE TABLE IF NOT EXISTS public.payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  button_label text DEFAULT 'فتح الرابط المباشر',
  link_url text,
  qr_image_url text,
  badge text,
  instructions text,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- إضافة الأعمدة الديناميكية في حال كان الجدول موجوداً مسبقاً
ALTER TABLE public.payment_methods 
ADD COLUMN IF NOT EXISTS button_label text DEFAULT 'فتح الرابط المباشر',
ADD COLUMN IF NOT EXISTS badge text,
ADD COLUMN IF NOT EXISTS qr_image_url text;

-- 2. تفعيل وضبط سياسات الأمان RLS لجدول طرق الدفع
ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read enabled methods" ON public.payment_methods;
CREATE POLICY "Public read enabled methods" ON public.payment_methods 
FOR SELECT TO authenticated, anon 
USING (enabled = true OR public.is_boss(auth.uid()));

DROP POLICY IF EXISTS "Boss full access methods" ON public.payment_methods;
CREATE POLICY "Boss full access methods" ON public.payment_methods 
FOR ALL TO authenticated 
USING (public.is_boss(auth.uid()))
WITH CHECK (public.is_boss(auth.uid()));

-- 3. دالة سريعة لجلب إعدادات قنوات التواصل والدعم الفني للمستخدمين
CREATE OR REPLACE FUNCTION public.get_public_contact_links()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(value::jsonb, '{}'::jsonb)
  FROM public.app_settings
  WHERE key = 'contact_links'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_contact_links() TO authenticated, anon;
