# وثيقة التدقيق الشامل لمرونة الواجهات (UI/UX) واستقرار الخطوط وتجاوب شاشات الموبايل (النسخة المحصنة)
> **Architecture Specification: Comprehensive Mobile Responsive, Typography & Layout Stress Audit (Hardened EGM Spec)**

*   **المؤلف (Author):** almhtrf111312
*   **الحالة (Status):** مواصفة معمارية محصنة ومعتمدة للمرحلة الثانية (Stage 1 Approved - Ready for Implementation)
*   **تاريخ الاعتماد:** 2026-11-08
*   **المشروع:** FlowPOS Pro Mobile Point of Sale & ERP Companion
*   **تقرير مراجعة السرب الموحد:** [`docs/designs/consolidated_review_report.md`](./consolidated_review_report.md)

--------------------------------------------------------------------------------

## 1. نظرة عامة (Overview)

تحدد هذه المواصفة المعمارية خطة تدقيق إجهادي عميق وشامل (Deep Responsive, Typography & Layout Stress Audit) لواجهات ومكونات نظام نقطة البيع المحمول **FlowPOS Pro**، لضمان استقرار العرض بنسبة 100% على كافة قياسات شاشات الهواتف الذكية، وتنوع أبعادها (Aspect Ratios)، والتعامل الرصين مع أحجام وتكبير الخطوط المتفاوتة (Accessibility Scaling)، وضمان سهولة التشغيل الميداني بالإبهام، دون أي تشوه بصري أو خروج للأزرار والحاويات خارج إطار الشاشة.

تم تحصين هذه الوثيقة وفق مخرجات مراجعة نموذج الفيل والسمكة الذهبية (EGM Swarm Review) بمشاركة 7 وكلاء متخصصين لحماية ثوابت النظام واستقرار الذاكرة العضلية للكاشير، وتمنع كلياً أي تغيير عشوائي أو هدم للبنى البرمجية السليمة.

---

### أ. القواعد والثوابت البصرية والمحمية (The Immutable UI/UX Invariants)
تعتبر البنود الخمسة التالية خطوطاً حمراء غير قابلة للمساس تحت أي ظرف:

1.  **الملفات المجمدة كلياً (Strictly Frozen Modules - BANNED FROM EDITING)**:
    *   `src/pages/Warehouses.tsx`
    *   `src/pages/StockTransfer.tsx`
    *   `src/lib/cloud/warehouses-cloud.ts`
    *(محظور فتح أو تعديل هذه الملفات لحماية منطق المخزون وسحابة الرصيد)*.
2.  **ثبات الذاكرة العضلية للكاشير (Cashier Muscle Memory Guard)**:
    حظر تغيير الترتيب المكاني للأزرار الحيوية الميدانية في واجهة البيع السريعة، وتحديداً:
    *   زر إتمام البيع النقدي ("فاتورة نقدية" `bg-success`).
    *   زر البيع الآجل ("فاتورة دين" `border-warning`).
    *   لوحة الأرقام (Numpad) وزر الآلة الحاسبة المدمج بالسلة.
    *   زر ماسح الباركود، وشريط السلات المعلقة (Held Carts Bar).
    يُمنع تبديل مواقع هذه الأزرار أو تعديل دلالاتها اللونية أو دمجها في قوائم فرعية.
3.  **حظر التمرير الأفقي التدميري (Zero Horizontal Viewport Overflow)**:
    منع ظهور أي شريط تمرير أفقي على مستوى صفحة التطبيق أو إطاراتها الرئيسية (`overflow-x: hidden` على مستوى الحاويات الشاملة)، مع فرض مرونة القياسات النسبية لضمان بقاء كامل واجهات التطبيق محصورة أفقياً بنسبة 100% داخل حدود الشاشة.
4.  **حظر اقتصاص الأرقام المالية (Never Truncate Financial Values)**:
    حظر استخدام فئة `truncate` الصامتة على أي قيمة مالية (أسعار السلع، إجمالي الفاتورة، الخصومات، المتبقي، الفكة، مبالغ الديون). يجب أن تظهر المبالغ كاملة دائماً؛ وفي حال ضيق المساحة في الشاشات الصغيرة يُعتمد التصغير التلقائي الذكي لحجم الخط (`whitespace-nowrap font-mono text-[clamp(...)]` أو الالتفاف المرن) دون بتر الأرقام بنقاط الحذف (`...`).
5.  **معيار أهداف اللمس الميدانية (Mobile Touch Targets >= 44px × 44px)**:
    ألا يقل ارتفاع ومساحة أي زر أو عنصر تفاعلي عن `44px × 44px` (سواء عبر الحجم الفيزيائي أو عبر تمديد مساحة اللمس الوهمية `after:absolute after:-inset-1.5`) لضمان راحة النقر السريع بالإبهام وتقليل احتمالية الضغط الخاطئ.

