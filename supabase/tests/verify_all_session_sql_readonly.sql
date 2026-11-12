-- فحص قراءة فقط: هل كل ملفات SQL التي سُلّمت في هذه الجلسات مطبّقة على القاعدة الحية؟
-- لا يكتب ولا يحذف شيئاً. انسخه كاملاً وشغّله مرة واحدة؛ كل سطر = بند، والعمود "الحالة" ✅ أو ❌.
WITH fn AS (
  SELECT p.proname AS name,
         pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_functiondef(p.oid) AS def,
         p.oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f'
),
trg AS (
  SELECT t.tgname AS name, c.relname AS tbl
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal
),
col AS (
  SELECT table_name AS tbl, column_name AS name
  FROM information_schema.columns
  WHERE table_schema = 'public'
),
gated AS (
  SELECT unnest(ARRAY[
    'accounting_period_closures','book_loans','cash_shifts','categories','customers',
    'debt_payments','debt_writeoffs','debts','expenses','invoice_items','invoice_sequences',
    'invoices','library_members','maintenance_services','partners','products','profit_records',
    'purchase_invoice_items','purchase_invoices','recurring_expenses','shift_transactions',
    'stock_count_items','stock_counts','stock_damages','stock_movements','stock_transfer_items',
    'stock_transfers','store_settings','stores','warehouse_stock','warehouses']) AS tbl
),
checks(ord, phase, item, ok) AS (
  VALUES
  -- 1) التفعيل الموحّد للبوس (20261111010000)
  (101, '1 تفعيل البوس', 'دالة boss_activate_license موجودة',
     EXISTS (SELECT 1 FROM fn WHERE name = 'boss_activate_license')),
  (102, '1 تفعيل البوس', 'boss_activate_license لا يستدعيها زائر بلا دخول',
     NOT EXISTS (SELECT 1 FROM fn WHERE name = 'boss_activate_license' AND has_function_privilege('anon', oid, 'execute'))),
  (103, '1 تفعيل البوس', 'دالة confirm_subscription_request موجودة',
     EXISTS (SELECT 1 FROM fn WHERE name = 'confirm_subscription_request')),
  (104, '1 تفعيل البوس', 'إشعار البوس عند طلب تجديد (trigger)',
     EXISTS (SELECT 1 FROM trg WHERE name = 'trg_notify_boss_subscription_request' AND tbl = 'subscription_requests')),

  -- 2) إصلاحات سلامة الدفاتر (20261111020000)
  (201, '2 سلامة الدفاتر', 'add_expense_atomic موجودة', EXISTS (SELECT 1 FROM fn WHERE name = 'add_expense_atomic')),
  (202, '2 سلامة الدفاتر', 'cancel_debt_atomic موجودة', EXISTS (SELECT 1 FROM fn WHERE name = 'cancel_debt_atomic')),
  (203, '2 سلامة الدفاتر', 'close_cash_shift_atomic موجودة', EXISTS (SELECT 1 FROM fn WHERE name = 'close_cash_shift_atomic')),
  (204, '2 سلامة الدفاتر', 'normalize_debt_row موجودة', EXISTS (SELECT 1 FROM fn WHERE name = 'normalize_debt_row')),
  (205, '2 سلامة الدفاتر', 'partner_deposit_atomic موجودة', EXISTS (SELECT 1 FROM fn WHERE name = 'partner_deposit_atomic')),
  (206, '2 سلامة الدفاتر', 'partner_withdrawal_atomic موجودة', EXISTS (SELECT 1 FROM fn WHERE name = 'partner_withdrawal_atomic')),

  -- 3) قفل الفترات وخسائر الشركاء (20261111030000)
  (301, '3 قفل الفترات', 'assert_period_open موجودة', EXISTS (SELECT 1 FROM fn WHERE name = 'assert_period_open')),
  -- تسديد الدين يقع بتاريخ اليوم فلا يحتاج قفل الفترة؛ تعديله في هذا الملف كان تحرير أرباح الشركاء بنسبة الدفعة
  (302, '3 قفل الفترات', 'تسديد الدين يحرر أرباح الشركاء بنسبة الدفعة (النسخة الأخيرة)',
     EXISTS (SELECT 1 FROM fn WHERE name = 'record_debt_payment_atomic' AND def ILIKE '%superseded%')),
  (303, '3 قفل الفترات', 'حذف المصروف يرفض الفترة المقفلة',
     EXISTS (SELECT 1 FROM fn WHERE name = 'delete_expense_atomic' AND def ILIKE '%assert_period_open%')),
  (304, '3 قفل الفترات', 'تعديل فاتورة الشراء موجودة', EXISTS (SELECT 1 FROM fn WHERE name = 'edit_purchase_invoice_atomic')),

  -- 4) إعادة ربط الجهاز بعد 5 أيام (20261111040000)
  (401, '4 ربط الجهاز', 'عمود app_licenses.device_bound_at',
     EXISTS (SELECT 1 FROM col WHERE tbl = 'app_licenses' AND name = 'device_bound_at')),
  (402, '4 ربط الجهاز', 'trigger تتبع ربط الجهاز',
     EXISTS (SELECT 1 FROM trg WHERE name = 'trg_track_license_device_binding' AND tbl = 'app_licenses')),
  (403, '4 ربط الجهاز', 'request_device_reset_secure موجودة', EXISTS (SELECT 1 FROM fn WHERE name = 'request_device_reset_secure')),

  -- 5) مفاتيح تشفير الحساب (20261111050000)
  (501, '5 مفاتيح التشفير', 'جدول account_encryption_keys موجود',
     EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'account_encryption_keys')),
  (502, '5 مفاتيح التشفير', 'RLS مفعّل على account_encryption_keys',
     COALESCE((SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'account_encryption_keys'), false)),

  -- 7) بوابة الكتابة للمشتركين (20261111070000)
  (701, '7 بوابة الاشتراك', 'has_paid_write_access لا يستدعيها زائر',
     EXISTS (SELECT 1 FROM fn WHERE name = 'has_paid_write_access')
     AND NOT EXISTS (SELECT 1 FROM fn WHERE name = 'has_paid_write_access' AND has_function_privilege('anon', oid, 'execute'))),
  (702, '7 بوابة الاشتراك', 'trigger البوابة على كل الجداول الموجودة',
     NOT EXISTS (
       SELECT 1 FROM gated g
       WHERE EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = g.tbl AND c.relkind = 'r')
         AND NOT EXISTS (SELECT 1 FROM trg WHERE name = 'a_paid_write_gate' AND tbl = g.tbl))),

  -- 8) المرحلة 1: الصلاحيات والحماية (20261111080000)
  (801, '8 المرحلة 1', 'عمود user_roles.can_refund',
     EXISTS (SELECT 1 FROM col WHERE tbl = 'user_roles' AND name = 'can_refund')),
  (802, '8 المرحلة 1', 'is_store_owner و can_refund_invoices موجودتان',
     EXISTS (SELECT 1 FROM fn WHERE name = 'is_store_owner') AND EXISTS (SELECT 1 FROM fn WHERE name = 'can_refund_invoices')),
  (803, '8 المرحلة 1', 'is_store_owner لا يستدعيها زائر',
     NOT EXISTS (SELECT 1 FROM fn WHERE name = 'is_store_owner' AND has_function_privilege('anon', oid, 'execute'))),
  (804, '8 المرحلة 1', 'الاسترداد الكامل يتحقق من صلاحية الاسترداد',
     EXISTS (SELECT 1 FROM fn WHERE name = 'refund_invoice_atomic' AND def ILIKE '%can_refund_invoices%')),
  (805, '8 المرحلة 1', 'الاسترداد الجزئي يتحقق من صلاحية الاسترداد',
     EXISTS (SELECT 1 FROM fn WHERE name = 'refund_invoice_partial_atomic' AND def ILIKE '%can_refund_invoices%')),
  (806, '8 المرحلة 1', 'trigger حماية حالة شطب الدين',
     EXISTS (SELECT 1 FROM trg WHERE name = 'b_guard_debt_writeoff_status' AND tbl = 'debts')),
  (807, '8 المرحلة 1', 'سياسة قراءة الإقفالات لأعضاء المتجر',
     EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'accounting_period_closures' AND policyname = 'Store members read closures')),
  (808, '8 المرحلة 1', 'revert_invoice_partner_profits_atomic لا يستدعيها زائر',
     NOT EXISTS (SELECT 1 FROM fn WHERE name = 'revert_invoice_partner_profits_atomic' AND has_function_privilege('anon', oid, 'execute'))),

  -- 9) المرحلة 2: الربح الموحّد (20261112010000)
  (901, '9 المرحلة 2', 'عمود invoices.paid_at_sale', EXISTS (SELECT 1 FROM col WHERE tbl = 'invoices' AND name = 'paid_at_sale')),
  (902, '9 المرحلة 2', 'trigger تسجيل المدفوع عند البيع',
     EXISTS (SELECT 1 FROM trg WHERE name = 'c_set_invoice_paid_at_sale' AND tbl = 'invoices')),
  (903, '9 المرحلة 2', 'أعمدة debt_writeoffs: loss_amount و pending_profit_cancelled',
     EXISTS (SELECT 1 FROM col WHERE tbl = 'debt_writeoffs' AND name = 'loss_amount')
     AND EXISTS (SELECT 1 FROM col WHERE tbl = 'debt_writeoffs' AND name = 'pending_profit_cancelled')),
  (904, '9 المرحلة 2', 'أعمدة الإقفال: realized_profit, pending_profit, bad_debt_loss, closing_timezone',
     (SELECT count(*) FROM col WHERE tbl = 'accounting_period_closures'
        AND name IN ('realized_profit','pending_profit','bad_debt_loss','closing_timezone')) = 4),
  (905, '9 المرحلة 2', 'شطب الدين يحسب الخسارة ويوزعها',
     EXISTS (SELECT 1 FROM fn WHERE name = 'writeoff_debt_atomic' AND def ILIKE '%loss_amount%')),
  (906, '9 المرحلة 2', 'إقفال الفترة بالمنطقة الزمنية (3 معاملات)',
     EXISTS (SELECT 1 FROM fn WHERE name = 'close_accounting_period_atomic' AND args ILIKE '%_timezone%')),
  (907, '9 المرحلة 2', 'نسخة الإقفال القديمة (معاملان) محذوفة',
     NOT EXISTS (SELECT 1 FROM fn WHERE name = 'close_accounting_period_atomic' AND args NOT ILIKE '%_timezone%')),
  (908, '9 المرحلة 2', 'الإقفال للمالك فقط',
     EXISTS (SELECT 1 FROM fn WHERE name = 'close_accounting_period_atomic' AND def ILIKE '%is_store_owner%')),
  (909, '9 المرحلة 2', 'trigger حماية الدين المشطوب',
     EXISTS (SELECT 1 FROM trg WHERE name = 'c_guard_written_off_debt' AND tbl = 'debts')),
  (910, '9 المرحلة 2', 'trigger حماية الفاتورة المعدومة',
     EXISTS (SELECT 1 FROM trg WHERE name = 'd_guard_written_off_invoice' AND tbl = 'invoices')),
  (911, '9 المرحلة 2', 'دوال الشطب والإقفال لا يستدعيها زائر',
     NOT EXISTS (SELECT 1 FROM fn WHERE name IN ('writeoff_debt_atomic','close_accounting_period_atomic') AND has_function_privilege('anon', oid, 'execute')))
)
SELECT phase AS "المرحلة",
       item  AS "البند",
       CASE WHEN ok THEN '✅' ELSE '❌' END AS "الحالة"
FROM checks
ORDER BY ok, ord;
