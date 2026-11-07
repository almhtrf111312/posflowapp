# وثائق التصميم المعماري (EGM Architecture Design Documents)

فهرس وثائق المواصفات والتصاميم المعمارية المعتمدة وفق منهجية الفيل والسمكة الذهبية (Elephant-Goldfish Model):

| الوثيقة | التاريخ | المؤلف | الحالة | المكونات المستهدفة | الملخص |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [`security-lock-and-theme-animation.md`](./security-lock-and-theme-animation.md) | 2026-11-08 | almhtrf111312 | معتمدة (Approved) | `AppLockProvider`, `AppLockOverlay`, `theme-transition.ts` | حارس قفل أمان التطبيق (PIN Lock) ومعايرة حركية فقاعة الثيم. |
| [`performance-and-tab-transitions.md`](./performance-and-tab-transitions.md) | 2026-11-08 | almhtrf111312 | قيد المراجعة المعمارية (In Review) | `NativeTabHost`, `KeepAliveTab`, `POS.tsx`, `Invoices.tsx`, `Products.tsx` | تدقيق الأداء الفائق (60 FPS) وانتقالات التبويبات الانسيابية المعجلة بالعتاد (240ms). |
