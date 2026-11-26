# خطة تطبيق S-2 على القاعدة الحية — للوكيل المنفّذ (ChatGPT أو غيره)

> **المطلوب منك:** تطبيق هجرة جاهزة ومُختبَرة على قاعدة Supabase الحية، التحقق منها، ثم دمج الفرع في `main`.
> **ممنوع:** كتابة SQL جديد، تعديل الهجرة، تعديل أي بيانات، أو تجاوز أي خطوة تحقق. إن فشلت خطوة: توقف واكتب التقرير.
> اقرأ أولاً `AGENTS.md` (القواعد) و`docs/FINANCE_LAW.md` القرار **D-32** (ما هو S-2 ولماذا).

## 1. أين يوجد كل شيء
| الشيء | المكان |
|---|---|
| المستودع | `almhtrf111312/posflowapp` |
| الفرع الجاهز | `ai/qa-fixes` — آخر كوميت للكود `1000a9e` (هذا الملف أُضيف بعده) |
| `main` الحالي | `5c1be2b` (لا يحتوي S-2 ولا إصلاحات `ai/verified-accounting-20261126`) |
| الهجرة المطلوب تطبيقها | `supabase/migrations/20261126170000_s2_block_direct_financial_tampering.sql` (167 سطراً) |
| سكربت التراجع | `supabase/live-snapshots/2026-11-26/ROLLBACK_s2_guards.sql` |
| الاختبارات | `supabase/tests/golden/scenarios.mjs` كتلة `S2` (26 حالة) |
| مشروع Supabase | `bwlqfxfvchjvehnbvwaz` |
| الإصدار | v1.5.283 (versionCode 671) — لا تعدّل `version.json` يدوياً |

**مطبّق مسبقاً على الحية (لا تُعِد تطبيقه):** كل الهجرات حتى `20261126161000_debt_payment_historical_replay.sql`، بما فيها
`20261126160000_settle_invoice_debts_atomic.sql`. **الوحيدة غير المطبقة:** `20261126170000`.

## 2. ما الذي تفعله الهجرة (باختصار)
تمنع التلاعب المباشر بالأرقام المالية عبر REST (من يملك توكن مستخدم ويرسل طلبات بنفسه). تعمل بمشغّلات `SECURITY INVOKER`
تتحقق فقط عندما يكون `current_user` هو `authenticated`/`anon`، لذلك **كل دوال RPC الذرية (SECURITY DEFINER) وEdge Functions
(service_role) لا تتأثر**:
- `shift_transactions`: سجل ثابت (لا تعديل ولا حذف مباشر)؛ الإدخال المباشر لوردية مفتوحة من نفس المتجر وبمبلغ > 0؛
  الوردية المغلقة تُرفض برسالة فيها `(F-20)`.
- `debts`: لا إدخال مباشر، ولا تغيير مباشر للمبالغ أو الحالة (الملاحظات مسموحة).
- `profit_records`: لا إدخال ولا حذف مباشر؛ مدير المتجر فقط يعلّم السجل «ملغى».
- `cash_shifts`: الوردية المغلقة لا تُعدَّل؛ رصيد الافتتاح والإغلاق لا يتغيران مباشرة. فتح الوردية مسموح.
- الكاشير فقط (ليس المالك/boss): لا يغيّر مبالغ الفاتورة/حالتها، ولا بنودها، ولا كلفة المنتج.
- سحب EXECUTE من العملاء على `receive_stock_wac` و`post_shift_sale_atomic` (التطبيق لا يستدعيهما).

شروط المالك المحققة: القراءة لم تتغير، والمالك/boss يديرون المتجر والحسابات كما قبل.

## 3. الخطوات (بالترتيب، لا تتخطَّ شيئاً)

### الخطوة 0 — نسخة احتياطية
اطلب من المالك أن يؤكد أنه أخذ نسخة احتياطية (Supabase ← Database ← Backups). **لا تكمل بدون تأكيده.**

### الخطوة 1 — تحقق من الكود على الفرع (محلياً إن أمكنك)
```bash
git fetch origin && git checkout ai/qa-fixes
npm ci
npm run finance:sql          # يجب: FINANCE SQL GATE: 385/385 ... GREEN
npm run finance:check        # يجب: FINANCE GATE: GREEN
npx tsc --noEmit -p tsconfig.app.json   # خرج 0
npm run maps:check           # all 27 maps up to date
npm run build                # خرج 0
npm run lint                 # 31 خطأ قديم بالضبط (لا تزيد)
```
إن لم تستطع تشغيلها، اكتب ذلك صراحة في التقرير ولا تدّعِ نتيجة.

### الخطوة 2 — فحص الحالة الحية قبل التطبيق (قراءة فقط)
```sql
select (select count(*) from pg_trigger where tgname in ('a0_guard_direct','a0_guard_cashier_direct')) as triggers,   -- يجب 0
       (select count(*) from pg_proc where proname = 'settle_invoice_debts_atomic') as settle_fn,                     -- يجب 1
       has_function_privilege('authenticated','public.receive_stock_wac(uuid,numeric,numeric,text)','EXECUTE') as wac; -- يجب true
```
إن كانت `triggers` ≠ 0 فالهجرة طُبّقت (جزئياً أو كلياً): توقف وأبلغ.

