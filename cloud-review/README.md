# مجلد المراجعة السحابية — cloud-review

لقطة للمراجعة فقط (قراءة)، أُخذت من قاعدة البيانات الحية بتاريخ 2026-11-12.
**تعديل هذه الملفات لا يغيّر شيئاً في التطبيق أو قاعدة البيانات.**

## المحتويات

| المسار | المحتوى |
|---|---|
| `edge-functions/` | نسخة من كل الدوال السحابية (23 دالة: من `admin-change-password` إلى `validate-activation-code`) |
| `edge-functions/config.toml` | إعدادات الدوال (metadata) مثل `verify_jwt` |
| `database/functions/` | تعريف كل دالة SQL في قاعدة البيانات (105 دالة)، ملف لكل دالة، مع SECURITY DEFINER وصلاحيات EXECUTE |
| `database/functions/INDEX.md` | فهرس الدوال وتواقيعها |
| `database/rls_policies.sql` | كل سياسات الأمان RLS (109 سياسة) للجداول والتخزين |
| `database/triggers.sql` | كل الـ Triggers (67) |
| `database/schema_tables.sql` | الجداول (51) والأعمدة والقيود والفهارس وحالة RLS |
| `database/table_grants.md` | صلاحيات الأدوار anon / authenticated / service_role على الجداول |
| `database/storage_buckets.md` | حاويات التخزين وحدود الحجم والأنواع |
| `database/extensions.md` | الإضافات المفعّلة |

## ملاحظات
- المصدر الفعلي للدوال السحابية يبقى `supabase/functions/`، وسجل التعديلات (migrations) في `supabase/migrations/`.
- تم فحص الملفات ولم يُعثر على مفاتيح أو توكنات مكشوفة.
- إذا تغيّرت قاعدة البيانات لاحقاً فهذه اللقطة تصبح قديمة؛ اطلب تحديثها.
