-- =========================================================================
-- FlowPOS Pro — الجولة الثانية من إصلاحات الفحص الأمني
-- يتطلب تطبيق 20261112020000 و 20261112030000 قبله. آمن لإعادة التشغيل، لا يحذف بيانات.
-- آخر استعلام = التحقق (كل الأعمدة true).
-- الرجوع: supabase/live-snapshots/2026-11-12/ROLLBACK_security_round2.sql
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- 1. app_settings: حذف أي سياسة قراءة متبقية تسمح لكل مسجّل دخول بقراءة كل السجلات
--    (نُبقي فقط: روابط التواصل، إعدادات الإصدار، وسياسات البوس)
-- -------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'app_settings'
      AND cmd IN ('SELECT', 'ALL')
      AND policyname NOT IN ('Public contact settings are readable',
                             'Authenticated read release config',
                             'Boss can read all app settings')
      AND coalesce(qual, '') NOT ILIKE '%is_boss%'
      AND coalesce(qual, '') NOT ILIKE '%has_role%'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.app_settings', r.policyname);
    RAISE NOTICE 'حُذفت سياسة app_settings المفتوحة: %', r.policyname;
  END LOOP;
END $$;

-- -------------------------------------------------------------------------
-- 2. تغليف دوال إضافية بحارس "حسابك فقط" (نفس طريقة الملف السابق، مع دعم الدوال بلا قيمة راجعة):
--    - assert_period_open: كانت تكشف الفترات المقفلة لأي متجر
--    - activate_code_strict: حماية إضافية داخل الدالة نفسها (تبقى للخادم فقط)
-- -------------------------------------------------------------------------
DO $$
DECLARE
  spec record;
  fn record;
  impl_name text;
  arg_list text;
  ident_args text;
  call_list text;
  result_type text;
  guard_expr text;
  body text;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('assert_period_open',   '_owner',    false),
      ('activate_code_strict', 'p_user_id', true)
    ) AS s(fname, guard_arg, server_only)
  LOOP
    impl_name := spec.fname || '__impl';
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = impl_name) THEN
      RAISE NOTICE 'تخطّي %: مغلّفة مسبقاً', spec.fname;
      CONTINUE;
    END IF;

    SELECT p.oid, p.proargnames, p.pronargs INTO fn
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = spec.fname LIMIT 1;
    IF fn.oid IS NULL THEN
      RAISE NOTICE 'تخطّي %: غير موجودة', spec.fname; CONTINUE;
    END IF;
    IF array_position(fn.proargnames, spec.guard_arg) IS NULL THEN
      RAISE NOTICE 'تخطّي %: المعامل % غير موجود', spec.fname, spec.guard_arg; CONTINUE;
    END IF;

    arg_list    := pg_get_function_arguments(fn.oid);
    ident_args  := pg_get_function_identity_arguments(fn.oid);
    result_type := pg_get_function_result(fn.oid);
    SELECT string_agg(format('%I', a), ', ' ORDER BY i) INTO call_list
      FROM unnest(fn.proargnames[1:fn.pronargs]) WITH ORDINALITY AS t(a, i);

    -- activate_code_strict: صاحب الحساب نفسه فقط (أو الخادم/البوس)
    IF spec.fname = 'activate_code_strict' THEN
      guard_expr := format('(auth.uid() IS NULL OR auth.uid() = %1$I OR public.is_boss(auth.uid()))', spec.guard_arg);
    ELSE
      guard_expr := format('public.caller_can_query_account(%1$I)', spec.guard_arg);
    END IF;

    EXECUTE format('ALTER FUNCTION %s RENAME TO %I', fn.oid::regprocedure, impl_name);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated', impl_name, ident_args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', impl_name, ident_args);

    IF result_type = 'void' THEN
      body := format($b$
BEGIN
  IF NOT %1$s THEN
    RAISE EXCEPTION 'غير مصرح بالاستعلام عن بيانات حساب آخر' USING ERRCODE = '42501';
  END IF;
  PERFORM public.%2$I(%3$s);
END;$b$, guard_expr, impl_name, call_list);
    ELSIF result_type = 'jsonb' AND spec.fname = 'activate_code_strict' THEN
      body := format($b$
BEGIN
  IF NOT %1$s THEN
    RETURN jsonb_build_object('success', false, 'error', 'غير مصرح بتفعيل كود لحساب آخر');
  END IF;
  RETURN public.%2$I(%3$s);
END;$b$, guard_expr, impl_name, call_list);
    ELSE
      body := format($b$
BEGIN
  IF NOT %1$s THEN
    RAISE EXCEPTION 'غير مصرح بالاستعلام عن بيانات حساب آخر' USING ERRCODE = '42501';
  END IF;
  RETURN public.%2$I(%3$s);
END;$b$, guard_expr, impl_name, call_list);
    END IF;

    EXECUTE format(
      'CREATE FUNCTION public.%I(%s) RETURNS %s LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS %L',
      spec.fname, arg_list, result_type, body);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon', spec.fname, ident_args);
    IF spec.server_only THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM authenticated', spec.fname, ident_args);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', spec.fname, ident_args);
    ELSE
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated, service_role', spec.fname, ident_args);
    END IF;
    RAISE NOTICE 'تم تغليف %', spec.fname;
  END LOOP;
END $$;

COMMIT;

-- -------------------------------------------------------------------------
-- التحقق (قراءة فقط)
-- -------------------------------------------------------------------------
SELECT
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'app_settings'
              AND cmd IN ('SELECT','ALL')
              AND policyname NOT IN ('Public contact settings are readable','Authenticated read release config','Boss can read all app settings')
              AND coalesce(qual,'') NOT ILIKE '%is_boss%' AND coalesce(qual,'') NOT ILIKE '%has_role%')
                                                                                  AS app_settings_closed,
  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'assert_period_open__impl')  AS closed_periods_guarded,
  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'activate_code_strict__impl') AS activation_guarded,
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'activate_code_strict'
            AND (has_function_privilege('anon', p.oid, 'execute') OR has_function_privilege('authenticated', p.oid, 'execute')))
                                                                                  AS activation_server_only,
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'assert_period_open'
            AND NOT has_function_privilege('authenticated', p.oid, 'execute'))    AS app_still_works;
