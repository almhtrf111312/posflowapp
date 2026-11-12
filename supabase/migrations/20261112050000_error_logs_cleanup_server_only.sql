-- =========================================================================
-- FlowPOS Pro — مسح سجلات الأعطال القديمة: للخادم فقط
-- كانت متاحة لكل مستخدم مسجّل دخول (أي عميل يقدر يمسح أدلة الأعطال). التطبيق لا يستدعيها.
-- آمن لإعادة التشغيل. الرجوع: GRANT EXECUTE ON FUNCTION public.clean_old_error_logs() TO authenticated;
-- =========================================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'clean_old_error_logs'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

-- التحقق: يجب أن تكون true
SELECT NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'clean_old_error_logs'
    AND (has_function_privilege('anon', p.oid, 'execute') OR has_function_privilege('authenticated', p.oid, 'execute'))
) AS cleanup_server_only;
