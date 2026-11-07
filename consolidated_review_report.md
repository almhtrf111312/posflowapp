# تقرير المراجعة النقدية الشامل الموحد (Consolidated EGM Review Report)
# Elephant-Goldfish Model (EGM) Review Protocol Deliverable

**المستند المفحوص:** [`docs/designs/security-lock-and-theme-animation.md`](docs/designs/security-lock-and-theme-animation.md)  
**تاريخ المراجعة:** 2026-11-08  
**الوكلاء المشاركون:**
1. Skeptical Architect (`egm-zoom-out`)
2. Inventive Catalyst (`egm-inventive-catalyst`)
3. Naive Reader (`egm-comprehension`)
4. Hostile Design Critic (`egm-design`)
5. Document Architect (`egm-structural`)
6. Technical Copy Editor (`egm-style`)
7. Pragmatic Tech Lead (`egm-implementation-readiness`)
8. Pedantic Technical Auditor (`egm-codebase-details`)

---

## 1. الملخص التنفيذي للمراجعة (Executive Summary)

أجمعت كافة أدوار المراجعة النقدية الحيادية (Goldfish Reviewers) على أن الحاجة الوظيفية لمعالجة عطل قفل الأمان في FlowPOS Pro هي **حاجة حتمية وحرجة لحماية نقاط البيع الميدانية**.  
وقد نجحت مسودة التصميم في تثبيت المبدأ المحوري للنظام وهو: **حفظ سلة المبيعات وحركات الكاشير المفتوحة في الذاكرة دون إعادة توجيه تدميري للصفحة، مع التحقق محلياً أوفلاين**.

ومع ذلك، كشفت المراجعة المتعددة الزوايا عن **7 موانع وثغرات تنفيذية ومعمارية حرجة (Blockers)** يجب معالجتها في وثيقة التصميم قبل كتابة أي سطر كود إنتاجي، أبرزها:
1. استثناء مفاتيح القفل في دالة `clearAllUserSessionCaches` لمنع مسحها تلقائياً عند الدخول والخروج.
2. حظر تعديل خطاف البنية التحتية `use-app-lifecycle.tsx` والاكتفاء باستهلاكه (0 Diffs).
3. ربط قفل التطبيق بوجود مستخدم نشط (`user !== null`) لمنع حبس المستخدم في شاشة الدخول.
4. عزل المفاتيح برقم المستخدم (`user.id`) لمنع تداخل صلاحيات الكاشير والمدير.
5. منع تغيير المسارات في أندرويد عبر سمة `role="dialog"` المتوافقة مع `ExitConfirmDialog`.
6. منع تسريب مدخلات قارئ الباركود عبر سمة `inert` للواجهة الخلفية.
7. استمرار حظر التخمين (Lockout) عبر التخزين الدائم لمنع التحايل بإعادة تشغيل التطبيق.

---

## 2. مصفوفة تتبع الملاحظات والمهام الإجرائية (Traceability Matrix)

