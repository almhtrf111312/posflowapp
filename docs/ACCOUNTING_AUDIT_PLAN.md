# خطة الفحص المحاسبي الشامل — PosFlow

> لمن يفحص التطبيق (إنسان أو Claude أو أي ذكاء صناعي آخر). اقرأ **الجزء 3 (قرارات مقصودة ليست أخطاء)** قبل أن تبلّغ عن أي مشكلة.
> المرجع الأعلى: `docs/FINANCE_LAW.md`. هذا الملف لا يغيّره؛ يشرح كيف تفحص وماذا تعتبره خطأً.

## دليل الوكيل — اقرأه أولاً (خطة لنموذجين)

هذه الخطة مكتوبة لنوعين من الوكلاء. حدّد نوعك ثم اتبع مساره فقط. **لا تنفّذ مهمة خارج صلاحياتك؛ إن تعذّر شيء اكتبه في التقرير "لم يُنفَّذ: السبب" ولا تخمّن نتيجته.**

| | **المسار A — بلا وصول (مثل Gemini في وضع المهام/Agent mode)** | **المسار B — بوصول إلى Supabase وGitHub (مثل ChatGPT مع موصّلات Supabase وGitHub)** |
|---|---|---|
| مصدر الكود | ملف ZIP لآخر نسخة من `main` يرفقه المالك | اسحب آخر `main` من `almhtrf111312/posflowapp` بنفسك؛ لا تنتظر الملف المرفق |
| بيانات القاعدة الحية | **لا وصول.** استعمل النتائج المسجّلة في **الجزء 7** من هذا الملف (شُغّلت على القاعدة الحية 2026-11-26) | شغّل استعلامات **الجزء 4** بنفسك على المشروع `bwlqfxfvchjvehnbvwaz` (قراءة فقط) وقارنها بالجزء 7 |
| تشغيل الأوامر | إن كان "الكمبيوتر عن بُعد" مع الوصول إلى الشبكة مفعّلاً: فك الـ ZIP وشغّل أوامر الجزء 1 (`npm ci` يحتاج الشبكة). إن لم يكن: افحص بالقراءة فقط وقل ذلك صراحة | شغّلها إن كان لديك بيئة تنفيذ؛ وإلا اكتفِ بالقراءة والاستعلامات |
| تطابق السحابة مع الكود | قارن بصمات **7.1** بما يطبعه `npm run -s db:drift-sql -- --summary` في نسختك | شغّل الاستعلام الذي يطبعه الأمر نفسه على القاعدة الحية مباشرة |
| فحص الواجهة (الجزء 2-C) | **لا تنفّذه** (يحتاج التطبيق شغّالاً وحساب اختبار) | لا تنفّذه إلا بطلب المالك |
| الكتابة | لا شيء. تقرير فقط | لا SQL كتابة ولا هجرة ولا push. تقرير فقط، والمالك يقرر |

### تقسيم العمل على وكلاء (إن كانت منصتك تسمح بعدة وكلاء أو مهام متوازية)
كل حزمة مستقلة ويمكن إسنادها لوكيل منفصل؛ كلما زاد عدد الوكلاء قلّ ما يقرؤه كل واحد وزادت الدقة. إن كانت منصتك تشغّل وكيلاً واحداً فقط، نفّذ الحزم بالترتيب كمهام منفصلة، وابدأ كل حزمة بإعادة قراءة "دليل الوكيل" والجزء 3.
| الحزمة | المهمة | الملفات | المسار |
|---|---|---|---|
| W1 | البوابات الآلية (الجزء 1) | المستودع كله | A إن وُجد تنفيذ، B |
| W2 | مراجعة المبيعات والاسترداد مقابل القانون (F-07, F-09, F-16, D-15, D-19, D-22) | `supabase/migrations/2026112*`, `src/lib/cloud/pos-sale-atomic.ts`, `src/pages/Invoices.tsx` | A, B |
| W3 | الديون والدفعات ورصيد العميل (F-12, F-13, F-27, D-20, D-23) | `docs/audit/SCHEMA_LOGIC_REFERENCE.sql` (دوال `record_debt_payment_atomic`, `*_store_credit_*`), `src/lib/store-credit-op.ts` | A, B |
| W4 | الورديات والصندوق والمزامنة بلا اتصال (F-18, D-16..D-18, D-24..D-26, KD-06) | `src/lib/cashbox-store.ts`, `src/lib/shift-adopt.ts`, `src/lib/cloud/cashbox-cloud.ts`, `src/lib/cloud/sync-operation-processor.ts` | A, B |
| W5 | الشركاء والمصاريف والمشتريات (F-11, F-21, F-22, D-08, D-09, D-25) | دوال `partner_*`, `add_expense_atomic`, `*purchase*` في ملف SQL المرجعي | A, B |
| W6 | التقارير مقابل الأرقام (D-21, D-22, D-24) | `src/pages/Reports.tsx`, `src/components/reports/*`, `src/lib/profit-engine.ts`, `src/lib/report-metrics.ts` | A, B |
| W7 | بيانات القاعدة الحية (الجزء 4) | — | B فقط (A يقرأ الجزء 7) |
| W8 | فحص الكود D1..D9 (الجزء 2-D) | `src/` | A, B |

