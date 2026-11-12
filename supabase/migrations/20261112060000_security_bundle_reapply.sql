-- =========================================================================
-- FlowPOS Pro — حزمة الأمان الكاملة (إعادة تطبيق): تجمع الملفات 020000 و 030000 و 040000
-- القاعدة الحية لم تحمل هذه الملفات (فحص 2026-11-12 23:48). آمن لإعادة التشغيل، لا يحذف بيانات.
-- يُبقي سياسة "Boss can manage app settings" ودالة get_public_contact_links كما هما.
-- شغّله كاملاً مرة واحدة. آخر جدول = الفحص الشامل (12 بنداً كلها ✅).
-- =========================================================================

-- ######## الجزء 1: app_settings + توكن التيليجرام + دوال البوس ########
BEGIN;

-- -------------------------------------------------------------------------
-- 1. app_settings: لا يقرأ العميل إلا المفاتيح التي يحتاجها التطبيق فعلاً
--    (روابط التواصل، رقم المطور، إعدادات الإصدار). الباقي للبوس فقط.
-- -------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can read app settings" ON public.app_settings;

DROP POLICY IF EXISTS "Public contact settings are readable" ON public.app_settings;
CREATE POLICY "Public contact settings are readable"
  ON public.app_settings FOR SELECT
  TO anon, authenticated
  USING (key = ANY (ARRAY['developer_phone'::text, 'contact_links'::text]));

DROP POLICY IF EXISTS "Authenticated read release config" ON public.app_settings;
CREATE POLICY "Authenticated read release config"
  ON public.app_settings FOR SELECT
  TO authenticated
  USING (key = 'release_config'::text);

DROP POLICY IF EXISTS "Boss can read all app settings" ON public.app_settings;
CREATE POLICY "Boss can read all app settings"
  ON public.app_settings FOR SELECT
  TO authenticated
  USING (public.is_boss(auth.uid()));

-- -------------------------------------------------------------------------
-- 2. توكن بوت التيليجرام: كانت الدالة تعيده لأي مستخدم مسجّل دخول.
--    الآن للبوس فقط. (إشعار طلب التجديد داخل التطبيق يصل للبوس عبر trigger في الخادم.)
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_boss_telegram_alert_config()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_val text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_boss(auth.uid()) THEN
    RETURN NULL;
  END IF;

  SELECT value INTO v_val
  FROM public.app_settings
  WHERE key = 'telegram_boss_alert_config';

  IF v_val IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN v_val::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.get_boss_telegram_alert_config() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_boss_telegram_alert_config() TO authenticated, service_role;

-- -------------------------------------------------------------------------
-- 3. دوال البوس: لا ينفذها زائر بلا تسجيل دخول.
--    تُطبَّق على كل نسخ الدالة الموجودة أياً كانت معاملاتها (لا يفشل إن اختلف التوقيع أو غابت الدالة).
--    وتُمنح صراحة للمستخدمين المسجلين حتى لا يتوقف البوس (كل دالة تتحقق من البوس داخلياً).
-- -------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'boss_direct_activate_by_plan',
        'approve_subscription_request_atomic',
        'boss_set_single_device',
        'boss_activate_license',
        'boss_change_user_password',
        'boss_hard_delete_user',
        'boss_revoke_user_license',
        'boss_reactivate_user_license'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END $$;

-- مسار بحث ثابت لدالة تنظيف السجلات (حماية من تبديل مسار البحث) دون تغيير محتواها
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'clean_old_error_logs'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', r.sig);
  END LOOP;
END $$;

COMMIT;


-- ######## الجزء 1ب: مسح سجلات الأعطال للخادم فقط (يبقى كما هو مطبّق) ########
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

-- ######## الجزء 2: منع الاستعلام عن متجر آخر ########
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


-- ######## الجزء 3: الفترات المقفلة + حماية التفعيل الداخلية ########
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


-- ######## الفحص الشامل (قراءة فقط): كل البنود يجب أن تكون ✅ ########
WITH fn AS (
  SELECT p.proname AS name, p.oid, pg_get_functiondef(p.oid) AS def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f'
),
pol AS (SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'app_settings'),
checks(ord, file, item, ok) AS (VALUES
  (1, '020000', 'سياسة قراءة روابط التواصل موجودة', EXISTS (SELECT 1 FROM pol WHERE policyname = 'Public contact settings are readable')),
  (2, '020000', 'سياسة قراءة إعدادات الإصدار موجودة', EXISTS (SELECT 1 FROM pol WHERE policyname = 'Authenticated read release config')),
  (3, '020000', 'سياسة قراءة البوس موجودة', EXISTS (SELECT 1 FROM pol WHERE policyname = 'Boss can read all app settings')),
  (4, '020000', 'توكن التيليجرام للبوس فقط', EXISTS (SELECT 1 FROM fn WHERE name = 'get_boss_telegram_alert_config' AND def ILIKE '%is_boss%')),
  (5, '020000', 'دوال البوس مغلقة أمام الزائر', NOT EXISTS (SELECT 1 FROM fn WHERE name IN ('boss_activate_license','boss_hard_delete_user','boss_change_user_password','boss_revoke_user_license','boss_reactivate_user_license') AND has_function_privilege('anon', oid, 'execute'))),
  (6, '030000', 'دالة الحارس caller_can_query_account موجودة', EXISTS (SELECT 1 FROM fn WHERE name = 'caller_can_query_account')),
  (7, '030000', 'الدوال الأربع مغلّفة بالحارس', (SELECT count(*) FROM fn WHERE name IN ('check_product_addition_limit__impl','can_add_cashier__impl','count_owner_cashiers__impl','can_refund_invoices__impl')) = 4),
  (8, '030000', 'التفعيل للخادم فقط', NOT EXISTS (SELECT 1 FROM fn WHERE name = 'activate_code_strict' AND (has_function_privilege('anon', oid, 'execute') OR has_function_privilege('authenticated', oid, 'execute')))),
  (9, '030000', 'فحص الرقم/البريد يحتاج تسجيل دخول', NOT EXISTS (SELECT 1 FROM fn WHERE name IN ('check_phone_email_availability','check_store_phone_status') AND has_function_privilege('anon', oid, 'execute'))),
  (10, '040000', 'الفترات المقفلة مغلّفة بالحارس', EXISTS (SELECT 1 FROM fn WHERE name = 'assert_period_open__impl')),
  (11, '040000', 'التفعيل مغلّف بحماية داخلية', EXISTS (SELECT 1 FROM fn WHERE name = 'activate_code_strict__impl')),
  (12, '050000', 'مسح سجلات الأعطال للخادم فقط', NOT EXISTS (SELECT 1 FROM fn WHERE name = 'clean_old_error_logs' AND (has_function_privilege('anon', oid, 'execute') OR has_function_privilege('authenticated', oid, 'execute'))))
)
SELECT file AS "الملف", item AS "البند", CASE WHEN ok THEN '✅' ELSE '❌' END AS "الحالة",
       (SELECT string_agg(policyname, ' | ') FROM pol) AS "سياسات app_settings الحالية"
FROM checks ORDER BY ok, ord;
