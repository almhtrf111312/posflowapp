-- تصحيح الدينين المكررين للعميل (فاتورتا 20261007-00114 و 20261011-00131).
-- يدمج صفّي الدين لكل فاتورة في الصف الأقدم (الذي أنشأته دالة البيع): ينقل الدفعة إليه، يجمع المدفوع، ويحذف الصف المكرر.
-- يتوقف دون أي تغيير إذا لم تطابق الأرقام ما رأيناه في الاستعلام (أ).
BEGIN;

DO $fix$
DECLARE
  r record;
  _keep public.debts%ROWTYPE;
  _dup  public.debts%ROWTYPE;
  _inv  public.invoices%ROWTYPE;
  _paid numeric;
  _remaining numeric;
  _fixed integer := 0;
BEGIN
  FOR r IN
    SELECT d.user_id, d.invoice_id
    FROM public.debts d
    WHERE d.invoice_id IN ('20261007-00114', '20261011-00131')
      AND COALESCE(d.is_cash_debt, false) = false
    GROUP BY d.user_id, d.invoice_id
    HAVING count(*) = 2
  LOOP
    SELECT * INTO _keep FROM public.debts
     WHERE user_id = r.user_id AND invoice_id = r.invoice_id
     ORDER BY created_at ASC LIMIT 1 FOR UPDATE;
    SELECT * INTO _dup FROM public.debts
     WHERE user_id = r.user_id AND invoice_id = r.invoice_id AND id <> _keep.id
     FOR UPDATE;
    SELECT * INTO _inv FROM public.invoices
     WHERE user_id = r.user_id AND invoice_number = r.invoice_id FOR UPDATE;

    _paid := round(COALESCE(_keep.total_paid, 0) + COALESCE(_dup.total_paid, 0), 2);
    _remaining := round(GREATEST(COALESCE(_keep.total_debt, 0) - _paid, 0), 2);

    -- صمام أمان: المتبقي بعد الدمج يجب أن يساوي المتبقي المسجّل على الفاتورة
    IF abs(_remaining - COALESCE(_inv.debt_remaining, 0)) > 0.01 THEN
      RAISE EXCEPTION 'الفاتورة %: المتبقي بعد الدمج (%) لا يطابق متبقي الفاتورة (%). لم يُغيَّر شيء.',
        r.invoice_id, _remaining, _inv.debt_remaining;
    END IF;

    UPDATE public.debt_payments SET debt_id = _keep.id WHERE debt_id = _dup.id;

    UPDATE public.debts
       SET total_paid = _paid,
           remaining_debt = _remaining,
           status = CASE WHEN _remaining <= 0 THEN 'fully_paid' ELSE 'partially_paid' END,
           notes = concat_ws(E'\n', notes, '[تصحيح 2026-11-11] دُمج معه صف دين مكرر للفاتورة نفسها'),
           updated_at = now()
     WHERE id = _keep.id;

    DELETE FROM public.debts WHERE id = _dup.id;

    UPDATE public.invoices
       SET debt_paid = _paid,
           debt_remaining = _remaining,
           updated_at = now()
     WHERE id = _inv.id;

    _fixed := _fixed + 1;
  END LOOP;

  IF _fixed <> 2 THEN
    RAISE EXCEPTION 'المتوقع تصحيح فاتورتين، والموجود %. لم يُغيَّر شيء.', _fixed;
  END IF;
END
$fix$;

COMMIT;

-- تحقق بعد التصحيح (قراءة فقط). المتوقع: صف واحد لكل فاتورة
--   20261007-00114: total_debt 20.00, total_paid 12.81, remaining_debt 7.19, partially_paid, دفعة واحدة
--   20261011-00131: total_debt 5.00,  total_paid 5.00,  remaining_debt 0.00, fully_paid,     دفعة واحدة
SELECT d.invoice_id, d.total_debt, d.total_paid, d.remaining_debt, d.status,
       i.debt_paid AS invoice_paid, i.debt_remaining AS invoice_remaining, i.status AS invoice_status,
       (SELECT count(*) FROM public.debt_payments dp WHERE dp.debt_id = d.id) AS payments_count
FROM public.debts d
JOIN public.invoices i ON i.user_id = d.user_id AND i.invoice_number = d.invoice_id
WHERE d.invoice_id IN ('20261007-00114', '20261011-00131')
ORDER BY d.invoice_id;

-- رصيد دين العميل المسجّل مقابل مجموع ديونه المفتوحة (قراءة فقط). إن اختلفا أرسل لي النتيجة قبل أي تعديل.
SELECT c.name, c.total_debt AS customer_total_debt,
       (SELECT round(COALESCE(SUM(d.remaining_debt), 0), 2)
          FROM public.debts d
         WHERE d.user_id = c.user_id
           AND lower(trim(d.customer_name)) = lower(trim(c.name))
           AND d.status NOT IN ('fully_paid', 'written_off', 'cancelled')) AS open_debts_sum
FROM public.customers c
WHERE EXISTS (
  SELECT 1 FROM public.debts d
  WHERE d.user_id = c.user_id
    AND d.invoice_id IN ('20261007-00114', '20261011-00131')
    AND lower(trim(d.customer_name)) = lower(trim(c.name))
);