**تجميع النتائج:** وكيل أخير يدمج تقارير الحزم، يحذف المكرر، ويستبعد كل ما يقع تحت الجزء 3، ثم يكتب التقرير بصيغة 2-E.

### حدود يجب احترامها
- ملف `docs/audit/SCHEMA_LOGIC_REFERENCE.sql` كبير (~450 KB): اقرأه بالبحث عن اسم الدالة، لا كاملاً دفعة واحدة.
- لا تعتبر شيئاً خطأً لأنه "غير مألوف"؛ راجع الجزء 3 أولاً ثم `docs/FINANCE_LAW.md`.
- كل ادعاء بخطأ يحتاج: الملف والسطر أو الاستعلام والصف، والقاعدة المخالفة.

## 0. قواعد الفاحص
1. **القراءة فقط على القاعدة الحية.** كل استعلامات هذا الملف `SELECT`. لا تكتب ولا تصحّح بيانات بدون موافقة المالك.
2. الخطأ يُثبت بدليل: اسم الفحص + الصفوف الراجعة + القاعدة المخالفة (`F-xx` أو `D-xx`).
3. ما ورد في **الجزء 3** ليس خطأً حتى لو بدا كذلك في أنظمة أخرى.
4. بيانات حساب الاختبار ليست مرجعاً للأخطاء (فيها آثار تجارب مقصودة، انظر 3.6).
5. أي إصلاح: ملف هجرة جديد (لا تعديل لهجرة قديمة) + اختبار ذهبي + البوابات في 1.

## 1. البوابات الآلية (كود التطبيق) — تُشغَّل أولاً
| الأمر | النجاح |
|---|---|
| `npm ci` | — |
| `npm run finance:sql` | `FINANCE SQL GATE: GREEN` (اليوم 294/294) — قاعدة مبنية من الهجرات + سيناريوهات ذهبية + استعلامات المطابقة |
| `npm run finance:check` | `FINANCE GATE: GREEN` (اختبارات على كود الإنتاج: الأرباح، الورديات، رصيد العميل، المصاريف المعكوسة…) |
| `npx tsc --noEmit -p tsconfig.app.json` | 0 أخطاء (لا `npx tsc --noEmit` المجرد: لا يفحص شيئاً) |
| `npm run maps:check` | `all N maps up to date` |
| `npm run build` | exit 0 |
| `npm run lint` | لا يزيد عن خط الأساس (اليوم 31) |

## 2. خطة الفحص المعمّق

### A. تطابق السحابة مع المستودع
- **A1 سريع:** `npm run -s db:drift-sql -- --summary` يطبع 4 بصمات + استعلاماً. شغّل الاستعلام على القاعدة الحية؛ تساوي البصمات الأربع = تطابق تام (الدوال، الأعمدة، المشغّلات، الفهارس).
- **A1 تفصيلي:** `npm run -s db:drift-sql > drift.sql` ثم شغّله حياً: يعيد فقط المختلف (`ONLY_LIVE` / `ONLY_IN_REPO` / `DIFFERENT`).
- **A2 مرجع SQL الكامل:** `docs/audit/SCHEMA_LOGIC_REFERENCE.sql` يحوي نص كل الدوال (182) والعروض (5) والمشغّلات (87) مع بصمة مُطبَّعة لكل دالة. للمقارنة مع أي نسخة أخرى: احسب على الطرف الآخر
  `md5(regexp_replace(regexp_replace(prosrc,'--[^\n]*','','g'),'[[:space:]]+','','g'))` وقارنها بالبصمة المكتوبة فوق الدالة.
- **A3 الدقة:** لا عمود مالي بأقل من 8 منازل (الاستعلام X-11 أدناه).

### B. سلامة البيانات المالية (القاعدة الحية، قراءة فقط)
شغّل **كل** استعلامات الجزء 4. كل استعلام "بوابة" يجب أن يعيد **صفر صفوف**. أي صف = خطأ يُبلَّغ مع الصفوف.