--------------------------------------------------------------------------------

## 2. القرارات الهندسية والتعديلات المعتمدة من سرب المراجعة (Swarm Resolutions)

1.  **استئصال `truncate` عن السعر في `ProductGrid.tsx`**:
    *   إزالة `truncate` و `min-w-0` من السطر 105، واعتماد `shrink-0 whitespace-nowrap font-black text-primary` ليخضع السعر لـ `sizeClassName` الخارجي الممرر دون تشويه أو بتر.
2.  **تصحيح نقطة توقف العرض المكثف**:
    *   استبدال `xs:grid-cols-3` غير المعرفة في Tailwind بـ `min-[380px]:grid-cols-3` مع الاحتفاظ بـ `grid-cols-2` للشاشات فائقة النحافة (<380px مثل Sony Xperia).
3.  **تقليص شارة الكمية في النمط المكثف**:
    *   تقليص أبعاد شارة الكمية في `ProductGrid.tsx` من `h-7 min-w-[2.25rem] text-[0.875rem]` إلى `h-5 min-w-[1.5rem] px-1 text-[10px] font-bold rounded-md` لمنع اختناق السعر والاسم.
4.  **ترقية أهداف اللمس لأزرار الكمية والحذف في `CartPanel.tsx`**:
    *   أزرار زيادة ونقص الكمية: تحويلها إلى `size-8 rounded-lg` مع فئة `after:absolute after:-inset-1.5` لتوفير هدف لمس 44px آمن دون تضخيم الهيكل البصري للحاوية.
    *   عداد الكمية: استبدال `w-6` بـ `min-w-[1.5rem] px-1 w-auto text-center tabular-nums` لاستيعاب كميات الجملة (100+).
    *   زر حذف الصنف: ترقيته إلى `w-9 h-9` مع منطقة لمس 44px.
    *   زر تبديل الوحدة: تحويله إلى كبسولة واضحة سهلة النقر.
    *   زر الآلة الحاسبة المدمج: تكبيره مع حشوة لمسية متوازنة.
5.  **عزل زر القائمة ثلاثية النقاط في `Invoices.tsx`**:
    *   ترقية زر `MoreVertical` إلى مساحة لمس 44px (`w-10 h-10` أو `p-2`) وزيادة حشوة بداية السطر المقابل إلى `pl-12` (أو `ltr:pl-12 rtl:pr-12`) لمنع تداخل الزر مع اسم العميل وشارات الدفع.
6.  **إصلاح كبسولات التبويبات في `SegmentedCapsule.tsx`**:
    *   تعريف `capsuleScrollItem` بـ `whitespace-nowrap shrink-0 flex-none px-3.5 min-h-10 text-xs font-bold` وإزالة `whitespace-normal` و `flex-1` التي تسبب تكسر الكلمات العربية إلى أعمدة رأسية ضيقة عند التمرير الأفقي.
    *   استخدام فئات إخفاء شريط التمرير المتوافقة مع PostCSS: `[scrollbar-width:none] [&::-webkit-scrollbar]:hidden`.
7.  **تأمين حافة الأمان السفلية وميزانية الارتفاع لدرج السلة (`CartPanel.tsx` و `POS.tsx`)**:
    *   تعديل درج السلة على الموبايل ليعتمد `h-[90dvh] max-h-[calc(100dvh-env(safe-area-inset-top,0px))]`.
    *   إضافة حافة الأمان السفلية لتذييل السلة: `pb-[max(0.75rem,calc(env(safe-area-inset-bottom,0px)+0.5rem))]` لمنع ابتلاع أزرار الدفع بشريط إيماءات نظام أندرويد.
8.  **تحصين تباين السمات الساطعة في `use-theme.tsx`**:
    *   تكييف `--primary-foreground` ليكون `222 47% 11%` (داكن عالي التباين) للسمات ذات السطوع العالي (كالليموني، البرتقالي، والقهوة) لتحقيق نسبة تباين > 4.5:1 وفق معايير WCAG AA.
    *   استئصال الألوان الصلبة (`bg-white dark:bg-zinc-900`) واستبدالها بتوكينات Tailwind النظامية (`bg-card`, `bg-muted/60`, `border-border/50`).

--------------------------------------------------------------------------------

## 3. خطة المعالجة الجراحية التنفيذية (Surgical Implementation Plan)

### الملف 1: `src/components/pos/ProductGrid.tsx`
*   **السطر 105**: إزالة `truncate` و `min-w-0` واستبدالها بـ `shrink-0 whitespace-nowrap font-black text-primary`.
*   **السطر 329**: استبدال `grid-cols-3` بـ `grid-cols-2 min-[380px]:grid-cols-3`.
*   **السطر 350-355**: ضبط شارة الكمية في النمط المكثف لتصبح `h-5 min-w-[1.5rem] px-1 text-[10px] font-bold rounded-md`.
*   **السطور 242، 250، 261**: استبدال `bg-white dark:bg-zinc-900` بـ `bg-card text-card-foreground border border-border/50`.

