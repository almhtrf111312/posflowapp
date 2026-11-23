# معايير الواجهة والتجاوب (UI Standards)

> مرجع تحت الطلب: يُقرأ عند العمل على الواجهة فقط. منقول حرفياً من دليل القواعد القديم (حُذف؛ المرجع الحالي `AGENTS.md`). التصميم العام: `docs/design.md`.

### 1. استجابة النوافذ والخطوط (UI Scale & REM Sizing)
* **الاعتماد على وحدات `rem` ومقاييس العرض الديناميكية:**
  * استخدام `0.9375rem` كحجم خط أساسي لحقول الإدخال والأزرار للتكيف التلقائي مع ضبط مقياس الواجهة (`UI Scale`).
  * استثناء هواتف iOS عبر `@supports (-webkit-touch-callout: none)` بحجم `16px` لمنع التقريب التلقائي (Auto-zoom) أثناء التركيز على حقول الإدخال.
  * إلغاء التقطيع والشرطات التلقائية للكلمات العربية `hyphens: none !important;` داخل نطاق `[dir="rtl"]`.
* **مربعات الحوار (Dialogs & Modals):**
  * لا تخرج النوافذ عن إطار الشاشة: اعتماد الأبعاد النسبية `w-[min(calc(100vw-1.5rem),42rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden`.
  * ترويسة ثابتة (`shrink-0`) مع محاذاة `text-start pe-8` لمنع تداخل العنوان مع زر الإغلاق.
  * زر إغلاق مرن في الزاوية المناسبة `end-3.5 top-3.5 rounded-full`.
  * تذييل مرن على الموبايل `flex flex-col-reverse sm:flex-row sm:justify-end gap-2`.
  * حماية الاستمارات من الإغلاق العرضي بالنقر خارج النافذة طالما بدأ المستخدم بإدخال بيانات (`onPointerDownOutside` / `onEscapeKeyDown`).
* **القوائم المنسدلة (Dropdowns):**
  * ضبط حاوية الخيارات بحد أقصى للارتفاع `max-h-[min(20rem,60dvh)] overflow-y-auto` لمنع قص الخيارات خلف حافة الشاشة.

### 2. شبكات الإحصائيات المتجاوبة (KPI Responsive Grids)
* تحويل شبكات الإحصائيات والملخصات العلوية إلى عمودين على الهواتف و 4 أعمدة على الأجهزة الكبيرة (`grid-cols-2 sm:grid-cols-4`) منعاً لتكدس الأرقام وقصها.

### 3. الوضع الخفيف والأجهزة الضعيفة (Performance & Lite Mode)
* دعم الأداء الذكي (`auto | full | lite` عبر `performance-mode.ts`).
* إيقاف التمويه الخلفي (`backdrop-filter`) والحركات اللانهائية المستنزفة لوحدة الرسوميات على الأجهزة الضعيفة والمتوسطة.
* تجزئة رسم شبكة المنتجات الضخمة تزايدياً لمنع تجمّد الواجهة.

### 4. معيار توحيد الواجهة المعتمد (Unified UI Standard — 2026-11-23)
* **تباعد الشريط الجانبي والصفحة (`MainLayout` & `PageHeader`):**
  * يعتمد `<main>` على هامش منطقي ديناميكي متزامن مع `--sidebar-offset`: `ms-0 md:ms-[calc(var(--sidebar-offset,0px)+0.75rem)] me-0 transition-[margin] duration-300 ease-in-out` مع حشوة علوية وسفلية تراعي المناطق الآمنة (`pt-[calc(1rem+var(--app-safe-top,0px))] pb-[env(safe-area-inset-bottom,0px)]`).
  * حاوية الصفحات القياسية: `p-3 sm:p-4 md:p-6 space-y-4 md:space-y-6` بدون `pt-12`/`pt-14` يدوية، مع استخدام `<PageHeader>` في جميع الصفحات غير المخصصة لنقطة البيع (وعنوان `<h1>` واحد فقط في كل صفحة).
* **أزرار الإضافة والإجراءات والحوارات:**
  * زر الإضافة الأساسي يوضع داخل `<PageHeader actions={...}>` بالنمط `<Button variant="default" size="default">` مع أيقونة `<Plus className="w-4 h-4 shrink-0" />` دون أزرار FAB مكررة خارج POS.
  * ترتيب أزرار تذييل الحوار (`<DialogFooter>` / `<AlertDialogFooter>`): **إلغاء (`variant="outline"`) أولاً ← حفظ/تأكيد (`variant="default"`) أو حذف (`variant="destructive"`) ثانياً**، دون تجاوز `flex-col-reverse sm:flex-row sm:justify-end gap-2`.
  * ترويسة الحوار تستخدم `pe-12` ومحتوى التمرير يستخدم `<DialogBody>` وأبعاد الشرائح القياسية (`28rem` للتأكيد، `32rem` للنماذج، `42rem` للنماذج العريضة) دون تثبيت `dir="rtl"` يدوياً.
* **أهداف اللمس، الجداول، الشارات، والتنبيهات:**
  * أزرار الأيقونات تعتمد `size="icon"` (`size-11 sm:size-10` أو `size-11 sm:size-9` في الصفوف الكثيفة) مع `aria-label` مترجم.
  * ترويسة الجداول القياسية `<TableHeader>` مثبتة افتراضياً (`sticky top-0 z-10 bg-muted/60`) مع محاذاة منطقية `text-start` للنصوص و`text-end` للأرقام.
  * الشارات بحد أدنى `text-xs font-semibold rounded-full` وبألوان دلالية (`success`/`warning`/`info`/`destructive`)، والتنبيهات القياسية عبر `@/lib/sonner-bridge`.