### C. سيناريوهات الواجهة (حساب اختبار فقط — **لا ينفّذها المسار A**)
لكل سيناريو: نفّذ من الواجهة ثم تحقق بالاستعلام المذكور.
| # | السيناريو | المتوقع | التحقق |
|---|---|---|---|
| C1 | بيع نقدي متصل، مع وردية | فاتورة + حركة `sale` واحدة في الوردية | X-5 |
| C2 | بيع نقدي **بلا وردية** | فاتورة صحيحة، بلا حركة درج (مسموح، 3.1) | — |
| C3 | جهاز جديد + وردية مفتوحة سحابياً → بيع نقدي | الحركة تدخل الوردية المفتوحة (D-26) | X-5 |
| C4 | بيع آجل بدفعة أولى | دين = الإجمالي − الدفعة؛ صف `debt_payments` بمعرّف `…:down`؛ حركة `sale` بالدفعة | R-02 |
| C5 | سداد دين نقداً / تحويلاً | نقداً: حركة `debt_payment`؛ تحويلاً: بلا حركة | R-02, R-04 |
| C6 | استرداد كلي/جزئي (نقدي، آجل بدفعة، بضريبة، بخصم) | المبلغ = المدفوع فعلاً بنسبة `total/subtotal`؛ حركة `refund` واحدة؛ المخزون يعود | R-04, X-12 |
| C7 | مصروف ثم عكسه (متصل وبلا اتصال) | حركتان `expense` + `expense_refund`؛ درج الجهاز = السحابة | R-05a |
| C8 | بلا اتصال: بيع نقدي، بيع آجل، مصروف، إغلاق وردية، ثم إعادة الاتصال | كل عملية مرة واحدة (لا تكرار) | R-04, X-9 |
| C9 | جلستان تبيعان في اللحظة نفسها | فاتورتان بأرقام مختلفة، حركتان، المخزون −2 | X-9 |
| C10 | إغلاق وردية بعدّ مطابق / ناقص / بعملتين | الفرق = المعدود − المحسوب من الحركات (F-18) | X-1 |
| C11 | رصيد عميل: إصدار، سداد دين منه، صرف نقدي | سداد الدين بلا حركة درج؛ الصرف حركة `store_credit_refund` | X-8 |
| C12 | شريك فئة + شريكان عامّان، بيع نقدي ثم استرداد | حصة الفئة أولاً ثم العامّون من الباقي؛ الاسترداد يعيدها | R-08 |
| C13 | شراء، مرتجع شراء، إلغاء فاتورة مدفوعة | المتوسط المرجّح بـ 8 منازل؛ الإلغاء يعود لوردية مفتوحة يختارها المستخدم | R-09 |
| C14 | التقارير: الملخص، الكاشير، الإغلاق اليومي، الضريبة، الأعمار، الأرباح والخسائر | كلها تطابق القاعدة (انظر 3.3 للضريبة) | X-13 |

### D. فحص الكود (يدوي، بالترتيب)
| # | ماذا تفحص | أين | ما يُعتبر خطأ |
|---|---|---|---|
| D1 | كل كتابة مالية تمر عبر RPC ذري وليس `insert/update` مباشر على أعمدة مالية | `src/lib/cloud/*` | كتابة مباشرة على `total_paid`, `remaining_debt`, `expected_balance`, `current_balance` |
| D2 | كل عملية مالية متصلة لها مسار طابور بلا اتصال بنفس `operation_id` | `src/lib/sync-queue.ts`, `src/lib/cloud/sync-operation-processor.ts` | `crypto.randomUUID()` يُولَّد داخل دالة الإرسال بدل مرة واحدة لكل فعل مستخدم |
| D3 | التقريب: `round8` داخلياً، العرض فقط بـ `formatCurrency` | `src/lib/money-engine.ts` | `toFixed(2)` في حساب يُخزَّن |
| D4 | لا رموز عملات أو أسعار صرف ثابتة في الكود | كل `src/` | `'$'` أو `89500` مكتوبة يدوياً في منطق |
| D5 | الدرج المحلي يُحدَّث مرة واحدة لكل حركة سحابية | `src/lib/cashbox-store.ts`, `src/lib/unified-transactions.ts`, `src/lib/drawer-expense-marks.ts` | خصم/إرجاع مزدوج، أو حركة سحابية بلا مقابل محلي |
| D6 | التقارير تقرأ السحابة، لا سجلات الجهاز المحلية | `src/pages/Reports.tsx`, `src/components/reports/*` | استعمال `profits-store` المحلي لأرقام معروضة |
| D7 | `expenseIsCounted` يُستدعى بشكل يقرأ `is_reversed` | `src/lib/profit-engine.ts` | — (أُصلح 2026-11-26) |
| D8 | لا مسح بيانات محلية تلقائي | كل `src/` | `localStorage.clear()`، `deleteDatabase` خارج إجراء يدوي مؤكَّد |
| D9 | استدعاءات `@capacitor/*` محمية بـ `isNativePlatform()` | كل `src/` | استيراد ثابت لملحق أصلي في كود مشترك |

