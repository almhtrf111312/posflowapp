# تقرير المراجعة المعمارية الموحد لوثيقة التدقيق الأمني والمالي
# EGM Consolidated Architectural Review Report

*   **الوثيقة الخاضعة للمراجعة:** [`docs/designs/security-and-financial-audit.md`](./security-and-financial-audit.md)
*   **المشروع:** FlowPOS Pro Companion
*   **تاريخ المراجعة:** 2026-11-08
*   **وكلاء المراجعة المشاركون:**
    1. `egm-zoom-out` (المعماري العام - Skeptical Architect)
    2. `egm-inventive-catalyst` (محفز الابتكار TRIZ)
    3. `egm-comprehension` (فاحص الوضوح والمفاهيم - Naive Reader)
    4. `egm-design` (ناقد التصميم المعماري والأمني - Hostile Design Critic)
    5. `egm-structural` (مدقق الهيكلية والتنسيق - Document Architect)
    6. `egm-implementation-readiness` (المسؤول التقني لجاهزية التنفيذ - Pragmatic Tech Lead)
    7. `egm-codebase-details` (مدقق مطابقة الكود والمكتبات - Pedantic Technical Auditor)

---

## 1. جدول النتائج والملاحظات الموحدة حسب الأولوية

| المعرف | المحور | درجة الخطورة | النطاق المتأثر | التوجيه والقرار المعماري الإلزامي |
| :--- | :--- | :---: | :--- | :--- |
| **SEC-01** | أمان قفل التطبيق | **Blocker** | `use-app-lock.tsx` (L196-200) | **ثغرة Fail-Open**: مسح الـ Salt أو الـ Hash يفتح التطبيق فوراً. التوجيه: التحول الإلزامي إلى **Fail-Closed**، حيث يؤدي فقدان البيانات إلى إقفال التطبيق وطلب كلمة مرور الحساب الرئيسية. |
| **SEC-02** | عزل التكلفة | **Blocker** | `products-cloud.ts`, IndexedDB | **خطر تلويث التخزين المحلي**: تصفير `cost_price = 0` في IndexedDB يدمر الكاش عند تبديل المستخدمين وقد يرفع أصفاراً للسحابة. التوجيه: منع كتابة أصفار في IndexedDB، وتطبيق الحجب في الذاكرة اللحظية للكاشير (`omit`)، مع تفويض حساب التكلفة والأرباح حصرياً لخادم Supabase في `process_pos_sale_atomic`. |
| **SEC-03** | تشفير الـ PIN | **Major** | `use-app-lock.tsx` | إزالة دالة الـ Fallback الضعيفة (32-bit hash)، وتأكيد حماية الـ DOM بخاصية `inert` لمنع أي تفاعل خلفي أثناء القفل. |
| **CONC-01** | طابور المزامنة | **Blocker** | `sync-queue.ts` | **خطر إسقاط سندات الديون (Terminal Drop)**: إذا فشلت فاتورة الدين مؤقتاً، يجب تعليق سند السداد التابع لها (`depends_on`) بدلاً من تصنيفه كخطأ نهائي وحذفه. |
| **CONC-02** | قفل المعاملات | **Blocker** | `transaction-lock.ts` & `CartPanel.tsx` | **خطر تكرار الفواتير**: دالة `acquireLock` الحالية تنتظر في طابور مما ينفذ النقرة المزدوجة. التوجيه: دعم قفل فوري الرفض (`tryAcquireLock` / `immediate: true`) لردع النقرات السريعة، وقصر القفل على الحفظ المحلي السريع (<10ms). |
| **FIN-01** | حسابات المخزون | **Blocker** | `receive_stock_wac` (Database) | **تسوية عجز المخزون السالب (COGS True-Up)**: عند التوريد برصيد سالب، لا يجوز اعتماد التكلفة الجديدة على كامل الرصيد دون تسوية تكلفة مبيعات العجز السابقة محاسبياً. |
| **FIN-02** | أرباح الديون | **Major** | `invoice-profit.ts` & Ledger | **قيد التسوية النهائي (Final Profit Sweep)**: عند سداد آخر قسط من الدين وتصفير الرصيد، يجب نقل كامل الرصيد المتبقي في `pending_profit` إلى `confirmed_profit` لتفادي احتباس كسور السنتات العشرية. |
| **FIN-03** | الثوابت المالية | **Major** | نص الوثيقة (القسم 1) | سرد وتوثيق الثوابت المالية السبعة كاملة دون استثناء وتأكيد استبعاد الضريبة بنسبة 100% من صافي الربح و COGS. |
| **CODE-01** | مطابقة الكود | **Major** | `products-cloud.ts`, `sync-queue.ts` | تصحيح أسماء الدوال الحقيقية (`loadProductsCloudInternal`, `saveToLocalCache`, `processQueue`)، واعتماد دالة القفل المدمجة `withLock(LOCK_RESOURCES.SALE_PROCESSING, ...)`. |
| **CODE-02** | أرباح أوفلاين | **Major** | `CartPanel.tsx` & `pos-sale-atomic.ts` | إدراج `CartPanel.tsx` في خطة التعديل، وضبط احتساب أرباح الفواتير غير المتصلة للكاشير بحيث تظل معلقة بانتظار التأكيد السحابي. |
| **DOC-01** | هيكلية الوثيقة | **Nit** | الأقسام 1، 5، و 9 | إغلاق الأسئلة المفتوحة في القسم 5 كقرارات محسومة، توحيد عنوان H1 الرئيسي، وتصحيح مسارات الروابط النسبية في `docs/designs/`. |

---

## 2. القرارات المعمارية المعتمدة للتحصين (Decisions for Hardening)

1. **التحصين الأمني لقفل التطبيق (App Lock Hardening)**:
   * تعديل مسار التحقق ليصبح **Fail-Closed** صارماً.
   * إزالة خوارزمية التجزئة الاحتياطية الضعيفة في السطور 58-65 من `use-app-lock.tsx`.
   * تفعيل خاصية `inert` على جذر الشاشة لمنع نقرات الخلفية.
2. **عزل التكلفة دون تلويث الكاش (Clean Cost Obfuscation)**:
   * حظر كتابة `cost_price: 0` في قاعدة بيانات `IndexedDB` المحلية.
   * حجب حقول التكلفة في الذاكرة الحية (In-Memory / React Context) لواجهة الكاشير عبر `omit(product, ['cost_price', 'bulk_cost_price'])`.
   * السحابة في `process_pos_sale_atomic` هي المصدر الوحيد لحساب التكلفة الحقيقية والأرباح المعتمدة.
3. **قفل المعاملات الفوري والسريع (Immediate Fast Mutex)**:
   * تزويد `transaction-lock.ts` بآلية رفض فوري `tryAcquireLock(resource)` ترفض النقرة المزدوجة المتزامنة فوراً دون اصطفاف.
   * قصر مدة القفل على عملية الإيداع المحلي في IndexedDB (<10ms)، وتحرير واجهة السلة فوراً.
4. **سلسلة تبعيات طابور المزامنة (Sync Queue Dependencies)**:
   * ربط سند سداد الدين `debt_payment` بالفاتورة الأصلية `debt_sale_bundle` عبر `dependsOn`.
   * تعليق السند فور تعثر الفاتورة لمنع إرسال خطأ نهائي `Debt not found`.
5. **معادلة WAC وتسوية العجز (Deficit True-up & Final Profit Sweep)**:
   * توثيق معادلة تسوية عجز المخزون السابق عند التوريد برصيد سالب.
   * اعتماد حركة التسوية النهائية لنقل أرباح الديون المعلقة بالكامل عند السداد التام.
