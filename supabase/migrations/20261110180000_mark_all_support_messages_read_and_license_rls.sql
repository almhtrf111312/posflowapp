-- =========================================================================
-- المرحلة 1: دالة تصفير رسائل الدعم الفني وتحديث سياسة قراءة التراخيص
-- =========================================================================

-- 1. دالة تصفير وقراءة كل رسائل الدعم الفني للمدير العام (Boss) بنقرة واحدة
CREATE OR REPLACE FUNCTION public.mark_all_support_messages_read()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_updated integer := 0;
BEGIN
  -- التحقق من أن المستدعي هو المدير العام حصراً
  IF NOT public.is_boss(v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error', 'غير مصرح: هذا الإجراء مخصص للمدير العام فقط');
  END IF;

  -- تحديث كافة رسائل العملاء غير المقروءة إلى مقروءة
  UPDATE public.support_messages
  SET is_read = true
  WHERE is_read = false AND sender_role = 'user';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'updated_count', v_updated);
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_all_support_messages_read() TO authenticated;

-- 2. التأكد من سياسة قراءة الترخيص الذاتي مباشرة للعميل والكاشير والمدير العام
DROP POLICY IF EXISTS "Users can view own license" ON public.app_licenses;

CREATE POLICY "Users can view own license"
ON public.app_licenses
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid() 
  OR public.is_boss(auth.uid())
  OR EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE user_roles.user_id = auth.uid() 
      AND user_roles.role = 'cashier' 
      AND user_roles.owner_id = app_licenses.user_id
  )
);

NOTIFY pgrst, 'reload schema';
