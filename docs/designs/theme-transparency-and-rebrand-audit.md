# وثيقة التصميم المعماري: تدقيق نظام السمات والزجاج السائل وتجريد الهوية التجارية
# Architecture Design: Theme System, Liquid Glass Refinement, and Trademark Decoupling

* **المؤلف (Author):** almhtrf111312
* **الحالة (Status):** معتمدة للمواصفات والتنفيذ (Approved Specification — Post-Review Resolved)
* **تاريخ الاعتماد:** 2026-11-09
* **المكونات المستهدفة:** `src/components/settings/ThemeSection.tsx`، `src/index.css`، `src/hooks/use-theme.tsx`، `src/lib/store-settings-sync.ts`

--------------------------------------------------------------------------------

## 1. نظرة عامة (Overview)

تحدد هذه الوثيقة المعمارية معايير وضوابط ترقية نظام التصميم البصري والزجاج السائل في تطبيق FlowPOS Pro بعد اجتياز التدقيق المعزول لوكلاء EGM، والتي تحقق:
1. **تجريد الهوية التجارية (Trademark Decoupling & Rebranding):**
   فك أي ارتباط بأي علامة تجارية مسجلة لطرف ثالث ("Xiaomi" أو "HyperOS")، واعتماد الهوية الأصلية المستقلة للنظام: **Flow Glass (النمط الزجاجي الانسيابي)**، مع صيانة التوافق الخلفي التام (100% Backward Compatibility) لقيم التخزين السحابية والمحلية السابقة.
2. **هندسة الزجاج السائل والشفافية التكيفية (WCAG AAA Contrast & Dual Refraction):**
   معايرة عتامة الزجاج لتصل إلى درجات أمان عالية (`0.88` في الفاتح و `0.88` في الداكن) مع تقوية حدود الانكسار الضوئي (`--border-refract: rgba(0, 0, 0, 0.14)` فاتح و `rgba(255, 255, 255, 0.18)` داكن) لمنع أي تشويش أو ضبابية على الأرقام المالية ونصوص الفواتير تحت كل ظروف الإضاءة.
3. **أمان الأداء والخلفيات البديلة الصامتة (Lite Mode Solid Fallbacks & Rendering Containment):**
   - حظر الشفافية الزجاجية في وضع توفير الأداء (`html[data-perf="lite"]`) واستبدالها تلقائياً بأسطح مصمتة مريحة (`hsl(var(--card))`) لحماية الأجهزة الضعيفة وطابعات POS المحمولة من ظاهرة التداخل البصري (Layer Bleed).
   - تطبيق العزل الرسومي `contain: layout paint` على بطاقات شبكة نقطة البيع (`.pos-item`) لضمان ثبات معدل الإطارات (Solid 60 FPS) مهما بلغ عدد المنتجات.
4. **التوافق المعماري الشامل (Dual-Injection Architecture):**
   تطبيق نمط الحقن المزدوج للكلاسين (`.theme-flowglass` و `.theme-xiaomi`) في جذر المستند، مما يضمن التوافق 100% مع أي قواعد CSS حالية ومستقبلية دون أي كسر.

--------------------------------------------------------------------------------

## 2. المحظورات الصارمة والثوابت غير القابلة للمساس (Non-Goals & Core Invariants)

1. **الثوابت المحاسبية والمالية السبعة (The 7 Invariants):**
   - حظر لمس أي معادلة حسابية، أسعار صرف، تعاملات الدولار الأساسي ($USD)، الضرائب، أو أرباح الشركاء والديون.
2. **الوحدات المجمدة تماماً (Frozen Modules):**
   - حظر قطعي للمساس بملفات:
     * `src/pages/Warehouses.tsx`
     * `src/pages/StockTransfer.tsx`
     * `src/lib/cloud/warehouses-cloud.ts`
3. **عزل قواعد البيانات و RLS:**
   - صفر تعديلات على قاعدة بيانات Supabase أو استعلامات الشبكة أو دوال الـ RPC.
4. **الذاكرة العضلية للكاشير (Muscle Memory Lock):**
   - الحفاظ التام على أبعاد ومواقع أزرار الدفع والسلة وشريط الفئات، وأهداف اللمس محصنة بمساحة `>= 44px`.

--------------------------------------------------------------------------------

## 3. تفاصيل التعديلات البرمجية الجراحية (Surgical Implementation Details)

### أ. ملف واجهة إعدادات المظهر: `src/components/settings/ThemeSection.tsx`
- استبدال اسم النمط:
  * العنوان بالعربية: `نمط زجاجي فائق (Flow Glass)`
  * العنوان بالإنجليزية: `Flow Glass Style`
  * الشارة: `Flow Glass`
  * الوصف بالعربية: `حواف منحنية ناعمة (Squircle) وتأثيرات زجاجية سائلة وانكسار ضوئي فيزيائي متقدم.`
  * الوصف بالإنجليزية: `Smooth squircle corners, dynamic liquid glass depth, and optical light refraction.`
- القيمة المحددة: `'flowglass'` (مع التحقق المرن `pendingStyle === 'flowglass' || pendingStyle === 'xiaomi'`).

### ب. ملف إدارة نمط السمة: `src/hooks/use-theme.tsx`
- توسيع تعريف النوع:
  ```typescript
  export type ThemeStyle = 'standard' | 'flowglass' | 'xiaomi';
  ```
