# قواعد الأداء الهندسية الملزمة — PosFlow App

> **وثيقة ملزمة (Mandatory Engineering Standard):** تُطبّق هذه القواعد الخمس على كل ميزة جديدة، تعديل شاشة، أو استعلام قاعدة بيانات في **PosFlow App** (Android Capacitor + Windows Electron).  
> **التوافق المرجعي:** متطابقة بالكامل مع `AGENTS.md` و`SYSTEM_ARCHITECTURE.md` ومستهدفات `docs/baseline.md` (إقلاع بارد على Android `< 1.5s`، وتمرير ثابت عند `60 FPS`).

---

## القاعدة 1: فهارس Postgres المركّبة ومنع استعلامات `N+1`

### 1.1 الفهارس المركّبة المتوافقة مع RLS
- جميع الجداول السحابية في Supabase معزولة بسياسة RLS عبر `WHERE user_id = get_owner_id(auth.uid())`.
- كل استعلام جديد يصفّي أو يرتّب جدولاً تشغيلياً (`invoices`, `invoice_items`, `debts`, `debt_payments`, `expenses`, `purchases`, `stock_counts`, `audit_logs`) يجب أن يستند إلى **فهرس مركّب يبدأ بـ `user_id`** متبوعاً بأعمدة التصفية ثم الترتيب، مثل:
  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_user_status_created
    ON public.invoices (user_id, status, created_at DESC);
  ```
- **قيد أمني إلزامي (`AGENTS.md`):** يُمنع إنشاء أو تشغيل أي SQL أو Migration أو RPC على الإنتاج (`bwlqfxfvchjvehnbvwaz`) دون عرض التغيير وأخذ موافقة المالك الصريحة مسبقاً.

### 1.2 حظر استعلامات `N+1`
- **ممنوع** تنفيذ استعلام Supabase أو SQLite داخل حلقات (`for`, `forEach`, `map` مع `Promise.all` غير مجمّع) لجلب تفاصيل كل صف على حدة (مثل جلب بنود كل فاتورة أو دفعات كل دين منفردة).
- **البديل المعتمد:**
  1. استخدام الربط المباشر في استعلام واحد عبر PostgREST (`select('id, invoice_number, total, invoice_items(product_id, quantity, unit_price)')`).
  2. التجميع عبر `.in('invoice_id', ids)` بدفعات منضبطة (100–200 معرّف كحد أقصى للدفعة).
  3. للعمليات المحاسبية المتعددة (البيع، المرتجع، خصم المخزون، سداد الدين): استخدام دوال **SQL RPC الذرية** المقفلة بـ `FOR UPDATE` بدل تتابع استدعاءات من الواجهة.

---

## القاعدة 2: التصفح الجزئي (`Pagination`) وتحديد الأعمدة — حدود الواجهة مقابل مزامنة Offline-First

### 2.1 تحديد الأعمدة الصريح (Column Projection)
- **ممنوع** استخدام `.select('*')` في قوائم العرض أو الجداول التشغيلية؛ يجب تحديد الأعمدة المطلوبة فعلياً للشاشة فقط لتقليل حجم الحمولة (Payload) وزمن تحليل JSON على أجهزة Android الضعيفة.
- في عمليات الكتابة والمزامنة، يجب الالتزام الصارم بقائمة الأعمدة المسموحة في `TABLE_ALLOWED_COLUMNS` دون إرسال حقول إضافية أو محسوبة محلياً.

### 2.2 التمييز بين استعلامات الواجهة وجداول مزامنة Offline-First

| نوع المسار | الجداول النموذجية | القاعدة الملزمة | الحد الآمن الموصى به |
| :--- | :--- | :--- | :--- |
| **قوائم الواجهة والتقارير** | `invoices`, `debts`, `expenses`, `audit_logs`, `stock_counts`, `stock_damages`, `customer_credit_ledger` | **Pagination إلزامي** عبر `.range(from, to)` أو Cursor (`lt('created_at', cursor)`) مع فرز مفهرس. يُمنع جلب كامل السجل التاريخي دفعة واحدة. | `50–100` صفاً لشاشات العرض؛ وحتى `200–500` صفاً لدفعات التقارير المجمّعة (كما في `profit-ledger-cloud.ts` و`invoices-cloud.ts`). |
| **جداول مزامنة Offline-First** | `products`, `categories`, `customers`, `partners`, `store_settings` | يجوز سحب الكتالوج الكامل لضمان استمرارية البيع دون إنترنت، **بشرط** التجزئة عبر `.range(from, from + CHUNK_SIZE - 1)` (كما في `products-cloud.ts`)، وتحديد الأعمدة الضرورية فقط، والمزامنة التفاضلية (`updated_at > lastSync`) متى توفّرت. | `CHUNK_SIZE = 500–1000` لكل دفعة مع تخزين فوري في SQLite/IndexedDB وعدم حجز الخيط الرئيسي. |

> **خط أحمر (`AGENTS.md`):** يُمنع لمس أو تعديل ملفات المستودعات المجمدة (`src/pages/Warehouses.tsx`، `src/pages/StockTransfer.tsx`، `src/lib/cloud/warehouses-cloud.ts`).

---

## القاعدة 3: الصور بصيغة `WebP` مضغوطة + `loading="lazy" decoding="async"`

- **التنسيق والضغط قبل الرفع:** كل صورة جديدة (منتج، مرفق دعم، شعار متجر) تُضغط وتُحوَّل إلى **`WebP`** قبل رفعها إلى التخزين السحابي أو حفظها محلياً:
  - صور بطاقات المنتجات: عرض أقصى `800px` بجودة `0.75–0.82` (الهدف `< 80 KB`).
  - الصور المصغّرة (Thumbnails): عرض أقصى `256px` (الهدف `< 20 KB`).
- **وسوم التحميل الإلزامية:** كل عنصر `<img>` غير أساسي في الشاشة الأولى يجب أن يحمل السمتين معاً (وفق نمط `src/components/products/ProductImage.tsx`):
  ```tsx
  <img
    src={src}
    alt={alt}
    loading="lazy"
    decoding="async"
    className="aspect-square w-full object-cover"
  />
  ```
- **منع اهتزاز التخطيط (Zero CLS):** تحديد أبعاد ثابتة (`width`/`height` أو `aspect-*`) لكل حاوية صورة قبل اكتمال التحميل.
- **التخزين المؤقت للصور:** الاعتماد على `src/lib/image-cache.ts` لتفادي إعادة تنزيل صور الكتالوج مع كل جلسة أو عند انقطاع الشبكة.

---

## القاعدة 4: طبقات الكاش الأربع (`native-swr-cache` + SQLite/IndexedDB + React Query)

يعتمد PosFlow App هندسة كاش متعددة الطبقات تضمن استجابة فورية (`< 1ms` من الذاكرة) وتشغيلاً كاملاً دون إنترنت، ويجب أن تحترم كل ميزة جديدة هذا الترتيب:

1. **الطبقة L1 — كاش فوري للعرض (`src/lib/cache/native-swr-cache.ts`):**
   - استخدام `NativeSWRCache.getInstant(key, { userId, maxAgeMs, idbFallback })` لإظهار البيانات السابقة فوراً (`0ms` من RAM أو `fps_swr_*` في `localStorage` بسقف 60 عنصراً) أثناء التحديث الخلفي.
   - **إلزامي:** تمرير `userId` لعزل بيانات الحسابات ومنع تسرب كاش مستخدم إلى آخر عند تبديل الجلسة.
2. **الطبقة L2 — التخزين المحلي الدائم (Offline-First Store):**
   - **Android:** قاعدة بيانات SQLite الأصلية عبر `@capacitor-community/sqlite` (`posflow_local_db` في `src/lib/db/native-sqlite.ts`).
   - **Windows (Electron):** قاعدة `IndexedDB` (`posflow_cache` في `src/lib/indexeddb-cache.ts`).
   - تُسجَّل عمليات الكتابة أثناء انقطاع الاتصال في طابور FIFO عبر `src/lib/sync-queue.ts` مع `op_id` لمنع التكرار، مع تنظيف أعلام الانتظار عند الإزالة (`removeFromQueue`).
3. **الطبقة L3 — إدارة حالة السيرفر (`@tanstack/react-query`):**
   - تغليف جلب البيانات في Hooks تعتمد على `QueryClient` المهيأ في `src/App.tsx` (`refetchOnWindowFocus: false`, `refetchOnReconnect: true`) مع تحديد `staleTime` مناسب لطبيعة البيانات (مثلاً: `30s–2m` للتقارير والديون، `5m+` للإعدادات والكتالوج المزامَن).
   - تحديث البيانات بعد أي عملية كتابة يتم عبر `queryClient.invalidateQueries(...)` وأحداث النظام الموحدة (`EVENTS.*`)؛ **يُمنع تماماً** استخدام `window.location.reload()`.
4. **الطبقة L4 — التهيئة المسبقة (`src/lib/cloud/cache-warmup.ts`):**
   - تسخين بيانات الشاشة الأساسية (نقطة البيع والمنتجات والإعدادات) في الخلفية بعد تسجيل الدخول دون حجب الرسم الأولي.

---

## القاعدة 5: `Skeleton Loading` بدل الشاشات البيضاء + CSS الحديث بدل مكتبات JS ثقيلة

### 5.1 واجهات التحميل الهيكلية (`Skeleton Loading`)
- **ممنوع** ترك شاشة بيضاء فارغة أو حجب الصفحة بدوّار تحميل عام (Full-page Spinner) أثناء جلب البيانات.
- استخدام مكوّن `<Skeleton />` (`src/components/ui/skeleton.tsx`) لبناء هيكل مطابق لشكل البطاقات أو صفوف الجدول أو بطاقات KPI (`grid-cols-2 sm:grid-cols-4`).
- احترام **الوضع الخفيف (`src/lib/performance-mode.ts` — `auto | full | lite`)**: تعطيل تأثيرات `backdrop-filter` وحركات `shimmer`/`pulse` اللانهائية تلقائياً على أجهزة نقاط البيع الضعيفة.

### 5.2 اعتماد CSS الحديث وتجنب مكتبات JS غير الضرورية
- قبل تثبيت أي مكتبة JS جديدة في `package.json`، يُفحص أولاً إمكانية تحقيق السلوك عبر CSS أصلي مدعوم في Chromium (Android WebView + Electron):
  - **شرائط التمرير والبطاقات الأفقية:** `scroll-snap-type` و`scroll-snap-align` بدل مكتبات Carousel.
  - **التخطيط المتجاوب:** `CSS Grid` (`auto-fill`, `minmax`), `clamp()`, و**Container Queries** (`@container`) بدل مستمعات `ResizeObserver` الثقيلة.
  - **القوائم الطويلة:** `content-visibility: auto` مع `contain-intrinsic-size` أو التجزئة التزايدية (Incremental Batch Rendering) لقوائم المنتجات الضخمة، وتفادي `transition-all` على مئات البطاقات (استبدالها بخصائص محددة مثل `transition-colors` أو `transition-transform`).
- **تقسيم الحزم (`Code Splitting`):** تحميل الصفحات الثقيلة (مثل التقارير والإعدادات) عبر `React.lazy` مع تغليفها بـ `FeatureErrorBoundary` والحفاظ على `manualChunks` في `vite.config.ts`.

---

## قائمة التحقق السريعة قبل الدمج (Pre-Merge Performance Checklist)

- [ ] لا توجد استعلامات داخل حلقات (`N+1`)، وأي استعلام جديد يعتمد على أعمدة مفهرسة تبدأ بـ `user_id`.
- [ ] كل قائمة عرض تستخدم تحديد أعمدة صريح + `Pagination` (`.range` / `.limit`)، وجداول Offline-First تُجزّأ بدفعات.
- [ ] جميع الصور الجديدة بصيغة `WebP` مضغوطة وتحمل `loading="lazy" decoding="async"` وأبعاداً ثابتة.
- [ ] البيانات تستخدم `NativeSWRCache` / SQLite-IndexedDB / React Query مع `userId` للعزل، وبدون `window.location.reload()`.
- [ ] حالة التحميل تعرض `<Skeleton />` متوافق مع `Lite Mode`، ولم تُضَف مكتبة JS يمكن استبدالها بـ CSS حديث.
- [ ] نجاح البناء الكامل: `npm run build` برمز خروج `0`.
