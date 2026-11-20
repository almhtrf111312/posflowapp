# مهام تعديل الاسم القديم (`Flow POS Pro` / `FlowPOS Pro`) في Supabase — مخصّصة لكلود

> **حالة الملف:** فحص للقراءة فقط (Read-Only Audit) من فرع `edit-to-gemini` بتاريخ 2026-11-20.  
> **مهم جداً:** لم يتم تعديل أي ملف داخل مجلد `supabase/` أو تشغيل أي SQL في هذا الفرع. المطلوب أن يتولى **Claude Code** فحص الحالة الحية على قاعدة بيانات PosFlow (`bwlqfxfvchjvehnbvwaz`) وتنفيذ البنود الآمنة أدناه فقط.

---

## أولاً: تعديلات مطلوبة (نصوص ظاهرة للمستخدمين — آمنة تماماً)

### 1. دالة Edge Function: `supabase/functions/telegram-auth/index.ts`
تحتوي على **7 رسائل تيليغرام** ما زالت تعرض الاسم القديم `Flow POS Pro` للمستخدمين. يجب استبدال `Flow POS Pro` بـ `POS Flow App` ثم إعادة نشر الدالة (`deploy`):

| الموقع التقريبي | النص الحالي | النص المطلوب |
| :--- | :--- | :--- |
| سطر ~85 (`HELP_TEXT`) | `❓ *مساعدة بوت Flow POS Pro*` | `❓ *مساعدة بوت POS Flow App*` |
| سطر ~181 (رسالة `/start`) | `👋 *مرحباً بك في Flow POS Pro*` | `👋 *مرحباً بك في POS Flow App*` |
| سطر ~365 (نجاح الربط) | `في نظام *Flow POS Pro*.` | `في نظام *POS Flow App*.` |
| سطر ~373 (رقم غير موجود) | `في نظام Flow POS Pro، أو التواصل` | `في نظام POS Flow App، أو التواصل` |
| سطر ~521 (رسالة OTP) | `الرمز الخاص بحسابك في *Flow POS Pro* هو:` | `الرمز الخاص بحسابك في *POS Flow App* هو:` |
| سطر ~680 / ~775 (تنبيه تغيير كلمة المرور) | `🛡️ *تنبيه أمني - Flow POS Pro*` | `🛡️ *تنبيه أمني - POS Flow App*` |
| سطر ~812 (طلب نقل الهاتف) | `وحساب آخر على *Flow POS Pro*.` | `وحساب آخر على *POS Flow App*.` |

*(ملاحظة: افحص آخر نسخة حية من `telegram-auth/index.ts` لأن أرقام السطور تحرّكت قليلاً بعد تعديلات 2026-11-20 الخاصة بالقائمة المضمّنة وتسجيل الخروج).*

---

### 2. دوال PostgreSQL في قاعدة Supabase (`bwlqfxfvchjvehnbvwaz`)
افحص الجسم الحي للدالتين التاليتين قبل تعديلهما عبر `pg_get_functiondef`، ثم أنشئ هجرة SQL جديدة نظيفة (لا تعدّل الهجرات التاريخية القديمة) لتحديث رسائل التفعيل فيهما:

1. **`public.confirm_subscription_request(p_request_id uuid)`**
   * المرجع السابق: `supabase/migrations/20261110030000_subscription_plans_and_confirmation.sql` (السطر ~99).
   * النص الحالي:
     ```sql
     'تم تفعيل ' || COALESCE(v_req.plan_name, v_plan.name, 'الاشتراك') || ' بنجاح! شكراً لاشتراكك مع FlowPOS Pro.'
     ```
   * النص المطلوب:
     ```sql
     'تم تفعيل ' || COALESCE(v_req.plan_name, v_plan.name, 'الاشتراك') || ' بنجاح! شكراً لاشتراكك مع POS Flow App.'
     ```

2. **`public.boss_activate_license(...)`**
   * المرجع السابق: `supabase/migrations/20261111010000_unified_boss_activation.sql` (السطر ~136).
   * النص الحالي:
     ```sql
     v_msg := 'تم تفعيل ' || v_plan_name || ' بنجاح! شكراً لاشتراكك مع FlowPOS Pro.';
     ```
   * النص المطلوب:
     ```sql
     v_msg := 'تم تفعيل ' || v_plan_name || ' بنجاح! شكراً لاشتراكك مع POS Flow App.';
     ```

---

### 3. بيانات جدول `public.app_settings` و`subscription_plans` (تحقق حي أولاً)
شغّل استعلام القراءة التالي على القاعدة الحية (`bwlqfxfvchjvehnbvwaz`) قبل أي `UPDATE`:

```sql
-- 1) فحص release_config وأي إعدادات تحتوي flowpos
SELECT key, value
FROM public.app_settings
WHERE value::text ILIKE '%flowpos%' OR value::text ILIKE '%flow pos%';

-- 2) فحص رسائل التفعيل المخزّنة في باقات الاشتراك
SELECT id, name, activation_message
FROM public.subscription_plans
WHERE activation_message ILIKE '%flowpos%' OR activation_message ILIKE '%flow pos%';
```

* في حال كان `release_config` ما زال يحتوي `"telegram_url": "https://t.me/flowpospro"`، حدّثه إلى `"https://t.me/posflowapp"` (بعد تأكيد القيمة الحية).
* في حال كانت `subscription_plans.activation_message` تحتوي `FlowPOS Pro` أو `Flow POS Pro`، حدّثها إلى `POS Flow App`.

---

## ثانياً: ⛔ منطقة حمراء (يُمنع لمسها في Supabase منعاً باتاً)

1. **`public.issue_offline_lease(p_device_id text)` — الثابت `'FLOWPOS_PRO_FALLBACK_SALT_2026'`**
   * المرجع: `supabase/migrations/20261118020000_live_only_functions.sql` (السطر 259).
   * **السبب:** يُستخدم في توقيع SHA-256 لتذاكر العمل بدون إنترنت (Offline Lease) للحسابات التي لا تملك `offline_lease_secret` مخصصاً. تغييره سيكسر التحقق من التذاكر القائمة لدى المستخدمين الأوفلاين. **يُترك كما هو تماماً.**

2. **`public.process_quick_purchase_atomic(...)` — مفتاح القفل `'flowpos-quick-purchase:'`**
   * المرجع: `supabase/migrations/20261117010000_quick_purchase_atomic.sql` (السطر 51).
   * **السبب:** مفتاح داخلي لـ `pg_advisory_xact_lock` غير ظاهر لأي مستخدم. لا حاجة للمساس به.

3. **ملفات الهجرات التاريخية القديمة في `supabase/migrations/`:**
   * يُمنع تعديل أي ملف هجرة تم تطبيقه سابقاً؛ أي تعديل على الدوال يتم عبر **ملف هجرة جديد** مع ملف تراجع (Rollback).

---

## ثالثاً: خطوة استكمال سريعة في فرع `edit-to-gemini`

لإكمال تعديلات ملفات الواجهة الكبيرة التي وُضعت في ملف الرقعة (Patch) بدقة 100% دون مخاطرة، ينفّذ كلود داخل فرع `edit-to-gemini`:

```bash
git checkout edit-to-gemini
git apply --ignore-whitespace REBRAND_LARGE_FILES.patch
rm REBRAND_LARGE_FILES.patch
npm run build
```

*(ثم تنفيذ بنود Supabase أعلاه، وبعدها يراجع المالك التغييرات قبل الدمج في `main`).*
