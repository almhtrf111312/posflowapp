# وثائق التصميم المعماري (EGM Architecture Design Documents)

فهرس وثائق المواصفات والتصاميم المعمارية المعتمدة وفق منهجية الفيل والسمكة الذهبية (Elephant-Goldfish Model):

| الوثيقة | التاريخ | المؤلف | الحالة | المكونات المستهدفة | الملخص |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [`security-lock-and-theme-animation.md`](./security-lock-and-theme-animation.md) | 2026-11-08 | almhtrf111312 | معتمدة (Approved) | `AppLockProvider`, `AppLockOverlay`, `theme-transition.ts` | حارس قفل أمان التطبيق (PIN Lock) ومعايرة حركية فقاعة الثيم. |
| [`performance-and-tab-transitions.md`](./performance-and-tab-transitions.md) | 2026-11-08 | almhtrf111312 | قيد المراجعة المعمارية (In Review) | `NativeTabHost`, `KeepAliveTab`, `POS.tsx`, `Invoices.tsx`, `Products.tsx` | تدقيق الأداء الفائق (60 FPS) وانتقالات التبويبات الانسيابية المعجلة بالعتاد (240ms). |
| [`security-and-financial-audit.md`](./security-and-financial-audit.md) | 2026-11-08 | almhtrf111312 | معتمدة ومحصنة (Approved) | `use-app-lock.tsx`, `products-cloud.ts`, `transaction-lock.ts`, `sync-queue.ts`, `CartPanel.tsx` | التدقيق الأمني والمالي الشامل، حجب أسعار التكلفة عن الكاشير دون تلويث الكاش، تحصين الـ PIN، وضمان ثوابت المحرك المالي وسلسلة المزامنة الذرية. |
| [`mobile-responsive-ui-ux-audit.md`](./mobile-responsive-ui-ux-audit.md) | 2026-11-08 | almhtrf111312 | معتمدة ومحصنة (Approved) | `ProductGrid.tsx`, `CartPanel.tsx`, `POSHeader.tsx`, `POS.tsx`, `SegmentedCapsule.tsx`, `Invoices.tsx`, `Sidebar.tsx`, `use-theme.tsx` | التدقيق الشامل لمرونة الواجهات واستقرار الخطوط وتجاوب شاشات الموبايل المتفاوتة، ترقية أهداف اللمس (>=44px)، وحظر اقتصاص الأرقام المالية. |
