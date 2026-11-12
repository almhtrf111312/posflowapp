-- =========================================================================
-- FlowPOS Pro — منع الاستعلام عن بيانات متجر آخر (نتائج الفحص الأمني)
-- آمن لإعادة التشغيل. لا يحذف بيانات ولا يغيّر محتوى أي دالة حالية.
-- طبّقه بعد ملف 20261112020000 (app_settings). آخر استعلام = التحقق (كل الأعمدة true).
-- الرجوع: supabase/live-snapshots/2026-11-12/ROLLBACK_security_cross_store.sql
--
-- الفكرة: لا نعيد كتابة الدوال (نسخها الحية غير موجودة في المستودع). بدلاً من ذلك:
--   الدالة الأصلية تُعاد تسميتها إلى <الاسم>__impl ويُمنع استدعاؤها من التطبيق،
--   وتُنشأ دالة بنفس الاسم والمعاملات تتحقق أن المتصل يسأل عن متجره هو (أو أنه البوس)
--   ثم تستدعي الأصلية كما هي. الخادم والـ triggers (بدون مستخدم) تمر كما كانت.
-- =========================================================================

BEGIN;

-- 1. دالة الحارس: هل يحق للمتصل الاستعلام عن هذا الحساب؟
CREATE OR REPLACE FUNCTION public.caller_can_query_account(_target uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller uuid := auth.uid();
BEGIN
  -- بدون مستخدم = الخادم (service_role) أو trigger داخلي: مسموح كما كان
  IF _caller IS NULL THEN
    RETURN true;
  END IF;
  IF _target IS NULL THEN
    RETURN false;
  END IF;
  RETURN _caller = _target
      OR public.get_owner_id(_caller) = _target
      OR public.get_owner_id(_caller) = public.get_owner_id(_target)
      OR public.is_boss(_caller);
END;
$$;
REVOKE ALL ON FUNCTION public.caller_can_query_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caller_can_query_account(uuid) TO authenticated, service_role;

-- 2. تغليف الدوال التي تأخذ معرّف متجر/مستخدم بالحارس
DO $$
DECLARE
  spec record;
  fn record;
  impl_name text;
  arg_list text;
  call_list text;
  result_type text;
  is_set boolean;
  guard_idx int;
  body text;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('check_product_addition_limit', 'p_owner_id'),
      ('can_add_cashier',              '_owner_id'),
      ('count_owner_cashiers',         '_owner_id'),
      ('can_refund_invoices',          '_user_id')
    ) AS s(fname, guard_arg)
  LOOP
    impl_name := spec.fname || '__impl';

    -- مطبَّق مسبقاً: لا شيء
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = impl_name) THEN
      RAISE NOTICE 'تخطّي %: مغلّفة مسبقاً', spec.fname;
      CONTINUE;
    END IF;

    SELECT p.oid, p.proargnames, p.pronargs
      INTO fn
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = spec.fname
     LIMIT 1;

    IF fn.oid IS NULL THEN
      RAISE NOTICE 'تخطّي %: غير موجودة', spec.fname;
      CONTINUE;
    END IF;

    guard_idx := array_position(fn.proargnames, spec.guard_arg);
    IF guard_idx IS NULL THEN
      RAISE NOTICE 'تخطّي %: المعامل % غير موجود', spec.fname, spec.guard_arg;
      CONTINUE;
    END IF;

    arg_list    := pg_get_function_arguments(fn.oid);
    result_type := pg_get_function_result(fn.oid);
    is_set      := result_type ILIKE 'SETOF %' OR result_type ILIKE 'TABLE(%';
    SELECT string_agg(format('%I', a), ', ' ORDER BY i)
      INTO call_list
      FROM unnest(fn.proargnames[1:fn.pronargs]) WITH ORDINALITY AS t(a, i);

    -- إعادة تسمية الأصلية وإغلاقها أمام التطبيق
    EXECUTE format('ALTER FUNCTION %s RENAME TO %I', fn.oid::regprocedure, impl_name);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated',
                   impl_name, pg_get_function_identity_arguments(fn.oid));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role',
                   impl_name, pg_get_function_identity_arguments(fn.oid));

    IF is_set THEN
      body := format($b$
BEGIN
  IF NOT public.caller_can_query_account(%1$I) THEN
    RAISE EXCEPTION 'غير مصرح بالاستعلام عن بيانات حساب آخر' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public.%2$I(%3$s);
END;$b$, spec.guard_arg, impl_name, call_list);
    ELSIF result_type = 'boolean' THEN
      body := format($b$
BEGIN
  IF NOT public.caller_can_query_account(%1$I) THEN
    RETURN false;
  END IF;
  RETURN public.%2$I(%3$s);
END;$b$, spec.guard_arg, impl_name, call_list);
    ELSIF result_type IN ('integer', 'bigint', 'numeric') THEN
      body := format($b$
BEGIN
  IF NOT public.caller_can_query_account(%1$I) THEN
    RETURN NULL;
  END IF;
  RETURN public.%2$I(%3$s);
END;$b$, spec.guard_arg, impl_name, call_list);
    ELSE
      body := format($b$
BEGIN
  IF NOT public.caller_can_query_account(%1$I) THEN
    RAISE EXCEPTION 'غير مصرح بالاستعلام عن بيانات حساب آخر' USING ERRCODE = '42501';
  END IF;
  RETURN public.%2$I(%3$s);
END;$b$, spec.guard_arg, impl_name, call_list);
    END IF;

    EXECUTE format(
      'CREATE FUNCTION public.%I(%s) RETURNS %s LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS %L',
      spec.fname, arg_list, result_type, body);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon',
                   spec.fname, pg_get_function_identity_arguments(fn.oid));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated, service_role',
                   spec.fname, pg_get_function_identity_arguments(fn.oid));
    RAISE NOTICE 'تم تغليف %', spec.fname;
  END LOOP;
END $$;

-- 3. تفعيل الكود: يستدعيها فقط الخادم (دالة validate-activation-code تأخذ هوية المستخدم من جلسته)،
--    فلا داعي لأن يستدعيها التطبيق أو الزائر مباشرة بمعرّف أي حساب.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'activate_code_strict'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

-- 4. فحص توفر الرقم/البريد: يستخدمه التطبيق بعد تسجيل الدخول فقط، فلا يستدعيه الزائر
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname IN ('check_phone_email_availability', 'check_store_phone_status')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END $$;

COMMIT;

-- -------------------------------------------------------------------------
-- التحقق (قراءة فقط): كل الأعمدة يجب أن تكون true
-- -------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN
      ('check_product_addition_limit__impl','can_add_cashier__impl','count_owner_cashiers__impl','can_refund_invoices__impl')) = 4
                                                                                   AS four_functions_guarded,
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE '%\_\_impl' ESCAPE '\'
      AND has_function_privilege('authenticated', p.oid, 'execute'))               AS originals_closed_to_app,
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN
      ('check_product_addition_limit','can_add_cashier','count_owner_cashiers','can_refund_invoices')
      AND NOT has_function_privilege('authenticated', p.oid, 'execute'))           AS app_still_works,
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'activate_code_strict'
      AND (has_function_privilege('anon', p.oid, 'execute') OR has_function_privilege('authenticated', p.oid, 'execute')))
                                                                                   AS activation_server_only,
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('check_phone_email_availability','check_store_phone_status')
      AND has_function_privilege('anon', p.oid, 'execute'))                        AS lookups_need_login;