### E. الإبلاغ
لكل خطأ: رقم الفحص، الاستعلام، الصفوف، القاعدة المخالفة، خطوات إعادة الإنتاج، والملف/الدالة المسؤولة. ثم إصلاح + اختبار + البوابات + V7 (A1) + V8 (الجزء 4) قبل الرفع.

## 3. قرارات مقصودة — **ليست أخطاء** (خيارات المالك)
| # | السلوك | لماذا قد يبدو خطأً | القرار |
|---|---|---|---|
| 3.1 | البيع النقدي والشراء وكل العمليات تعمل **بدون وردية مفتوحة** | أنظمة كثيرة تمنع البيع بلا وردية | قرار المالك. الفاتورة تُسجَّل بلا حركة درج. **استثناء:** سداد دين نقداً يحتاج وردية (التحويل لا). |
| 3.2 | الدفعة المقبوضة عند البيع الآجل = **دفعة دين** (صف `debt_payments` بمعرّف `…:down`)، لا يوجد مفهوم "عربون" مستقل | أنظمة تفصل العربون | D-15. الاسترداد يتجاوز صف `:down` لأنه إيصال البيع (لا يُرد مرتين). |
| 3.3 | **المبيعات المعروضة شاملة الضريبة** في كل التقارير ولوحة التحكم | أنظمة محاسبية تعرض الصافي | D-22 باختيار المالك. تقرير الضريبة يعرض "المبيعات بدون ضريبة" بجانب الضريبة، والربح دائماً بدون ضريبة (F-07). |
| 3.4 | الاسترداد الجزئي **يعيد كتابة الفاتورة** (الإجمالي والربح الجديدان) والبند المسترد يبقى ظاهراً مشطوباً | أنظمة تُنشئ إشعار دائن منفصل | قرار المالك. دفتر الأحداث `invoice_accounting_events` يحفظ التاريخ فلا يُحسب المرتجع مرتين (J-10). |
| 3.5 | `cash_shifts.expected_balance` لا يُحدَّث ببيع نقدي من العميل أثناء الوردية | يبدو رصيداً خاطئاً | KD-06: هو ذاكرة تقريبية. **الحقيقة = الافتتاح + الوارد − الصادر من `shift_transactions`** (F-18)، والإغلاق يحسبها من الحركات. لذلك R-07 معلوماتي لا بوابة. |
| 3.6 | فاتورة `20261125-00016`، وفواتير نقدية `20261125-00018..22` و`20261126-00027` بلا حركة درج، ومصروف تجريبي عالق في طابور جهاز اختبار | تظهر في X-5 أو X-3 | بيانات حساب الاختبار من تجارب مقصودة؛ المالك قرر عدم تصحيحها. |
| 3.7 | وردية واحدة مفتوحة لكل كاشير، والخادم هو من يقرر عند التعارض | أنظمة تسمح بعدة ورديات | D-16. الجهاز الذي يُرفض له فتح وردية يتبنّى المفتوحة. |
| 3.8 | مصروف سُجّل بلا اتصال على وردية أُغلقت قبل المزامنة يُسجَّل **بلا حركة درج** | يبدو أن المصروف "خرج" من لا مكان | D-25: نقده احتُسب عند عدّ الإغلاق؛ ترحيله للوردية الحالية يحسبه مرتين. |
| 3.9 | سداد دين من رصيد المتجر يُسجَّل بطريقة `transfer` | يبدو تحويلاً بنكياً | D-20: رصيد المتجر ليس نقداً في الدرج؛ معرّف العملية `credit:<op>`. |
| 3.10 | الدين بعملة أجنبية يُسدَّد بسعر الفاتورة الأصلي، والفرق يُسجَّل "فرق صرف" منفصل عن ربح المبيعات | يبدو الربح غير مطابق | F-27 / D-04 / D-06. |
| 3.11 | حصة شريك الفئة تُحسب **أولاً**، ثم الشركاء العامّون من **الباقي**، والباقي للمالك | أنظمة توزع بالتوازي | F-21 / D-08 (الأرباح)، D-09 (المصاريف: الفئة من الإجمالي). |
| 3.12 | الاستلام المجاني (تكلفة 0) لا يخفض المتوسط المرجّح | يبدو أنه يجب أن يخفضه | F-11. |
| 3.13 | المخزون السالب ممنوع افتراضياً، ومسموح إن فعّله المالك؛ المطعم/المخبز لا يتتبع المخزون | يبدو تناقضاً | إعداد المتجر ونوعه. |
| 3.14 | العملات: LBP 89500 وLYD 4.85 (معطّلة) | الخطة القديمة افترضت 90000 و5 | قرار المالك؛ الأسعار تُقرأ من الإعدادات ولا تُكتب في الكود. |
| 3.15 | سعر الصرف لا يتغير أثناء وردية مفتوحة (`guard_fx_change_during_open_shift`) | يبدو تقييداً | يحمي مطابقة الدرج متعدد العملات. |
| 3.16 | المنتج بمخزون صفر يبقى ظاهراً في النشطة بكمية حمراء **ويظهر أيضاً** في الأرشيف | يبدو تكراراً | مقصود: لا يبدو محذوفاً، وإعادة التزويد من الأرشيف. |
| 3.17 | حذف المستخدم/الدين/الفاتورة غير موجود؛ الإلغاء والشطب والعكس يحفظ السجل بحالته | يبدو أن "الحذف لا يعمل" | ثوابت AGENTS.md (لا حذف نهائي للمال). |
| 3.18 | زر Excel العلوي في تبويب "حركة منتج" يصدّر ملخص كل المنتجات | يبدو أنه لا يطابق الشاشة | تصدير المنتج المختار من زر "تصدير Excel" داخل التبويب. |
| 3.19 | مسار بناء APK يعمل يدوياً فقط | يبدو أن الدفع لا يبني | قرار المالك. |

