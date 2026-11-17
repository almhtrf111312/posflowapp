-- إصلاحات نتائج اختبار الضغط (flowpos-stress)
-- 1) refund_invoice_atomic: تعارض اسم العمود invoice_id مع معامل OUT
-- 2) partner_deposit_atomic: حذف النسخة القديمة (7 معاملات) التي تسبب غموض PostgREST وتشير لأعمدة غير موجودة
-- 3) shift_tx_ref_uniq: reference_id صار فريداً لكل حركة إيداع/سحب شريك
-- 4) منع حذف الفواتير مباشرة من جلسات المستخدمين (الاسترداد هو المسار الوحيد)

-- 1) إصلاح الغموض (يحافظ على التوقيع والصلاحيات)
DO $$
DECLARE d text; d2 text;
BEGIN
  d := pg_get_functiondef('public.refund_invoice_atomic(text,text)'::regprocedure);
  d2 := regexp_replace(d,
    'UPDATE\s+public\.invoice_items\s+SET\s+profit\s*=\s*0\s+WHERE\s+invoice_id\s*=\s*_invoice\.id',
    'UPDATE public.invoice_items ii SET profit = 0 WHERE ii.invoice_id = _invoice.id', 'gi');
  IF d2 <> d THEN EXECUTE d2; END IF;
END $$;

-- 2) حذف النسخة المكررة
DROP FUNCTION IF EXISTS public.partner_deposit_atomic(uuid, numeric, text, text, uuid, text, numeric);
GRANT EXECUTE ON FUNCTION public.partner_deposit_atomic(uuid, numeric, text, text, uuid, text, numeric, numeric) TO authenticated, service_role;

-- 3) مرجع فريد لكل حركة شريك داخل الوردية
DO $$
DECLARE r record; d text; d2 text;
BEGIN
  FOR r IN SELECT p.oid FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname IN ('partner_deposit_atomic', 'partner_withdrawal_atomic') LOOP
    d := pg_get_functiondef(r.oid);
    d2 := regexp_replace(d, '_partner_id::text(\s*\);)', '_partner_id::text || '':'' || gen_random_uuid()::text\1', 'g');
    IF d2 <> d THEN EXECUTE d2; END IF;
  END LOOP;
END $$;

-- 4) منع حذف الفواتير مباشرة
DROP POLICY IF EXISTS "Users delete own invoices" ON public.invoices;

CREATE OR REPLACE FUNCTION public.block_direct_invoice_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND COALESCE(current_setting('app.invoice_delete_context', true), '') <> 'allowed' THEN
    RAISE EXCEPTION 'حذف الفواتير مباشرة غير مسموح. استخدم الاسترداد' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS z_block_direct_invoice_delete ON public.invoices;
CREATE TRIGGER z_block_direct_invoice_delete
BEFORE DELETE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.block_direct_invoice_delete();
