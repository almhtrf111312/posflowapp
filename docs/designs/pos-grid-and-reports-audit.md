# وثيقة المواصفات التصميمية: إصلاح شبكة عرض الموبايل والتدقيق الشامل لقسم التقارير
> **Specification Document: POS Mobile 3-Column Grid Fix & Comprehensive Reports Audit**

- **المعرف (Doc ID):** `EGM-DES-005`
- **المؤلف (Author):** `almhtrf111312` (كبير مهندسي النظم المالية وتجربة المستخدم)
- **التاريخ (Date):** 2026-11-08
- **الحالة (Status):** معتمدة ومحصنة بعد مراجعة سرب السمكة الذهبية (Approved & Hardened)
- **المسار (Path):** [`docs/designs/pos-grid-and-reports-audit.md`](./pos-grid-and-reports-audit.md)
- **تقرير المراجعة الموحد:** [`docs/designs/consolidated_review_report.md`](./consolidated_review_report.md)

---

## 1. ملخص تنفيذي (Executive Summary)
تحدد هذه الوثيقة المعمارية معالجة جراحية شاملة ومترابطة لجانبين حاسمين في نظام **Flow POS Pro**:
1. **شبكة عرض المنتجات على الموبايل ([`ProductGrid.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/pos/ProductGrid.tsx)):** تمكين العرض الثلاثي الفعلي (3 أعمدة `grid-cols-3` جنباً إلى جنب) على كافة شاشات الهواتف المحمولة (بعرض نافذة يبدأ من 320px إلى 375px) عبر تطبيق نمط TRIZ الابتكاري (نقل شارة الكمية كطبقة عائمة فوق زاوية الصورة وتحرير كامل عرض قاعدة البطاقة للسعر) وتعديل نسبة الصورة إلى `4:3` مع إتاحة سطرين كاملين للاسم (`line-clamp-2`) دون أي تمرير أفقي أو اقتصاص مالي.
2. **التدقيق المحاسبي والزمني الشامل لقسم التقارير:** القضاء الجذري على الخلل الزمني الناتج عن توليد التواريخ السريعة عبر توقيت غرينتش `UTC` (`toISOString().split('T')[0]`)، وتوحيد محرك التواريخ المحلي في [`date-utils.ts`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/lib/date-utils.ts)، وفرض دالة تحقق مركزية واحدة لعزل الفواتير الملغاة والمستردة والمشطوبة عن كافة تقارير المبيعات وأداء الكاشير والصيانة وسداد الديون سحابياً ومحلياً (Offline).

---

## 2. الثوابت والمحددات المحمية (The Protected Invariants)
- **العملة الأساسية ($USD):** الدولار الأمريكي هو الأساس لكافة القيود والعمليات المحاسبية، وتعديل العملة في الواجهة هو طبقة تسعير وعرض فقط تعتمد على معدل الصرف اللحظي.
- **حظر الحذف المالي التدميري:** لا حذف لسجلات الفواتير أو الديون أو المصاريف؛ المعالجة حصراً عبر حالات الإلغاء والاسترداد الموثقة.
- **الملفات المجمدة (Frozen Modules):** حظر تعديل [`Warehouses.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/pages/Warehouses.tsx)، [`StockTransfer.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/pages/StockTransfer.tsx)، و [`warehouses-cloud.ts`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/lib/cloud/warehouses-cloud.ts).
- **أهداف اللمس والذاكرة العضلية:** أزرار سلة البيع والمحاسبة الأساسية خط أحمر؛ وأهداف اللمس لكافة الأزرار تلتزم بحد أدنى 44px × 44px. بطاقة المنتج في الشبكة الثلاثية تمثل هدف لمس كلي كبير يتجاوز 110px × 140px.
- **حظر اقتطاع الأرقام والأسعار:** منع استخدام `truncate` على أسعار المنتجات أو المجاميع المالية، واستخدام `tabular-nums whitespace-nowrap` دائماً.

---

## 3. الأهداف ونطاق العمل (Goals & Non-Goals)

### الأهداف (Goals):
1. إتاحة عرض 3 منتجات بجانب بعضها (`grid-cols-3`) في شاشات الموبايل عند تفعيل النمط المكثف (`dense`) مع إبقاء النمط العادي (`grid`) بعمودين، وضمان تناسق أبعاد البطاقة ونصوصها دون أي تمرير أفقي.
2. توحيد محرك مقارنة التواريخ في [`src/lib/date-utils.ts`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/lib/date-utils.ts) ليعتمد التوقيت المحلي للجهاز الصارم (Local Browser Timezone) مع تغطية اليوم الزمني كاملاً من `00:00:00.000` حتى `23:59:59.999`.
3. استئصال كافة استدعاءات `toISOString().split('T')[0]` المستخدمة في فلاتر التقارير السريعة في [`Reports.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/pages/Reports.tsx) و [`ReportFiltersBar.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/ReportFiltersBar.tsx) واستبدالها بدالة فترات موحدة `getDatePresetRange`.
4. فرض دالة تدقيق محاسبية موحدة `isValidActiveInvoice` في كافة شاشات التقارير:
   - [`src/components/reports/SalesDetailedReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/SalesDetailedReport.tsx)
   - [`src/components/reports/CashierPerformanceReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/CashierPerformanceReport.tsx)
   - [`src/components/reports/DailyClosingReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/DailyClosingReport.tsx)
   - [`src/components/reports/MaintenanceReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/MaintenanceReport.tsx)
   - [`src/components/reports/PartnerProfitDetailedReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/PartnerProfitDetailedReport.tsx)
5. تصحيح استعلام جلب سداد الديون في [`src/lib/cloud/debts-cloud.ts`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/lib/cloud/debts-cloud.ts) ليعتمد `getLocalDayUtcRange` في السحابة و `toLocalDateString` في المسار المحلي (Offline).

### غير المستهدف (Non-Goals):
- عدم تعديل مخطط قاعدة البيانات (Schema) أو جداول SQLite/IndexedDB.
- عدم تغيير واجهة المستخدم العامة للتقارير أو حذف أي من مفاتيح اللغات (عربي، إنجليزي، تركي).
- عدم لمس مسار الحسابات المحاسبية للأرباح في `money-engine.ts`.

---

## 4. التحليل التقني المعمق والأسباب الجذرية (Root Cause Analysis)

### أ. سبب انكسار شبكة الـ 3 أعمدة على الموبايل:
- في [`ProductGrid.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/pos/ProductGrid.tsx)، النمط المكثف (`dense`) كُتب كالتالي:
  `grid grid-cols-2 xs:grid-cols-3 sm:grid-cols-4 md:grid-cols-5...`
- نقطة الكسر `xs` معرّفة في [`tailwind.config.ts`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/tailwind.config.ts) عند `380px`.
- أغلب هواتف أندرويد المعيارية (360px - 375px) تفشل في تفعيل شرط `xs`، فترتد الشبكة إجبارياً إلى عمودين (`grid-cols-2`).
- النمط العادي محصور بـ `grid-cols-2 sm:grid-cols-3`، والنمط المدمج محصور بـ `grid-cols-1`.
- عند محاولة وضع 3 أعمدة في مساحة 320px-360px، يتبقى للبطاقة عرض صافٍ 85px-98px، ووضع السعر وشارة الكمية جنباً إلى جنب أفقياً يؤدي لسحق الشارة أو انكسار السطر.

### ب. سبب سقوط فواتير اليوم والخلل في التقارير:
- الفلاتر السريعة في `Reports.tsx` و `ReportFiltersBar.tsx` تستخدم `new Date().toISOString().split('T')[0]`. في الشرق الأوسط (UTC+3)، بعد منتصف الليل وحتى 3:00 فجراً، ينتج تاريخ الأمس، فيطلب النظام فواتير الأمس بدلاً من اليوم، بينما الفواتير والسجلات تُحول للمقارنة عبر `toLocalDateString(inv.createdAt)` (بالتوقيت المحلي)، فتفشل المقارنة وتسقط فواتير اليوم.
- في `debts-cloud.ts`: دالة `loadDebtPaymentsForDate` تبني استعلام Supabase هكذا: `${dateStr}T00:00:00.000Z`، وفي مسار الأوفلاين تفحص `l.timestamp?.split('T')[0] === dateStr`، مما يسقط مدفوعات الساعات الأولى سحابياً ومحلياً.
- في `SalesDetailedReport.tsx`: الكود يستبعد فقط `refunded` ويتجاهل `cancelled`، بينما التقرير الإجمالي في `Reports.tsx` يستبعد `cancelled` و `written_off`، مما ينشئ تبايناً محاسبياً بين المجاميع والتفاصيل.
- في `CashierPerformanceReport.tsx` و `MaintenanceReport.tsx`: يتم احتساب الفواتير الملغاة ضمن المبيعات والأرباح.

---

## 5. المواصفات الهندسية الدقيقة للتعديلات الجراحية (Detailed Engineering Specs)

### 5.1 ترقية شبكة المنتجات في [`src/components/pos/ProductGrid.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/pos/ProductGrid.tsx)

1. **إلغاء شرط `xs` وجعل النمط المكثف 3 أعمدة مباشرة:**
   ```tsx
   {/* Dense View - 3 items side-by-side on mobile, 4-7 on desktop */}
   {viewMode === 'dense' && (
     <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-1.5 sm:gap-2">
   ```

2. **هيكلة بطاقة المنتج بنمط الشارة العائمة ونسبة 4:3 وسطرين للاسم:**
   ```tsx
   <button
     key={product.id}
     {...pressHandlers(product)}
     className="pos-item text-start fade-in group bg-card rounded-xl p-1.5 sm:p-2 shadow-xs hover:shadow-sm border border-border/50 flex flex-col justify-between transition-[box-shadow,border-color] duration-200 active:scale-95 transition-transform"
     style={{ animationDelay: `${index * 15}ms` }}
   >
     {/* صورة المنتج بنسبة 4:3 مع شارة كمية عائمة في الزاوية العلوية */}
     <div className="w-full aspect-[4/3] bg-muted/20 rounded-lg overflow-hidden mb-1 sm:mb-1.5 relative flex items-center justify-center shrink-0">
       <ProductImage
         imageUrl={product.image}
         alt={product.name}
         className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-200"
         iconClassName="w-4 h-4 sm:w-5 sm:h-5 text-muted-foreground/30"
       />
       {/* شارة الكمية العائمة - تحرر 100% من عرض السعر السفلي */}
       <span className="absolute top-1 end-1 z-10 inline-flex h-4 min-w-[1.25rem] px-1 items-center justify-center rounded-md bg-background/90 dark:bg-card/90 backdrop-blur-xs border border-border/60 text-[9px] font-black leading-none tabular-nums text-foreground shadow-xs">
         {product.quantity}
       </span>
     </div>

     {/* جسم البطاقة: سطرين للاسم وقاعدة مخصصة بالكامل للسعر */}
     <div className="flex flex-col justify-between flex-1 w-full gap-1">
       <h4 className="font-bold text-[10px] sm:text-[11px] text-foreground leading-tight line-clamp-2 min-h-[1.75rem] w-full text-start break-words" title={product.name}>
         {product.name}
       </h4>
       <div className="w-full pt-1 border-t border-border/30 mt-auto flex items-center justify-start">
         {renderDisplayPrice(product.price, 'text-[11px] sm:text-xs font-black')}
       </div>
     </div>
   </button>
   ```

---

### 5.2 تحصين محرك التواريخ في [`src/lib/date-utils.ts`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/lib/date-utils.ts)

استبدال كامل محتوى الملف بالكود المعياري المحصن التالي:

```ts
// Utilities for consistent local date handling and range checks

/**
 * Convert a Date object or ISO string to a local `YYYY-MM-DD` string.
 * Uses the local timezone so that the day reflects the user's environment.
 * If already in `YYYY-MM-DD` format, returns directly to prevent ECMAScript UTC midnight shifts.
 */
export function toLocalDateString(date: Date | string): string {
  if (!date) return '';
  if (typeof date === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Calendar-based date helper methods preventing DST 86400000ms shifts.
 */
export function getTodayLocal(): string {
  return toLocalDateString(new Date());
}

export function getYesterdayLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return toLocalDateString(d);
}

export function getDaysAgoLocal(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toLocalDateString(d);
}

export function getMonthStartLocal(): string {
  const now = new Date();
  return toLocalDateString(new Date(now.getFullYear(), now.getMonth(), 1));
}

export function getWeekStartLocal(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - (day === 0 ? 6 : day - 1);
  return toLocalDateString(new Date(now.getFullYear(), now.getMonth(), diff));
}

/**
 * Single source of truth for UI date presets.
 */
export function getDatePresetRange(preset: 'today' | 'yesterday' | 'week' | 'month' | 'last30'): { from: string; to: string } {
  const today = getTodayLocal();
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = getYesterdayLocal();
      return { from: y, to: y };
    }
    case 'week':
      return { from: getWeekStartLocal(), to: today };
    case 'month':
      return { from: getMonthStartLocal(), to: today };
    case 'last30':
      return { from: getDaysAgoLocal(30), to: today };
    default:
      return { from: today, to: today };
  }
}

/**
 * Get exact start and end UTC ISO strings for a given local date string.
 * Used for accurate Supabase queries bridging browser local day bounds to UTC.
 */
export function getLocalDayUtcRange(dateStr: string): { startIso: string; endIso: string } {
  const [y, m, d] = dateStr.split('-').map(Number);
  return {
    startIso: new Date(y, m - 1, d, 0, 0, 0, 0).toISOString(),
    endIso: new Date(y, m - 1, d, 23, 59, 59, 999).toISOString(),
  };
}

/**
 * Lexical, timezone-safe check whether a date falls between two local YYYY-MM-DD boundaries (inclusive).
 */
export function isDateInRange(
  dateInput: Date | string,
  from: string,
  to: string
): boolean {
  if (!dateInput || !from || !to) return false;
  const dStr = typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)
    ? dateInput
    : toLocalDateString(dateInput);
  if (!dStr) return false;
  return dStr >= from && dStr <= to;
}
```

---

### 5.3 دالة التحقق المحاسبي المركزية في [`src/lib/cloud/invoices-cloud.ts`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/lib/cloud/invoices-cloud.ts)

إضافة الدالة الموحدة التالية:
```ts
/**
 * Single source of truth for active financial invoices.
 * Excludes cancelled, refunded, and written off invoices.
 */
export function isValidActiveInvoice(inv: { status?: string }): boolean {
  return inv.status !== 'cancelled' && inv.status !== 'refunded' && inv.status !== 'written_off';
}
```

---

### 5.4 تحديث شاشات التقارير المحاسبية

1. **[`src/pages/Reports.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/pages/Reports.tsx):**
   - استيراد `getDatePresetRange`, `getTodayLocal`, `getDaysAgoLocal`, `isValidActiveInvoice`.
   - استبدال التهيئة المبدئية لـ `dateRange` بـ `getDatePresetRange('last30')`.
   - استبدال `handleDatePreset` باستدعاء `getDatePresetRange(preset)`.
   - تحديث حساب المبيعات السابقة `previousPeriodSales` ليعتمد التفكيك التقويمي المعجمي.
   - تحديث الأسطر 1394، 1683، 1994 لفواتير الصيانة بتضمين `isValidActiveInvoice(inv)`.

2. **[`src/components/reports/ReportFiltersBar.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/ReportFiltersBar.tsx):**
   - استبدال دوال `datePresets` بالاستدعاء المباشر لـ `getDatePresetRange('today')`، `'yesterday'`، `'week'`، `'month'`، `'last30'`.

3. **[`src/components/reports/SalesDetailedReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/SalesDetailedReport.tsx):**
   - استبدال فحص الحالة بالسطر 43 بـ:
     ```ts
     if (!isValidActiveInvoice(inv)) return false;
     ```

4. **[`src/components/reports/CashierPerformanceReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/CashierPerformanceReport.tsx):**
   - تحديث فلترة الفواتير بالسطر 30:
     ```ts
     const filtered = invoices.filter(inv => {
       const d = toLocalDateString(inv.createdAt);
       if (!isDateInRange(d, dateRange.from, dateRange.to)) return false;
       if (!isValidActiveInvoice(inv)) return false;
       if (inv.type !== 'sale' && inv.type !== 'maintenance') return false;
       return true;
     });
     ```

5. **[`src/components/reports/MaintenanceReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/MaintenanceReport.tsx):**
   - تحديث فلترة فواتير الصيانة بالسطر 25:
     ```ts
     return invoices.filter(inv => {
       const d = toLocalDateString(inv.createdAt);
       return isDateInRange(d, dateRange.from, dateRange.to) && inv.type === 'maintenance' && isValidActiveInvoice(inv);
     });
     ```

6. **[`src/components/reports/DailyClosingReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/DailyClosingReport.tsx):**
   - تحديث فحص الفواتير لاستبعاد المشطوبة:
     ```ts
     if (!isValidActiveInvoice(inv)) return false;
     ```
   - توحيد فحص تواريخ المصاريف والديون:
     ```ts
     const dayExpenses = expenses.filter(exp => toLocalDateString(exp.date) === selectedDate);
     const dayDebts = debts.filter(d => (d.createdAt ? toLocalDateString(d.createdAt) === selectedDate : false));
     ```

7. **[`src/components/reports/PartnerProfitDetailedReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/PartnerProfitDetailedReport.tsx):**
   - استبدال السطر 115 بـ:
     ```ts
     const recordDate = toLocalDateString(record.createdAt);
     if (!isDateInRange(recordDate, dateRange.from, dateRange.to)) return;
     ```

8. **[`src/components/reports/LibraryReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/LibraryReport.tsx):**
   - استبدال السطر 32 بـ `getTodayLocal()`.

9. **[`src/components/reports/DebtsReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/DebtsReport.tsx):**
   - استبدال السطر 91 بـ `toLocalDateString(d.createdAt || '')`.

---

### 5.5 تصحيح استعلام سداد الديون في [`src/lib/cloud/debts-cloud.ts`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/lib/cloud/debts-cloud.ts)

تحديث `loadDebtPaymentsForDate`:
```ts
export const loadDebtPaymentsForDate = async (dateStr: string): Promise<number> => {
  if (!dateStr) return 0;
  let total = 0;
  let foundInCloud = false;

  const { startIso, endIso } = getLocalDayUtcRange(dateStr);

  // 1. Try Supabase debt_payments table
  if (navigator.onLine) {
    try {
      const { data, error } = await sb
        .from('debt_payments')
        .select('amount, created_at')
        .gte('created_at', startIso)
        .lte('created_at', endIso);

      if (!error && data && data.length > 0) {
        foundInCloud = true;
        total = data.reduce((s, p) => s + Number(p.amount || 0), 0);
        return round8(total);
      }
    } catch (e) {
      console.warn('[loadDebtPaymentsForDate] cloud fetch failed:', e);
    }
  }

  // 2. Fallback: shift_transactions with type === 'debt_payment'
  if (!foundInCloud && navigator.onLine) {
    try {
      const { data: shiftTx, error } = await sb
        .from('shift_transactions')
        .select('amount, created_at')
        .eq('type', 'debt_payment')
        .gte('created_at', startIso)
        .lte('created_at', endIso);

      if (!error && shiftTx && shiftTx.length > 0) {
        return round8(shiftTx.reduce((s, tx) => s + Number(tx.amount || 0), 0));
      }
    } catch { /* silent */ }
  }

  // 3. Fallback locally from activity log
  try {
    const { loadActivityLogs: getActivityLogs } = await import('@/lib/activity-log');
    const logs = getActivityLogs();
    const dayLogs = logs.filter(l => 
      (l.type === 'debt_payment' || l.type === 'debt_paid') &&
      toLocalDateString(l.timestamp) === dateStr
    );
    if (dayLogs.length > 0) {
      const localTotal = dayLogs.reduce((s, l) => s + Number((l.details as any)?.amount || 0), 0);
      if (localTotal > 0 && !foundInCloud) {
        return round8(localTotal);
      }
    }
  } catch { /* silent */ }

  return round8(total);
};
```

---

## 6. مصفوفة التحقق والاختبار المتناظرة الشاملة (Comprehensive Verification Matrix)

| رقم الفحص | المكون المستهدف | سيناريو الاختبار | النتيجة المتوقعة |
| :--- | :--- | :--- | :--- |
| **V1** | [`ProductGrid.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/pos/ProductGrid.tsx) | عرض نمط `dense` على إطار عرض موبايل 360px و 320px | ظهور 3 بطاقات متجاورة، شارة الكمية عائمة فوق الصورة، السعر كامل، سطرين للاسم، صفر تجاوز أفقي |
| **V2** | [`date-utils.ts`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/lib/date-utils.ts) | فحص `toLocalDateString('2026-11-08')` في مناطق زمنية سالبة (UTC-5) | إرجاع السلسلة ذاتها `'2026-11-08'` دون انزياح للأمس |
| **V3** | [`ReportFiltersBar.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/ReportFiltersBar.tsx) | اختيار فلتر "اليوم" وفلتر "الأسبوع" في الساعات الأولى بعد منتصف الليل | مطابقة تامة مع تاريخ الجهاز المحلي وظهور فواتير اليوم كاملة |
| **V4** | [`SalesDetailedReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/SalesDetailedReport.tsx) | وجود فواتير بحالة `cancelled` و `written_off` | استبعادها تماماً وتطابق إجمالي المبيعات مع ملخص `Reports.tsx` |
| **V5** | [`CashierPerformanceReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/CashierPerformanceReport.tsx) | وجود فواتير ملغاة ومستردة للكاشير | عدم احتساب مبيعات وأرباح الفواتير الملغاة ضمن أداء الكاشير |
| **V6** | [`MaintenanceReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/MaintenanceReport.tsx) | وجود فواتير صيانة ملغاة | استبعاد فواتير الصيانة الملغاة والمستردة من التقرير المخصص |
| **V7** | [`DailyClosingReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/DailyClosingReport.tsx) | مطابقة تواريخ المصاريف والديون المسجلة ليلاً مع الإقفال اليومي | مطابقة تامة لليوم الزمني دون ضياع المصاريف والديون المسجلة محلياً |
| **V8** | [`debts-cloud.ts`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/lib/cloud/debts-cloud.ts) | استعلام سداد الديون سحابياً ومحلياً (Offline Mode) | دقة نافذة الـ UTC في السحابة، والتقاط سجلات النشاط المحلي بنجاح عند انقطاع الشبكة |
| **V9** | [`PartnerProfitDetailedReport.tsx`](file:///C:/Users/PREDATOR/Documents/GitHub/hyperpos-companion/src/components/reports/PartnerProfitDetailedReport.tsx) | مقارنة أرباح الشركاء بين التقرير التفصيلي والملخص العام | تطابق كامل لأرباح الساعات الأولى بين الواجهتين |
| **V10** | بوابة البناء (`Build Gate`) | تنفيذ `npm run build` | نجاح التجميع بـ `Exit Code 0` وخلو المشروع من أخطاء TypeScript |

---

## 7. معايير القبول والإغلاق (Acceptance Criteria)
1. اجتياز مراجعة سرب السمكة الذهبية المستقلة بالكامل واعتماد التقرير الموحد [`consolidated_review_report.md`](./consolidated_review_report.md).
2. التعديل الجراحي الحصري للرموز والأسطر المحددة دون المساس بأي من الملفات المجمدة.
3. التحقق اليدوي البصري والتأكد من نجاح أمر البناء `npm run build`.
4. موافقة المستخدم الصريحة قبل إجراء أي commit أو push.