## 4. استعلامات SQL الكاملة (قراءة فقط)

### 4.1 استعلامات المطابقة R-01 … R-09 (نص الملف كما هو)

```sql
-- ============================================================================
-- FINANCE RECONCILIATION (READ-ONLY) — docs/FINANCE_LAW.md §5, gate G4
--
-- SELECT statements only. Nothing here writes, locks or alters anything.
-- Run each query separately in the Supabase SQL editor. EVERY QUERY MUST RETURN ZERO ROWS.
-- A returned row is a violation of the invariant named in the header comment: report it, never "fix" data
-- by hand and never edit the query to make it pass (docs/FINANCE_LAW.md §6).
--
-- Columns used are the stable ones (generated types + migrations). Gates are R-01..R-06, R-08 and R-09; R-07 is information only.
-- The golden-case harness (npm run finance:sql) runs this very file against a database built from the migrations.
-- ============================================================================


-- R-01 [F-13] Debt arithmetic: total_paid + remaining_debt = total_debt, no negative amounts.
-- Only open/paid debts: other statuses (cancelled, written off...) legitimately break the identity.
select id, user_id, status, total_debt, total_paid, remaining_debt,
       round((coalesce(total_paid,0) + coalesce(remaining_debt,0)) - coalesce(total_debt,0), 4) as diff
from public.debts
where status in ('due', 'partially_paid', 'fully_paid')
  and (   abs((coalesce(total_paid,0) + coalesce(remaining_debt,0)) - coalesce(total_debt,0)) > 0.01
       or coalesce(remaining_debt,0) < -0.0001
       or coalesce(total_paid,0)    < -0.0001);


-- R-02 [F-13] Debt paid total equals the sum of what its payments settled (settled_amount; `amount` is the cash received).
-- Only debts created after debt_payments went live (2026-11-05): older rows may legitimately predate it.
select d.id, d.user_id, d.total_paid, coalesce(sum(p.settled_amount), 0) as settled_sum,
       round(coalesce(d.total_paid,0) - coalesce(sum(p.settled_amount), 0), 4) as diff
from public.debts d
left join public.debt_payments p on p.debt_id = d.id
where d.status in ('due', 'partially_paid', 'fully_paid')
  and d.created_at >= timestamptz '2026-11-05'
group by d.id, d.user_id, d.total_paid
having abs(coalesce(d.total_paid,0) - coalesce(sum(p.settled_amount), 0)) > 0.01;


-- R-03 [F-19, F-20] Every drawer movement belongs to a shift of the same owner, and none was posted after its shift closed.
-- (surplus/shortage are excluded: they are legitimately written when a variance is resolved after closing.)
select t.id, t.shift_id, t.type, t.amount, t.created_at, s.closed_at,
       case when s.id is null then 'orphan: no such shift'
            when s.user_id <> t.user_id then 'owner mismatch'
            else 'posted after the shift closed' end as problem
from public.shift_transactions t
left join public.cash_shifts s on s.id = t.shift_id
where s.id is null
   or s.user_id <> t.user_id
   or (s.closed_at is not null
       and t.created_at > s.closed_at + interval '1 minute'
       and t.type not in ('surplus', 'shortage'));


-- R-04 [F-19] A cash movement is posted once: no duplicate (shift, type, reference).
select shift_id, type, reference_id, count(*) as copies
from public.shift_transactions
where reference_id is not null
group by shift_id, type, reference_id
having count(*) > 1;


-- R-05a [F-22] A reversed expense that moved the drawer must have its refund movement.
select e.id, e.user_id, e.amount, e.reversed_at
from public.expenses e
where coalesce(e.is_reversed, false)
  and exists     (select 1 from public.shift_transactions t where t.type = 'expense'        and t.reference_id = e.id::text)
  and not exists (select 1 from public.shift_transactions t where t.type = 'expense_refund' and t.reference_id = e.id::text);


-- R-05b [F-17, F-22] Every 'expense' drawer movement points at a real expense (reference_id = expenses.id).
-- legacy_ref = true marks rows written by the old client path (reference "exp_<timestamp>"): they predate the
-- fix and cannot be reversed by delete_expense_atomic — review them, do not delete them.
select t.id, t.shift_id, t.amount, t.reference_id, t.created_at,
       (t.reference_id like 'exp\_%') as legacy_ref
from public.shift_transactions t
where t.type = 'expense'
  and not exists (select 1 from public.expenses e where e.id::text = t.reference_id);


-- R-06 [F-27] FX difference consistency for debt payments credited at the invoice rate (needs migration
-- 20261123071000_debt_payment_invoice_rate_fx_difference.sql to be applied; before that the column does not exist).
select id, debt_id, amount, settled_amount, fx_difference_usd, fx_credit_rate
from public.debt_payments
where fx_credit_rate is not null
  and abs(fx_difference_usd - (amount - settled_amount)) > 0.0001;


-- R-08 [F-21, D-09] An expense never allocates more to partners than the expense itself (reversed expenses excluded).
-- The owner's share is the remainder and is not stored, so the partner rows must always sum to at most the amount.
select e.id, e.user_id, e.amount, sum((d->>'amount')::numeric) as allocated
from public.expenses e
cross join lateral jsonb_array_elements(coalesce(e.distributions, '[]'::jsonb)) d
where not coalesce(e.is_reversed, false)
group by e.id, e.user_id, e.amount
having sum((d->>'amount')::numeric) > e.amount + 0.01;


-- R-09 [F-25, audit F7] A credit quick purchase is linked to a supplier and has its purchase entry.
select pi.id, pi.invoice_number, pi.supplier_id, pi.actual_grand_total
from public.purchase_invoices pi
where pi.payment_method = 'credit'
  and pi.status in ('finalized', 'completed')
  and pi.supplier_id is null
  and pi.invoice_number like 'QP-%';


-- R-07 [F-18] INFORMATION ONLY — NOT a gate (KD-06). cash_shifts.expected_balance is a best-effort cache during an open shift:
-- cash sales, client deposits, quick purchases and FX conversions write drawer movements without updating it. The
-- authoritative balance is the sum of shift_transactions, recomputed when the shift closes. Non-zero drift here is expected.
with tx as (
  select shift_id,
         sum(case
               when type in ('sale','deposit','deposit_capital','deposit_revenue','deposit_purchase_cover',
                             'debt_payment','surplus','expense_refund','supplier_refund','fx_in','transfer_in') then amount
               when type in ('expense','refund','withdrawal','supplier_payment','store_credit_refund',
                             'shortage','fx_out','transfer_out') then -amount
               else 0 end) as net
  from public.shift_transactions
  group by shift_id
)
select s.id, s.user_id, s.opened_at, s.opening_balance, s.expected_balance,
       round(coalesce(s.opening_balance,0) + coalesce(tx.net,0), 2) as recomputed_from_movements,
       round(coalesce(s.expected_balance,0) - (coalesce(s.opening_balance,0) + coalesce(tx.net,0)), 2) as cache_drift
from public.cash_shifts s
left join tx on tx.shift_id = s.id
where s.closed_at is null;
```

