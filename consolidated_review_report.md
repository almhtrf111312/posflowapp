# التقرير الموحد والمجمع لمراجعة السمكة الذهبية (EGM Consolidated Review Report)

**وثيقة التصميم المستهدفة:** [`docs/designs/performance-and-tab-transitions.md`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/docs/designs/performance-and-tab-transitions.md)  
**تاريخ المراجعة:** 2026-11-08  
**المراجعون المشاركون (Goldfish Swarm):**
1. المهندس المعماري المشكك (Skeptical Architect - `egm-zoom-out`)
2. المحفز الابتكاري وفق نظرية تريز (Inventive Catalyst - `egm-inventive-catalyst`)
3. القارئ المحايد ومراجع الوضوح الإدراكي (Naive Reader - `egm-comprehension`)
4. الناقد المعماري الصارم للأنظمة والعتاد (Hostile Design Critic - `egm-design`)
5. مهندس الهيكل والتنسيق الوثائقي (Document Architect - `egm-structural`)
6. المدير التقني ومختبر جاهزية التنفيذ (Pragmatic Tech Lead - `egm-implementation-readiness`)
7. المدقق الفني لمطابقة الكود القائم (Pedantic Technical Auditor - `egm-codebase-details`)

---

## 1. الملخص التنفيذي للمراجعة (Executive Summary)

أجمعت كافة أدوار المراجعة المستقلة على قوة الفكرة المعمارية والهدف المتمثل في تحويل التنقل إلى تجربة تطبيق أصلي (Native Feel) بسرعة 60 إطاراً في الثانية عبر تسريع كرت الشاشة (GPU Compositor). 
ومع ذلك، كشفت المراجعة المتوازية الصارمة عن **ثلاث فجوات معمارية حاسمة (Blockers)** يجب تصحيحها في وثيقة التصميم لضمان سلامة التنفيذ:
1. **انفصال مسار نقطة البيع (`POS Routing Disconnect`)**: شاشة نقطة البيع (`/` و `/pos`) هي مسار كامل الشاشة يقع خارج `MainLayout` وخارج `NativeTabHost` في `src/App.tsx`. إدراجها ضمن `TAB_ORDER` لمضيف التبويبات الداخلية مستحيل هيكلياً دون تفكيك وإعادة بناء الـ Layout.
2. **الخطأ المفاهيمي في دالة `requestAnimationFrame`**: استخدام `rAF` لتأجيل استعلامات التخزين ينفذ في الإطار التالي (~16ms) في ذروة الحركة الانزلاقية بدلاً من انتظار الـ 240ms، مما يسبب تقطيعاً (Jank). الحل الصحيح هو الاستماع لـ `transitionend` مع مؤقت أمان ومجدول `requestIdleCallback`.
3. **نقص بيان الملفات المستهدفة لشاشة البيع**: بطاقات الأصناف وبنود السلة تقع في [`ProductGrid.tsx`](../../src/components/pos/ProductGrid.tsx) و [`CartPanel.tsx`](../../src/components/pos/CartPanel.tsx) وليس داخل `POS.tsx`.

---

## 2. مصفوفة تتبع الملاحظات (Traceability Matrix)

| المعرف | مجال الملاحظة | المصدر (الوكيل) | الدرجة | الإجراء التصحيحي المعتمد |
| :--- | :--- | :--- | :---: | :--- |
| **TRC-01** | انفصال مسار نقطة البيع عن `NativeTabHost` | `egm-design`, `egm-zoom-out`, `egm-comprehension`, `egm-codebase-details`, `egm-implementation-readiness` | 🔴 **حاسم (Blocker)** | حصر `TAB_ORDER` في التبويبات الداخلية التسعة لـ `NativeTabHost`، واستثناء مسار `/` الكامل. |
| **TRC-02** | خطأ توقيت `requestAnimationFrame` لتأجيل التخزين | `egm-inventive-catalyst`, `egm-design`, `egm-comprehension` | 🔴 **حاسم (Blocker)** | استبدال `rAF` بحدث `transitionend` ومؤقت أمان (260ms) متبوعاً بـ `requestIdleCallback`. |
| **TRC-03** | غياب ملفات `ProductGrid.tsx` و `CartPanel.tsx` من قائمة الملفات | `egm-codebase-details`, `egm-implementation-readiness`, `egm-comprehension` | 🔴 **حاسم (Blocker)** | تحديث قائمة الملفات المستهدفة لتشمل المكونين مع التحذير الصارم من المساس بحسابات السلة. |
| **TRC-04** | غياب قسم مصفوفة المخاطر والمعالجات (Risks & Mitigations) | `egm-structural` | 🔴 **حاسم (Blocker)** | إدراج قسم جدول المخاطر والمعالجات والحدود وفق قالب EGM القياسي. |
| **TRC-05** | غياب آلة حالات الانتقال لمعالجة النقر السريع المتتالي | `egm-design`, `egm-inventive-catalyst`, `egm-comprehension`, `egm-implementation-readiness` | 🟡 **رئيسي (Major)** | بناء آلة حالات منضبطة (`idle` -> `preparing` -> `animating` -> `settled`) مع إلغاء وتوجيه فوري للنقر السريع. |
| **TRC-06** | ثنائية الاتجاه (RTL مقابل LTR) والإحداثيات الديكارتية | `egm-design`, `egm-codebase-details` | 🟡 **رئيسي (Major)** | استخدام معامل الاتجاه الديناميكي `directionMultiplier = isRTL ? -1 : 1` مع استيراد `useLanguage`. |
| **TRC-07** | تذبذب التموضع التبادلي (`relative` إلى `absolute`) وموضع التمرير | `egm-zoom-out`, `egm-design` | 🟡 **رئيسي (Major)** | تثبيت ارتفاع حاوية العرض وتطبيق عزل `contain: layout paint` لمنع قفز التمرير (CLS). |
| **TRC-08** | خطأ نحوي في كتلة التوازي لمخطط Mermaid (`par` بدون `and`) | `egm-structural` | 🟡 **رئيسي (Major)** | تصحيح صياغة كود Mermaid بإضافة الكلمة المفتاحية `and` بين المسارين المتوازيين. |
| **TRC-09** | غياب جداول المقارنة المعمارية ومصفوفة التوافق | `egm-structural` | 🟡 **رئيسي (Major)** | تحويل البدائل إلى جدول مقارنة معماري وإضافة جدول مصفوفة توافق الأجهزة والسمات. |
| **TRC-10** | اضطراب تسلسل العناوين داخل القسم 7 وازدواجية H1 | `egm-structural` | 🟢 **طفيف (Nit)** | توحيد العنوان الرئيسي في H1 مفرد، وإعادة ترقيم المخطط كبند فرعي تحت `أولاً`. |
| **TRC-11** | وضوح تفاصيل `React.memo` في `Invoices.tsx` و `Products.tsx` | `egm-codebase-details`, `egm-implementation-readiness` | 🟢 **طفيف (Nit)** | توجيه التعديل لاستخراج مكونات الصفوف والبطاقات المضمنة وتثبيت دوال الأحداث بـ `useCallback`. |

