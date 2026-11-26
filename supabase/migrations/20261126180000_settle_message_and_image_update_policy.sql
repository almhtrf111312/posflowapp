-- Owner-approved small fixes (2026-11-26):
-- 1) settle_invoice_debts_atomic used SELECT ... INTO STRICT: a missing invoice surfaced PostgreSQL's English
--    "query returned no rows". Now an Arabic message.
-- 2) product-images had no UPDATE policy, so restoring a backup (upload with upsert) failed when the image already existed.
--    Same rule as upload/delete: a user may update only files in their own folder.

DO $patch$
DECLARE
  target regprocedure := 'public.settle_invoice_debts_atomic(text,uuid,uuid)'::regprocedure;
  body text := replace(pg_get_functiondef(target), chr(13) || chr(10), chr(10));
  old_sel text := $o$  SELECT * INTO STRICT _invoice FROM public.invoices
    WHERE user_id = _owner AND invoice_number = _invoice_number FOR UPDATE;$o$;
  new_sel text := $n$  SELECT * INTO _invoice FROM public.invoices
    WHERE user_id = _owner AND invoice_number = _invoice_number FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الفاتورة غير موجودة'; END IF;$n$;
BEGIN
  IF strpos(body, new_sel) > 0 THEN RETURN; END IF;
  IF strpos(body, old_sel) = 0 THEN
    RAISE EXCEPTION 'settle_invoice_debts_atomic: expected invoice lookup not found';
  END IF;
  EXECUTE replace(body, old_sel, new_sel);
END
$patch$;

DROP POLICY IF EXISTS "Users can update own product images" ON storage.objects;
CREATE POLICY "Users can update own product images" ON storage.objects
  FOR UPDATE TO authenticated
  USING ((bucket_id = 'product-images') AND ((auth.uid())::text = (storage.foldername(name))[1]))
  WITH CHECK ((bucket_id = 'product-images') AND ((auth.uid())::text = (storage.foldername(name))[1]));