### الملف 2: `src/components/pos/CartPanel.tsx`
*   **السطر 2070**: ترقية زر حذف السلعة إلى `w-9 h-9 rounded-lg text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 flex items-center justify-center shrink-0 active:scale-90`.
*   **السطر 2095-2103**: ترقية زر تبديل الوحدة ليكون كبسولة أسهل للنقر.
*   **السطر 2128-2147**: ترقية أزرار الكمية إلى `size-8 rounded-lg bg-card hover:bg-muted text-foreground flex items-center justify-center active:scale-90 transition-all shadow-xs relative after:absolute after:-inset-1.5 after:content-['']`.
*   **السطر 2137**: استبدال `w-6` بـ `min-w-[1.5rem] px-1 w-auto text-center font-bold text-xs text-foreground tabular-nums select-none`.
*   **السطر 2151-2153**: استبدال `text-left` بـ `text-end`.
*   **السطر 2161**: إضافة الحشو السفلي الآمن لتذييل السلة: `pb-[max(0.75rem,calc(env(safe-area-inset-bottom,0px)+0.5rem))]`.
*   **السطر 2335**: ترقية زر الآلة الحاسبة إلى `w-8 h-8 rounded-lg text-sm`.

### الملف 3: `src/components/pos/POSHeader.tsx`
*   **السطر 31**: استبدال `h-14` بـ `h-auto min-h-[calc(3.5rem+env(safe-area-inset-top,0px))] pt-[env(safe-area-inset-top,0px)]`.
*   **السطر 40**: ترقية زر القائمة للموبايل إلى `w-11 h-11`.
*   **السطر 72**: ترقية زر السلة للموبايل إلى `h-11 px-3.5`.
*   **السطر 47**: استبدال `dark:bg-zinc-900/80` بـ `bg-muted/60`.

### الملف 4: `src/pages/POS.tsx`
*   **السطر 2395**: تعديل `SheetContent` لسلة الموبايل إلى `h-[90dvh] max-h-[calc(100dvh-env(safe-area-inset-top,0px))] p-0 [&>button]:hidden bg-transparent border-none`.
*   **السطر 2557**: التأكد من الحفاظ على موضع زر السلة العائم الآمن.

### الملف 5: `src/components/ui/SegmentedCapsule.tsx`
*   **السطر 4-5**: تحديث `capsuleOuterScroll` لدعم إخفاء شريط التمرير القياسي: `overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`.
*   **إضافة `capsuleScrollItem`**:
    ```ts
    export const capsuleScrollItem =
      'rounded-xl px-3.5 py-1.5 min-h-10 text-xs font-bold whitespace-nowrap shrink-0 flex items-center justify-center gap-1.5 transition-colors duration-200 select-none cursor-pointer';
    ```

### الملف 6: `src/pages/Invoices.tsx`
*   **السطر 2251**: ترقية زر القائمة ثلاثية النقاط إلى `p-2 w-10 h-10 rounded-lg hover:bg-muted flex items-center justify-center`.
*   **السطر 2291**: تعديل الحشوة الجانبية لمنع تداخل الزر مع اسم العميل: `pl-12 ltr:pl-12 rtl:pr-12`.

### الملف 7: `src/components/layout/Sidebar.tsx`
*   **السطر 306**: ترقية زر إغلاق السايدبار على الموبايل إلى `h-11 w-11`.
*   **السطر 490**: ترقية `MobileMenuTrigger` إلى `w-11 h-11`.

### الملف 8: `src/hooks/use-theme.tsx`
*   **السطر 333**: تكييف `--primary-foreground` بربطه بـ `primaryForeground` المشبع الداكن للسمات عالية السطوع (lime, orange, coffee) والأبيض للسمات الداكنة.

--------------------------------------------------------------------------------

## 4. بوابات التحقق واختبارات الإجهاد (Verification Gates)

1.  **بوابة البناء (`npm run build`)**: نجاح البناء بـ Exit Code 0 وخلو الحزمة من أي أخطاء.
2.  **بوابة التمرير الأفقي**: صفر انسكاب أفقي في كامل الواجهات على قياسات 360px و 393px و 412px.
3.  **بوابة الأرقام المالية**: ظهور كامل خانات السعر دون أي `truncate` أو نقاط حذف.
4.  **بوابة أهداف اللمس**: كافة الأزرار المحمولة تحقق مساحات تفاعلية >= 44px × 44px.
5.  **بوابة الملفات المجمدة**: التحقق الصارم من عدم مساس `Warehouses.tsx`, `StockTransfer.tsx`, `warehouses-cloud.ts`.

---
*تم تحصين واعتماد وثيقة التصميم المعماري رسمياً وجاهزة للتنفيذ البرمجي الجراحي الفوري.*
