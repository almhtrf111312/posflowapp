-- فحص قراءة فقط: هل ملفات الأمان الأربعة مطبّقة الآن على القاعدة الحية؟
-- (20261112020000 / 030000 / 040000 / 050000) — لا يكتب شيئاً. شغّله كاملاً مرة واحدة.
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
