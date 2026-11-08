# التقرير الموحد لمراجعة سرب السمكة الذهبية (EGM Consolidated Review Report)
**الوثيقة المفحوصة:** [`docs/designs/pos-grid-and-reports-audit.md`](./pos-grid-and-reports-audit.md) (`EGM-DES-005`)  
**المشروع:** Flow POS Pro  
**التاريخ:** 2026-11-08  
**المشاركون في سرب المراجعة (7 وكلاء مستقلين):**
1. ناقد التصميم المعماري (`egm-design`)
2. مدقق الكود الحرفي (`egm-codebase-details`)
3. قائد الجاهزية التنفيذية (`egm-implementation-readiness`)
4. محفز الابتكار وحلال التناقضات (`egm-inventive-catalyst` / TRIZ)
5. المعماري المشكك ومبسط النظم (`egm-zoom-out`)
6. مهندس الوثائق والمعماري الهيكلي (`egm-structural`)
7. القارئ البسيط ومراجع الوضوح (`egm-comprehension`)

---

## 1. الإجماع المعماري والقرارات الحاسمة (Consensus & Key Architectural Decisions)

حقق سرب المراجعة إجماعاً كاملاً ومتقاطعاً عبر الوكلاء السبعة حول 4 محاور حاسمة:

### المحور الأول: حل التناقض المعماري لشبكة الموبايل الثلاثية (TRIZ & Layout)
- **المشكلة:** في شاشات 320px–360px، العرض الصافي المتاح داخل بطاقة المنتج لا يتعدى 85px–98px. وضع السعر وشارة الكمية جنباً إلى جنب في شريط أفقي يؤدي حتماً إلى تداخل أو سحق شارة الكمية، خاصة مع العملات الكبيرة (مثل الدينار العراقي).
- **الحل المعتمد بالإجماع:**
  1. **الاستخلاص (Extraction):** نقل شارة الكمية بالكامل لتكون شارة عائمة في الزاوية العلوية لصورة المنتج (`absolute top-1 end-1 z-10 bg-background/90 dark:bg-card/90 backdrop-blur-xs text-[10px] font-black px-1.5 py-0.5 rounded-md border border-border/60 shadow-xs`).
  2. **تحرير مساحة السعر:** تخصيص 100% من عرض قاعدة البطاقة لسعر المنتج حصراً بخط واضح ومريح `text-xs font-black` دون منافس أفقي وبدون أي اقتطاع (`no truncate`).
  3. **تحسين نسبة الصورة:** اعتماد `aspect-[4/3]` لتحرير مساحة رأسية تتيح سطرين كاملين لعنوان المنتج (`line-clamp-2 min-h-[2rem] text-[11px] leading-tight`).
  4. شطب كلاس `h-4.5` غير المعتمد في Tailwind واستبداله بقياسات صريحة مدعومة.

### المحور الثاني: تحصين محرك التواريخ والمنطقة الزمنية (`src/lib/date-utils.ts`)
- **المشكلة:**
  1. استخدام `new Date(date)` على سلاسل `YYYY-MM-DD` يفسرها كـ UTC Midnight، مما يؤدي إلى انزياح التواريخ يوماً للوراء في المناطق الزمنية السالبة.
  2. طرح ملي ثوانٍ ثابتة `Date.now() - 86400000` ينهار في أيام الانتقال للتوقيت الصيفي/الشتوي (DST).
  3. تشتت دوال التاريخ بين عدة شاشات.
- **الحل المعتمد بالإجماع:**
  1. حماية `toLocalDateString` بفحص تعبير نمطي: إذا كانت السلسلة بصيغة `YYYY-MM-DD` تُعاد كما هي دون تحويل `new Date`.
  2. اعتماد الحساب التقويمي لجافاسكريبت: `d.setDate(d.getDate() - n)`.
  3. إنشاء دالة موحدة للفترات: `getDatePresetRange(preset: 'today' | 'yesterday' | 'week' | 'month' | 'last30')`.
  4. إنشاء دالة موحدة للحدود السحابية: `getLocalDayUtcRange(dateStr)` تحسب بداية ونهاية اليوم المحلي بدقة متناهية (`00:00:00.000` إلى `23:59:59.999`) وتحولها إلى UTC ISO لاستعلامات Supabase.