### الخطوة 3 — التطبيق
طبّق **نص الملف كما هو حرفياً** `supabase/migrations/20261126170000_s2_block_direct_financial_tampering.sql`
(أداة `apply_migration` باسم `s2_block_direct_financial_tampering`، أو SQL Editor). إن طلبت Supabase تأكيداً فهذا
متوقَّع (فيها `DROP TRIGGER IF EXISTS`) ويحتاج موافقة المالك. لا تقسم الملف ولا تعدّله.

### الخطوة 4 — التحقق بعد التطبيق (قراءة فقط)
```sql
select (select count(*) from pg_trigger where tgname in ('a0_guard_direct','a0_guard_cashier_direct')) as triggers,  -- يجب 7
       has_function_privilege('authenticated','public.receive_stock_wac(uuid,numeric,numeric,text)','EXECUTE') as wac, -- يجب false
       has_function_privilege('authenticated','public.post_shift_sale_atomic(uuid,text,numeric,text,numeric,numeric,text)','EXECUTE') as post; -- يجب false
```
ثم مطابقة الحية مع المستودع: شغّل `npm run -s db:drift-sql -- --summary`، ونفّذ الاستعلام الذي يطبعه على الحية.
**البصمات المتوقعة** (المستودع عند `1000a9e`):
| البصمة | القيمة |
|---|---|
| fn | `ee609a9ce0284c6207d3950889faab06` |
| cols | `fa6e951087d57cdd83b24e9c3954cb68` |
| trg | `0db5db76c58d7059e458cb13b2c03c02` |
| idx | `244fde4976975ae4dc10114fcfd137c7` |
إن اختلفت أي بصمة: شغّل `npm run -s db:drift-sql` (بدون `--summary`) على الحية لمعرفة الفرق بالضبط وأبلغ به.

### الخطوة 5 — اختبار دخاني على الحية داخل معاملة تُلغى (لا يغيّر أي بيانات)
نفّذه **كاستعلام واحد**؛ ينتهي بـ `ROLLBACK` إجبارياً. اختر معرّف مالك متجر حقيقي من:
`select user_id from public.user_roles where role = 'admin' limit 1;` وضعه مكان `<OWNER_ID>`.
```sql
begin;
select set_config('request.jwt.claim.sub', '<OWNER_ID>', true),
       set_config('request.jwt.claims', json_build_object('sub','<OWNER_ID>','role','authenticated')::text, true);
set local role authenticated;
do $t$
declare n int;
begin
  begin
    delete from public.shift_transactions where id = (select id from public.shift_transactions limit 1);
    get diagnostics n = row_count;
    raise notice '%', case when n = 0 then 'SKIP: this owner has no drawer movement to test' else 'FAIL: direct delete of a drawer movement was allowed' end;
  exception when others then raise notice 'PASS: drawer movement delete refused: %', sqlerrm; end;
  begin
    update public.debts set total_paid = coalesce(total_paid, 0) + 1 where id = (select id from public.debts limit 1);
    get diagnostics n = row_count;
    raise notice '%', case when n = 0 then 'SKIP: this owner has no debt to test' else 'FAIL: direct debt amount change was allowed' end;
  exception when others then raise notice 'PASS: debt amount change refused: %', sqlerrm; end;
end $t$;
rollback;
```
المتوقع: سطرا `PASS` (أو `SKIP` إن لم توجد صفوف لهذا المالك — جرّب مالكاً آخر). أي `FAIL` = طبّق التراجع (الخطوة 7) وأبلغ.
إن لم تسمح أداتك بـ `set local role` فاكتب ذلك ولا تخترع نتيجة.

### الخطوة 6 — الدمج في `main` (فقط بعد نجاح 4 و5)
```bash
git checkout main && git pull origin main
git merge --no-ff ai/qa-fixes -m "Merge verified accounting fixes and S-2 (D-32)"
npm run finance:sql && npm run build   # تأكيد أخير
git push origin main
```
ممنوع `--force` وممنوع إعادة كتابة التاريخ. إن ظهر تعارض: توقف وأبلغ.

### الخطوة 7 — التراجع (فقط عند فشل الخطوة 4 أو 5)
طبّق `supabase/live-snapshots/2026-11-26/ROLLBACK_s2_guards.sql` كما هو، ثم كرر استعلام الخطوة 2 (يجب `triggers = 0`، `wac = true`).
لا تدمج في `main` في هذه الحالة.

## 4. ما يجب أن يحتويه تقريرك (بالعربية، مختصر، بلا ادعاءات غير مُتحقَّقة)
1. هل أكّد المالك النسخة الاحتياطية؟ (نعم/لا)
2. مخرجات الخطوة 1 **كما هي** (أو «لم أستطع تشغيلها» والسبب).
3. نتيجة استعلام الخطوة 2 (الأرقام الثلاثة).
4. هل نجح التطبيق؟ نص أي رسالة خطأ كما هي.
5. نتيجة الخطوة 4: الأرقام الثلاثة + البصمات الأربع من الحية بجانب المتوقعة (متطابق/مختلف).
6. نتيجة الخطوة 5: سطور `PASS`/`FAIL` كما ظهرت.
7. هل دمجت في `main`؟ رقم كوميت الدمج، أو لماذا لم تدمج.
8. هل استخدمت التراجع؟ ولماذا.
9. أي شيء غير متوقع لاحظته (حتى لو لم تغيّره).