### 4.2 فحوص إضافية X-1 … X-13

```sql
-- X-1 [F-18] Closed shift: variance = counted − (opening + inflows − outflows), movements excluding the closing surplus/shortage rows.
select id, actual_balance, variance, f18, round(actual_balance - f18 - variance, 4) as gap
from (select s.id, s.actual_balance, s.variance,
        s.opening_balance + coalesce(sum(case
          when t.type in ('sale','deposit','deposit_capital','deposit_revenue','deposit_purchase_cover','debt_payment','expense_refund','supplier_refund','fx_in','transfer_in') then t.amount
          when t.type in ('expense','refund','withdrawal','supplier_payment','store_credit_refund','fx_out','transfer_out') then -t.amount else 0 end), 0) as f18
      from public.cash_shifts s left join public.shift_transactions t on t.shift_id = s.id
      where s.closed_at is not null and s.actual_balance is not null and s.variance is not null
      group by s.id) x
where abs(actual_balance - f18 - variance) > 0.01;

-- X-2 [D-16] At most one open shift per cashier.
select user_id, coalesce(cashier_id, user_id) as cashier, count(*) from public.cash_shifts
where closed_at is null group by 1, 2 having count(*) > 1;

-- X-3 [D-15] A credit invoice that took money at the sale has its sale receipt in a drawer (only when a shift was open; see 3.1).
select i.invoice_number, i.paid_at_sale from public.invoices i
where i.payment_type = 'debt' and coalesce(i.paid_at_sale, 0) > 0 and i.status <> 'refunded'
  and exists (select 1 from public.cash_shifts s where s.user_id = i.user_id and s.opened_at <= i.created_at and (s.closed_at is null or s.closed_at >= i.created_at))
  and not exists (select 1 from public.shift_transactions t where t.type = 'sale' and t.reference_id in (i.invoice_number, i.operation_id::text, i.id::text));

-- X-4 [F-13] Every credit invoice has its debt row; a refunded invoice has no open debt.
select i.invoice_number, 'no debt row' as problem from public.invoices i
where i.payment_type = 'debt' and i.status not in ('refunded', 'cancelled')
  and not exists (select 1 from public.debts d where d.invoice_id = i.invoice_number)
union all
select i.invoice_number, 'refunded but debt open' from public.invoices i join public.debts d on d.invoice_id = i.invoice_number
where i.status = 'refunded' and d.status in ('due', 'partially_paid');

-- X-5 [D-26] A cash invoice made while the seller had an open shift has its drawer sale (shifts are optional: see 3.1).
select i.invoice_number, i.total, i.created_at from public.invoices i
where i.payment_type = 'cash' and coalesce(i.payment_method, 'cash') = 'cash' and i.status <> 'refunded'
  and exists (select 1 from public.cash_shifts s where s.user_id = i.user_id and coalesce(s.cashier_id, s.user_id)::text = coalesce(i.cashier_id::text, i.user_id::text)
              and s.opened_at <= i.created_at and (s.closed_at is null or s.closed_at >= i.created_at))
  and not exists (select 1 from public.shift_transactions t where t.type = 'sale' and t.reference_id in (i.invoice_number, i.operation_id::text, i.id::text));

-- X-6 [F-07] Invoice arithmetic: total = subtotal − discount + tax (exclusive) or subtotal − discount (inclusive).
select invoice_number, subtotal, discount, tax_amount, total from public.invoices
where status not in ('refunded', 'cancelled')
  and abs(total - (subtotal - coalesce(discount, 0) + case when coalesce(tax_inclusive, false) then 0 else coalesce(tax_amount, 0) end)) > 0.01;

-- X-7 Stock: no negative stock (unless the owner allowed it) and the stock equals the last movement of the ledger.
--     Order by the movement's commit, not by created_at (two concurrent sales share a start time; see 3.6 note in the plan).
select p.name, p.quantity from public.products p
join public.stores st on st.user_id = p.user_id
where p.quantity < 0 and not coalesce(st.allow_negative_stock, false);

-- X-8 [D-20, D-23] Store credit: the balance view equals the ledger, at 8 decimals.
select b.customer_id, b.store_credit,
       (select round(coalesce(sum(amount), 0), 8) from public.customer_credit_ledger l where l.customer_id = b.customer_id) as ledger
from public.customer_credit_balances b
where b.store_credit <> (select round(coalesce(sum(amount), 0), 8) from public.customer_credit_ledger l where l.customer_id = b.customer_id);

-- X-9 No duplicate invoice numbers per store; no operation posted twice.
select user_id, invoice_number, count(*) from public.invoices group by 1, 2 having count(*) > 1;
select user_id, operation_id, count(*) from public.debt_payments where operation_id is not null group by 1, 2 having count(*) > 1;

-- X-10 [F-12] Partner pending profit never negative; partner ledger equals the partner balances.
select partner_id, name from public.partner_ledger_reconciliation where mismatch;
select id, name, pending_profit from public.partners where coalesce(pending_profit, 0) < -0.00000001;

-- X-11 [F-02] No money column below 8 decimals (quantities have 3 by design).
select table_name, column_name, numeric_scale from information_schema.columns
where table_schema = 'public' and data_type = 'numeric' and numeric_scale between 1 and 7
  and column_name not like '%quantity%'
  and table_name not in ('store_settings', 'subscription_requests', 'product_serials');

-- X-12 [F-16] A refund movement points at a refunded (or partially refunded) invoice.
select t.id, t.amount, t.reference_id from public.shift_transactions t
where t.type = 'refund' and t.reference_id like 'receipt-refund:%'
  and not exists (select 1 from public.invoices i where t.reference_id like '%' || i.invoice_number || '%');

-- X-13 Reports (one day, gross sales, see 3.3): compare with the screens (summary, cashier, daily closing).
select (created_at at time zone 'UTC')::date as day, count(*) as invoices, sum(total) as sales_incl_tax,
       sum(tax_amount) as tax, sum(total) filter (where payment_type = 'cash') as cash, sum(total) filter (where payment_type = 'debt') as credit
from public.invoices where status not in ('refunded', 'cancelled') group by 1 order by 1 desc limit 7;
```