### المحور الثالث: توحيد العزل المحاسبي للفواتير (Status & Ledger Coherence)
- **المشكلة:** تباين شروط الفلترة بين الشاشات؛ فبعضها يستبعد المسترد فقط (`refunded`) ويتجاهل الملغي (`cancelled`) والمشطوب (`written_off`) مثل `SalesDetailedReport.tsx`، أو يتجاهل الحالة تماماً مثل `CashierPerformanceReport.tsx` و `MaintenanceReport.tsx`.
- **الحل المعتمد بالإجماع:**
  - اعتماد دالة نطاق موحدة (Domain Predicate) في `src/lib/cloud/invoices-cloud.ts`:
    ```ts
    export function isValidActiveInvoice(inv: Invoice): boolean {
      return inv.status !== 'cancelled' && inv.status !== 'refunded' && inv.status !== 'written_off';
    }
    ```
  - تطبيقها الصارم في كافة شاشات التقارير وتحديث `DailyClosingReport` و `MaintenanceReport` و `PartnerProfitDetailedReport`.

### المحور الرابع: مسار سداد الديون السحابي وبدون إنترنت (Cloud & Offline Sync)
- **المشكلة:** كود `loadDebtPaymentsForDate` يفرض `Z` (UTC) على تاريخ محلي في استعلام السحابة، وفي المسار المحلي (Offline Fallback) يقارن التاريخ بـ `split('T')[0]`.
- **الحل المعتمد بالإجماع:**
  - استخدام `getLocalDayUtcRange(dateStr)` للاستعلام السحابي.
  - استخدام `toLocalDateString(l.timestamp) === dateStr` لسجلات النشاط المحلي في مسار الـ Offline.

---

## 2. مصفوفة تتبع الملاحظات وتضمينها في الوثيقة المحصنة

| الملاحظة | المصدر (الوكيل) | درجة الخطورة | المعالجة في الوثيقة المحصنة |
| :--- | :--- | :---: | :--- |
| نقل شارة الكمية فوق الصورة وتحرير السعر | `egm-inventive-catalyst`, `egm-design`, `egm-zoom-out` | **Blocker** | تم تضمين تصميم الشارة العائمة ونسبة 4:3 وسطرين للاسم في القسم 5.1 |
| منع خطأ ECMAScript في بارسينغ `YYYY-MM-DD` | `egm-design`, `egm-codebase-details` | **Blocker** | تم إضافة الفحص النمطي الصريح في `toLocalDateString` في القسم 5.2 |
| إلغاء طرح `86400000ms` واعتماد `setDate` | كافة الوكلاء | **Major** | تم استبدال كافة الحسابات بالحساب التقويمي المعياري في القسم 5.2 |
| إنشاء دالة فترات مركزية ودالة حدود سحابية | `egm-zoom-out`, `egm-design`, `egm-implementation-readiness` | **Major** | تم إدراج `getDatePresetRange` و `getLocalDayUtcRange` في القسم 5.2 |
| تصحيح مسار الـ Offline في `debts-cloud.ts` | `egm-design`, `egm-codebase-details`, `egm-implementation-readiness` | **Blocker** | تم توثيق الكود الجراحي الصريح للسحابة والأوفلاين في القسم 5.5 |
| شمول `MaintenanceReport.tsx` و `PartnerProfitDetailedReport.tsx` | `egm-codebase-details`, `egm-implementation-readiness` | **Major** | تم توسيع نطاق الوثيقة وتضمين الملفين بكود صريح في القسم 5.4 |
| تصحيح كلاس Tailwind غير الموجود `h-4.5` | `egm-codebase-details`, `egm-implementation-readiness` | **Nit** | تم استبداله بكلاسات صريحة مدعومة في القسم 5.1 |
| روابط تشعبية وتناظر مصفوفة التحقق | `egm-structural` | **Major** | تم تحويل كافة المسارات إلى روابط قابلة للنقر وتوسيع مصفوفة التحقق إلى 10 بنود |

---

## 3. القرار النهائي لسرب المراجعة
**الحالة:** معتمدة وجاهزة للتنفيذ (Approved for Implementation) بعد تضمين التعديلات في وثيقة المواصفات [`pos-grid-and-reports-audit.md`](./pos-grid-and-reports-audit.md).
