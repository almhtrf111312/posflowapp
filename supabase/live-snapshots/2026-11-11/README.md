# لقطة التعريفات الحية — 11 نوفمبر 2026

تعريفات 12 دالة مالية كما كانت في قاعدة الإنتاج بتاريخ 2026-11-11 (مصدرها `pg_get_functiondef`).
الغرض: مرجع للمقارنة، ونقطة تراجع قبل تعديلات المرحلة 1 وما بعدها.

- 11 دالة مطابقة حرفياً لآخر نسخة في `supabase/migrations` (الملفان `20261111020000` و`20261111030000`).
- `process_pos_sale_atomic` لم يكن يطابقها أي ملف migration. أُضيفت نسختها الحية في
  `supabase/migrations/20261111060000_process_pos_sale_atomic_live_baseline.sql`.
- نسخة `process_pos_sale_atomic` داخل `20261105230000_unit1_atomic_partner_profit_distribution.sql`
  أقدم من الحية (تقريب لخانتين، ولا تضبط `tax_inclusive`). لا تُطبَّق منفردة؛ ملف الأساس أعلاه يستبدلها.

للتراجع عن تعديل دالة: شغّل ملفها من هذا المجلد كما هو في Supabase SQL Editor.
ملف `ROLLBACK_phase1.sql` يتراجع عن المرحلة 1 كاملة.