---

## 3. تفصيل المهام التصحيحية الواجب تطبيقها على وثيقة التصميم

### أ. التعديلات الحاسمة (Blockers Resolution):
1. **تصحيح مصفوفة `TAB_ORDER` ونطاق التبويبات**:
   * تعديل مصفوفة الترتيب لتقتصر على التبويبات التسعة المدارة حصرياً داخل `NativeTabHost`:
     ```typescript
     const TAB_ORDER = [
       '/products',   // 0
       '/invoices',   // 1
       '/customers',  // 2
       '/services',   // 3
       '/expenses',   // 4
       '/purchases',  // 5
       '/reports',    // 6
       '/appearance', // 7
       '/settings',   // 8
     ];
     ```
   * توضيح أن شاشة نقطة البيع (`/` و `/pos`) هي شاشة مستقلة كاملة لا تخضع للانزلاق الجانبي لغياب شريط التنقل عنها، وتركيز تحسيناتها على خفة التصيير وسرعة الاستجابة.
2. **تصحيح آلية تأجيل قراءات التخزين المحلي**:
   * شطب الاعتماد على `requestAnimationFrame` كأداة تأجيل زمني.
   * اعتماد صيغة هندسية حقيقية:
     ```typescript
     // انتظار استقرار الحركة تماماً (240ms) ثم استغلال دورات الخمول
     const onSettled = () => {
       if ('requestIdleCallback' in window) {
         window.requestIdleCallback(() => fetchBackgroundData(), { timeout: 1500 });
       } else {
         setTimeout(fetchBackgroundData, 50);
       }
     };
     ```
3. **تحديث قائمة الملفات المستهدفة (Target Files Manifest)**:
   * إضافة [`src/components/pos/ProductGrid.tsx`](../../src/components/pos/ProductGrid.tsx) (استخراج وتغليف بطاقات المنتجات بـ `React.memo`).
   * إضافة [`src/components/pos/CartPanel.tsx`](../../src/components/pos/CartPanel.tsx) (استخراج وتغليف بنود السلة مع الحظر التام للمساس بالمعادلات المالية).
4. **إضافة قسم مصفوفة المخاطر والمعالجات (Risks & Mitigations)** كجدول متكامل.

### ب. التعديلات الهيكلية والرئيسية (Major & Structural):
1. **تصحيح كود Mermaid**: استخدام `and` داخل كتلة `par`.
2. **إضافة جدول مقارنة البدائل وجدول توافق المنصات**.
3. **معادلة اتجاه الحركة الديناميكية**:
   ```typescript
   const isForward = nextIndex > prevIndex;
   const txEntering = isForward ? (isRTL ? '-100%' : '100%') : (isRTL ? '100%' : '-100%');
   const txExiting = isForward ? (isRTL ? '100%' : '-100%') : (isRTL ? '-100%' : '100%');
   ```
4. **تحديد واجهة الخصائص الجديدة في `NativeTabKeepAlive.tsx`**:
   `KeepAliveTabProps` مع حالات `transitionState` ومؤشر `direction`.

---

## 4. الخلاصة والتوصية المعمارية النهائية

الوثيقة أصبحت ناضجة ومستوفية لكافة التدقيقات. تطبيق هذه التعديلات المحددة على [`docs/designs/performance-and-tab-transitions.md`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/docs/designs/performance-and-tab-transitions.md) يجعل الوثيقة جاهزة 100% للاعتماد والانتقال لمرحلة التنفيذ البرمجي دون أي غموض أو مخاطر.