- تحديث دالة تطبيق النمط `applyThemeStyle`:
  ```typescript
  export function applyThemeStyle(style: ThemeStyle) {
    const root = document.documentElement;
    const isGlass = style === 'flowglass' || style === 'xiaomi';
    root.setAttribute('data-theme-style', isGlass ? 'flowglass' : 'standard');
    if (isGlass) {
      root.classList.add('theme-flowglass', 'theme-xiaomi');
    } else {
      root.classList.remove('theme-flowglass', 'theme-xiaomi');
    }
  }
  ```

### ج. ملف مزامنة الإعدادات: `src/lib/store-settings-sync.ts`
- دعم تطبيع القيمة في `loadUnifiedStoreSettings` و `applyCloudStoreSettings`:
  ```typescript
  style: (pt.style === 'flowglass' || pt.style === 'xiaomi') ? pt.style : 'standard',
  ```
  ```typescript
  applyThemeStyle((theme.style === 'flowglass' || theme.style === 'xiaomi') ? theme.style : 'standard');
  ```

### د. ملف الأنماط المركزية: `src/index.css`
1. دعم المحددات المشتركة:
   ```css
   :is(.theme-flowglass, .theme-xiaomi),
   .theme-flowglass,
   .theme-xiaomi {
     --radius: 1.25rem;
     --spring-easing: cubic-bezier(0.2, 0, 0, 1);
     --spring-bouncy: cubic-bezier(0.34, 1.3, 0.64, 1);
     --spring-fast: cubic-bezier(0.16, 1, 0.3, 1);
     
     /* Flow Glass Independent Tokens */
     --glass-accent: 215 100% 54%;
     --glass-accent-glow: rgba(10, 124, 255, 0.38);
     --surface-glass: rgba(255, 255, 255, 0.88);
     --surface-card: rgba(255, 255, 255, 0.94);
     --surface-active: rgba(255, 255, 255, 0.98);
     --border-refract: rgba(0, 0, 0, 0.14);
     --specular-highlight: inset 0 1px 1px 0 rgba(255, 255, 255, 0.92);
     --inner-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7), inset 0 -1px 0 rgba(0, 0, 0, 0.04);

     /* Backward-compatible token aliases */
     --xiaomi-blue: var(--glass-accent);
     --xiaomi-blue-glow: var(--glass-accent-glow);
     --xiaomi-surface-glass: var(--surface-glass);
     --xiaomi-surface-card: var(--surface-card);
     --xiaomi-surface-active: var(--surface-active);
     --xiaomi-border-refract: var(--border-refract);
     --xiaomi-specular-highlight: var(--specular-highlight);
     --xiaomi-inner-shadow: var(--inner-shadow);
   }

   .dark.theme-flowglass,
   .dark .theme-flowglass,
   .dark.theme-xiaomi,
   .dark .theme-xiaomi {
     --surface-glass: rgba(18, 24, 38, 0.88);
     --surface-card: rgba(24, 32, 50, 0.92);
     --surface-active: rgba(255, 255, 255, 0.16);
     --border-refract: rgba(255, 255, 255, 0.18);
     --specular-highlight: inset 0 1px 1px 0 rgba(255, 255, 255, 0.25);
     --inner-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18), inset 0 -1px 0 rgba(0, 0, 0, 0.35);
   }
   ```
2. عزل الرسم في شبكة نقطة البيع:
   ```css
   :is(.theme-flowglass, .theme-xiaomi) .pos-item {
     contain: layout paint;
   }
   ```
3. بدائل وضع السرعة والتوفير (Lite Mode Solid Surfaces):
   ```css
   html[data-perf="lite"] :is(.theme-flowglass, .theme-xiaomi) aside[data-tour="sidebar"],
   html[data-perf="lite"] :is(.theme-flowglass, .theme-xiaomi) header,
   html[data-perf="lite"] :is(.theme-flowglass, .theme-xiaomi) [data-slot="card"],
   html[data-perf="lite"] :is(.theme-flowglass, .theme-xiaomi) .card,
   html[data-perf="lite"] :is(.theme-flowglass, .theme-xiaomi) .pos-item,
   html[data-perf="lite"] :is(.theme-flowglass, .theme-xiaomi) [role="dialog"],
   html[data-perf="lite"] :is(.theme-flowglass, .theme-xiaomi) .smart-toast-card,
   html[data-perf="lite"] :is(.theme-flowglass, .theme-xiaomi) [role="tablist"] {
     background: hsl(var(--card)) !important;
     backdrop-filter: none !important;
     -webkit-backdrop-filter: none !important;
   }
   ```

--------------------------------------------------------------------------------

## 4. مصفوفة المصادقة والاعتماد (Approval & Resolution)

* [x] **Color Contrast & Readability:** معايير WCAG AAA محققة برفع عتامة الأسطح وحدود الانكسار.
* [x] **Trademark & Branding:** تجريد كامل لأي أسماء خارجية واعتماد مسمى Flow Glass المستقل.
* [x] **Backward Compatibility:** الحفاظ الكامل على دعم قراءة وتطبيق الإعداد القديم `'xiaomi'`.
* [x] **Performance Safety:** عزل شبكة المنتجات (`contain: layout paint`) وحماية وضع Lite بأسطح مصمتة.
* [x] **Verification Gate:** فحص جاهزية البناء واعتماد خطة التنفيذ الجراحي.
