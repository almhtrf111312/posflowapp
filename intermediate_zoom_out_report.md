# تقرير المراجعة الشاملة - المرحلة 8: التوازن المعماري والحد من التعقيد الزائد
# Stage 8 Review Report: Intermediate Zoom-Out Audit

**Document:** `docs/designs/security-lock-and-theme-animation.md`  
**Reviewer:** Skeptical Architect (`egm-zoom-out`)  
**Scope:** Full File (Lines 1–228)  
**Date:** 2026-11-08

---

## 1. التقييم المعماري العام (Architectural Verdict)

المعمارية الأساسية للحل (طبقة الحجب العائمة غير التدميرية + الحفاظ على سلة الكاشير المفتوحة في الذاكرة + التحقق المحلي أوفلاين) **سليمة وضرورية جداً للمشروع**.  
إلا أن التدقيق كشف أن بعض مقترحات الناقد المعماري (مثل فرض 100,000 دورة PBKDF2 والربط العتادي وإيقاف النظام Fail-Closed) تمثل **إفراطاً هندسياً خطيراً (Cryptographic Overkill)** لا يتناسب مع طبيعة أجهزة الكاشير الاقتصادية وينتهك مبدأ استمرارية العمل أوفلاين (Offline-First).

---

## 2. القرارات والتوجيهات المعمارية الحاسمة (Architectural Decisions)

### 🔴 1. حظر تعديل خطاف البنية التحتية `use-app-lifecycle.tsx` (0 Diffs)
* **القرار**: خطاف `useAppLifecycle` يعرض بالفعل ردود نداء مجردة `onPause` و `onResume`. تعديله لإقحام منطق القفل يكسر مبدأ المسؤولية الواحدة.
* **التوجيه**: يظل `use-app-lifecycle.tsx` ثابتاً دون أي تعديل، ويقوم `AppLockProvider` باستهلاكه كـ Consumer:
  ```ts
  useAppLifecycle({
    onPause: recordPauseTimestamp,
    onResume: evaluateLockTimeout,
  });
  ```

### 🔴 2. نموذج أمان متزن دون إبطاء أجهزة الكاشير (Balanced Security Model)
* **القرار**: قفل الـ PIN في FlowPOS Pro هو قفل شاشة سريع للكاشير (Screen Saver Guard) لمنع العبث الفيزيائي أثناء الابتعاد عن الكاونتر. تطبيق PBKDF2 بـ 100,000 دورة سيسبب تجمداً للواجهة على معالجات Rockchip/MediaTek الاقتصادية، ومبدأ Fail-Closed يوقف مبيعات المحل.
* **التوجيه**: الاعتماد على Salt عشوائي 16 بايت مع SHA-256 عبر `crypto.subtle` المدمج بالمتصفح، مدعوماً بحظر التخمين الزمني (`lockoutUntil`) المحفوظ في `localStorage` لمنع التجاوز بإعادة التشغيل.

### 🟡 3. ربط القفل بوجود جلسة مستخدم نشطة (`user !== null`)
* **القرار**: منع حبس المستخدم في شاشة مقفلة عند تسجيل الخروج أو قبل استعادة الجلسة على مسارات `/login`.
* **التوجيه**: اشتراط واضح:
  ```ts
  const shouldLock = isLockEnabled && !!user && !authLoading;
  ```

### 🟡 4. عزل الواجهة الخلفية عبر السمة القياسية `inert`
* **القرار**: استخدام سمة HTML5 القياسية `inert` لعزل شجرة التطبيق بالكامل أثناء تفعيل القفل:
  ```tsx
  <div inert={isLocked ? "" : undefined}>
  ```
  هذا يعطل التركيز، التبويب عبر `Tab`، وقراءات الباركود الخارجية من التأثير على سلة المبيعات دون الحاجة لاعتراض معقد للأحداث.

### 🟡 5. حذف إضافة الحدث الزائد في `events.ts` (YAGNI)
* **القرار**: حالة `isLocked` موزعة بكفاءة عبر React Context (`useAppLock`)، ولا يوجد أي مستهلك خارجي يستدعي تكرارها في ناقل الأحداث.