## 5. ملفات مرتبطة
- `docs/FINANCE_LAW.md` — القانون والقرارات (D-01 … D-26) وسجل الهجرات.
- `supabase/tests/finance_reconcile_readonly.sql` — أصل R-01 … R-09 (يشغّلها `finance:sql` أيضاً).
- `docs/audit/SCHEMA_LOGIC_REFERENCE.sql` — نص SQL الكامل للمنطق مع بصمات المقارنة.
- `scripts/db-drift-sql.mjs` — فحص تطابق الحي مع المستودع.
- `docs/QA_VERIFIED_STATUS_AND_FIX_PLAN.md` — تاريخ ما فُحص وأُصلح.

## 6. آخر نتيجة (2026-11-26)
البوابات خضراء (294/294 ذهبي)، تطابق تام بين السحابة والمستودع، وكل بوابات الجزء 4 صفر على القاعدة الحية ما عدا بنود 3.6 (بيانات اختبار) وخطأ X-5 الذي أُصلح (D-26).

## 7. نتائج التشغيل على القاعدة الحية (2026-11-26، قراءة فقط)

### 7.1 تطابق السحابة مع المستودع (`npm run -s db:drift-sql -- --summary`)
| البصمة | المستودع (`main` عند `5226a74`+) | القاعدة الحية | النتيجة |
|---|---|---|---|
| fn (182 دالة) | `3c1d56f0b06be4322264aa7200d6ea5a` | `3c1d56f0b06be4322264aa7200d6ea5a` | متطابق |
| cols | `af761327a4b0c937bda7de50351bc8ac` | `af761327a4b0c937bda7de50351bc8ac` | متطابق |
| trg | `b370c11cffc5ee3f2f2985f85b734d77` | `b370c11cffc5ee3f2f2985f85b734d77` | متطابق |
| idx | `120c0c4fe66f65c4ec57420262982af9` | `120c0c4fe66f65c4ec57420262982af9` | متطابق |