| رقم البند | الأولوية | الملاحظة المجمعة | المصدر (Stage / Reviewer) | الإجراء التصحيحي الواجب اعتماده في وثيقة التصميم |
| :---: | :---: | :--- | :--- | :--- |
| **ACT-01** | 🔴 Blocker | مسح مفاتيح القفل تلقائياً بواسطة `clearAllUserSessionCaches` | Stage 9 (`codebase-details`) | إضافة `src/hooks/use-auth.tsx` للخطة واستثناء بادئة `flowpos_app_lock_` صراحة من المسح. |
| **ACT-02** | 🔴 Blocker | تلويث خطاف البنية التحتية `use-app-lifecycle.tsx` | Stage 5 & 8 (`zoom-out`) | إبقاء `use-app-lifecycle.tsx` دون أي تعديل (0 diffs)، وجعل `AppLockProvider` يستهلكه كـ Consumer. |
| **ACT-03** | 🔴 Blocker | قفل التطبيق على غير المسجلين وحبس شاشة `/login` | Stage 5 (`zoom-out`) & Stage 6 (`comprehension`) & Stage 7 (`design`) | اشتراط `user !== null && !authLoading` لتفعيل القفل، وإخفاء الشاشة تماماً على المسارات العامة. |
| **ACT-04** | 🔴 Blocker | تصادم زر الرجوع في أندرويد مع `ExitConfirmDialog` | Stage 7 (`design`) & Stage 9 (`codebase-details`) | إلزام `AppLockOverlay` بحمل `role="dialog"` و `data-state="open"` واستدعاء `CapApp.exitApp()` لمنع تغيير المسار. |
| **ACT-05** | 🔴 Blocker | غياب واجهة TypeScript البرمجية لـ `AppLockContextType` | Stage 9 (`implementation-readiness`) | توثيق الواجهة البرمجية الكاملة للخطاف والموفر والدوال والأنواع صراحة في التصميم. |
| **ACT-06** | 🔴 Blocker | غياب زر تأكيد إدخال PIN المتغير (4 إلى 8 أرقام) | Stage 9 (`implementation-readiness`) | إضافة زر "تأكيد / دخول" صريح في لوحة الأرقام لضمان عمل كافة أطوال الرموز بأمان. |
| **ACT-07** | 🔴 Blocker | تجاوز حظر التخمين بإعادة تشغيل التطبيق (In-Memory Flaw) | Stage 5 (`zoom-out`) & Stage 7 (`design`) & Stage 9 (`readiness`) | حفظ طابع انتهاء الحظر `lockoutUntil` في `localStorage` لمنع تصفير العداد عند الإغلاق وإعادة الفتح. |
| **ACT-08** | 🟡 Major | تداخل مفاتيح القفل على الأجهزة المشتركة بين المستخدمين | Stage 5 (`zoom-out`) & Stage 6 (`comprehension`) & Stage 7 (`design`) | عزل المفاتيح برقم المستخدم: `flowpos_app_lock_${userId}_*`. |
| **ACT-09** | 🟡 Major | تسريب نقرات قارئ الباركود ولوحة المفاتيح للسلة خلف القفل | Stage 5 (`inventive-catalyst`) & Stage 7 (`design`) | تطبيق سمة `inert` و `aria-hidden="true"` على شجرة التطبيق الخلفية أثناء `isLocked = true`. |
| **ACT-10** | 🟡 Major | تسريب وميض الشاشة عند الإقلاع (Cold-Start Flash / TOCTOU) | Stage 7 (`design`) & Stage 9 (`readiness`) | تهيئة حالة `isLocked` بشكل متزامن لحظي (`useState(() => evaluateInitialLock())`). |
| **ACT-11** | 🟡 Major | دمج تعديل الثيم البسيط (سطرين) مع بنية أمان معمارية | Stage 5 & 8 (`zoom-out`) & Stage 7 (`design`) | توضيح نطاق تعديل الثيم كمعاملات فيزيائية مستقلة في `theme-transition.ts` (500ms–600ms) وتفادي تشويش وثيقة الأمان. |
| **ACT-12** | 🟡 Major | غياب قسم المخاطر والمعالجات وازدواجية H1 بالوثيقة | Stage 7 (`structural`) | تصحيح الهيكلية، دمج عنوان H1، وإضافة قسم `المخاطر والمعالجات (Risks & Mitigations)`. |
| **ACT-13** | 🟡 Major | عبارات غير معيرة وأوصاف إنشائية عاطفية وتسويقية | Stage 7 (`style`) | استبدال "0 ملي ثانية" بـ "معالجة محلية دون انتظار شبكة"، وحذف "كارثة وتدمير" و"مرفوض من المؤلف". |
| **ACT-14** | 🟢 Nit | حدث زائد في ناقل الأحداث `events.ts` (YAGNI) | Stage 5 & 8 (`zoom-out`) | حذف البند 7 الخاص بـ `events.ts` والاعتماد التام على React Context. |

---

## 3. القرار والتوصية النهائية (Next Steps)

توصي مراجعة السمكة الذهبية بالانتقال إلى خطوة **اعتماد المعالجات (Resolution Phase - `/egm:egm-resolve`)** لتحديث وثيقة التصميم المعماري [`docs/designs/security-lock-and-theme-animation.md`](docs/designs/security-lock-and-theme-animation.md) وفق بنود مصفوفة التتبع أعلاه.
وبمجرد اعتماد التحديثات، تصبح المواصفة جاهزة بنسبة 100% لبدء مرحلة التنفيذ البرمجي الجراحي.
