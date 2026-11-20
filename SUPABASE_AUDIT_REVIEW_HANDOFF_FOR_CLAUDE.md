# حزمة إصلاحات Supabase الحرجة (مراجعة تحديثات v1.5.210–v1.5.215) — مخصّصة لكلود

> **الفرع:** `edit-to-gemini` (لم يتم لمس أي ملف داخل `supabase/` مباشرةً بناءً على تعليمات المالك).  
> **القاعدة المستهدفة:** PosFlow (`bwlqfxfvchjvehnbvwaz`) فقط — لا يُمس أي مشروع قديم.  
> **ملف الهجرة المقترح الجاهز:** `docs/gemini-handoff/20261120260000_posflow_audit_review_critical_fixes.sql`  
> **ملف التراجع الجاهز:** `docs/gemini-handoff/ROLLBACK_audit_review_fixes.sql`

---

## 1. ملخص الـ 8 إصلاحات داخل الهجرة المقترحة `20261120260000`

1. **`mark_invoice_digital`:** استبدال `user_id = auth.uid()` بـ `user_id = public.get_owner_id(auth.uid())` — كان كل بيع رقمي من الكاشير يفشل بصمت ويبقى مسجلاً كنقدي.
2. **`record_stock_damage_atomic`:** إصلاح الخصم المزدوج للمستودع الفرعي (`IF _warehouse_id IS NOT NULL` يخصم من `warehouse_stock` فقط، و`ELSE` يخصم من `products` فقط).
3. **`_partners_trim_history`:** إصلاح فخ الأداء (400 يوم + حد 1500 عنصر) ليحتفظ بآخر **90 يوماً** وبحد أقصى **500 عنصر** عند تجاوز 600 (مع بقاء التاريخ الكامل في `partner_ledger_entries`).
4. **`release_pending_partner_profits_for_invoice`:** قلب القيد الأصلي في `profit_history` إلى `isDebt: false` وتعليم دفعات التحرير السابقة `superseded: true` لمنع المضاعفة في `PartnerProfitDetailedReport`.
5. **`purchase_return_atomic`:** منع هبوط متوسط التكلفة (`cost_price`) إلى `0` إذا كان بسط المعادلة سالباً أو صفراً بعد مبيعات جزئية سابقة.
6. **`refund_invoice_partial_atomic`:** دعم تمرير أرقام تسلسلية محددة (`e->'serials'`) في المرتجع الجزئي مع إبقاء LIFO كخيار احتياطي فقط عند عدم تمريرها.
7. **`edit_purchase_invoice_atomic`:** حارس يمنع تعديل فاتورة شراء إذا كان أحد أرقامها التسلسلية قد بيع أو أُخرج (`status <> 'in_stock'`)، مع الحفاظ على حالة أحرف الرقم التسلسلي الأصلية عند الإدراج.
8. **فهرس Delta Sync:** إنشاء `idx_invoices_user_updated_at ON public.invoices (user_id, updated_at DESC)`.

---

## 2. خطوات التنفيذ لكلود على فرع `edit-to-gemini`

### أ) استكمال رقع الواجهة الأمامية
```bash
git checkout edit-to-gemini
git pull origin edit-to-gemini
git apply --ignore-whitespace FRONTEND_AUDIT_FIXES.patch
git apply --ignore-whitespace REBRAND_LARGE_FILES.patch
rm FRONTEND_AUDIT_FIXES.patch REBRAND_LARGE_FILES.patch
npm run build
```

### ب) تطبيق الهجرة الحرجة على Supabase (`bwlqfxfvchjvehnbvwaz`)
1. انقل `docs/gemini-handoff/20261120260000_posflow_audit_review_critical_fixes.sql` إلى `supabase/migrations/`.
2. انقل `docs/gemini-handoff/ROLLBACK_audit_review_fixes.sql` إلى `supabase/live-snapshots/rollbacks/`.
3. راجع الأجسام الحية ثم طبّق الهجرة على `bwlqfxfvchjvehnbvwaz`.
4. شغّل استعلام التحقق التالي وتأكد أن كل النتائج `true`:

```sql
SELECT
  (pg_get_functiondef('public.mark_invoice_digital(text)'::regprocedure) LIKE '%get_owner_id%') AS fix1_mark_digital_cashier,
  (pg_get_functiondef('public.record_stock_damage_atomic(uuid,uuid,numeric,numeric,text,text,boolean,text,text)'::regprocedure) LIKE '%ELSE%UPDATE public.products%') AS fix2_damage_no_double_deduct,
  (pg_get_functiondef('public._partners_trim_history()'::regprocedure) LIKE '%90 days%') AS fix3_partner_trim_90d,
  (pg_get_functiondef('public.release_pending_partner_profits_for_invoice(uuid)'::regprocedure) LIKE '%superseded%') AS fix4_partner_release_report,
  (pg_get_functiondef('public.purchase_return_atomic(uuid,jsonb,text,text)'::regprocedure) LIKE '%> 0 THEN round%') AS fix5_purchase_return_wac_guard,
  (pg_get_functiondef('public.refund_invoice_partial_atomic(text,jsonb,text)'::regprocedure) LIKE '%_refund_serial_release_v2%') AS fix6_partial_refund_explicit_serials,
  (pg_get_functiondef('public.edit_purchase_invoice_atomic(uuid,jsonb,text,text)'::regprocedure) LIKE '%بعض أرقامها التسلسلية بيعت%') AS fix7_edit_purchase_serial_guard,
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_invoices_user_updated_at') AS fix8_delta_sync_index;
```

---

## 3. بنود استكمال الـ Snapshots الناقصة في GitHub + إعادة التسمية في Supabase
1. استخرج من القاعدة الحية (`pg_get_functiondef` / `pg_get_viewdef`) وثبّت في `supabase/migrations/`:
   * كائنات المرحلة 7: `customer_credit_balances`، `_credit_actor`، `set_customer_credit_limit_atomic`، `issue_store_credit_atomic`، `apply_store_credit_to_debt_atomic`.
   * الجسم الحي المحدّث لدالة `finalize_purchase_invoice_atomic` ودالة `purchase_return_atomic`.
2. راجع ونفّذ أيضاً ملف `SUPABASE_REBRAND_TASKS_FOR_CLAUDE.md` (رسائل `telegram-auth` + هجرة رسائل التفعيل في `confirm_subscription_request` و`boss_activate_license` + فحص `app_settings` و`subscription_plans`).

---

## 4. تنبيهات المنطقة الحمراء
* ممنوع لمس الملفات المجمّدة: `src/pages/Warehouses.tsx`، `src/pages/StockTransfer.tsx`، `src/lib/cloud/warehouses-cloud.ts`.
* ممنوع لمس `FLOWPOS_PRO_FALLBACK_SALT_2026` داخل `issue_offline_lease` أو مفتاح `flowpos-quick-purchase:`.
* ممنوع الحذف الفيزيائي (`Hard DELETE`) لأي فاتورة أو دين أو مصروف أو حركة مالية.
* لا تدمج `edit-to-gemini` في `main` قبل مراجعة المالك النهائية.