إن طبع `--summary` في نسختك بصمات مختلفة فالكود تغيّر بعد هذا التاريخ؛ عندها نتائج الجزء 7 لا تمثل نسختك.

### 7.2 استعلامات البوابة (عدد الصفوف الخاطئة)
| الفحص | النتيجة | | الفحص | النتيجة |
|---|---|---|---|---|
| R-01 | 0 | | X-1 | 0 |
| R-02 | 0 | | X-2 | 0 |
| R-03 | 0 | | X-3 | **1** (انظر 7.3) |
| R-04 | 0 | | X-4 | 0 |
| R-05a | 0 | | X-5 | **6** (انظر 7.3) |
| R-05b | 0 | | X-6 | 0 |
| R-06 | 0 | | X-7 | 0 |
| R-07 (معلوماتي) | 1 وردية مفتوحة | | X-8 | 0 |
| R-08 | 0 | | X-9 | 0 |
| R-09 | 0 | | X-10 | 0 |
| | | | X-11 | 0 |
| | | | X-12 | 0 |

### 7.3 الصفوف التي ظهرت (كلها بيانات اختبار مقصودة — الجزء 3.6، ليست أخطاء)
- X-3: `20261125-00016` (دفعة أولى فقدت حركتها عند تصفير وردية تجريبياً).
- X-5: `20261125-00018`, `00019`, `00020`, `00021`, `00022` ($5 لكل منها) و`20261126-00027` ($8): بيعت قبل إصلاح D-26 على جهاز لم يتبنَّ الوردية. بعد الإصلاح أول بيع على جهاز جديد (`20261126-00028`) دخل الوردية.

### 7.4 X-13 (للمقارنة مع شاشات التقارير؛ المبيعات شاملة الضريبة، 3.3)
| اليوم (UTC) | فواتير | مبيعات | ضريبة | نقدي | آجل |
|---|---|---|---|---|---|
| 2026-11-26 | 4 | 32.00 | 0.00 | 32.00 | 0.00 |
| 2026-11-25 | 9 | 57.00 | 0.38 | 33.00 | 24.00 |

### 7.5 الخلاصة
لا يوجد خطأ محاسبي مفتوح في البيانات الحية. البوابات الآلية: `finance:sql` 294/294، `finance:check` أخضر، typecheck 0، build 0، maps سليمة.
