-- cancel_debt_atomic(_debt_id uuid, _reason text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.cancel_debt_atomic(_debt_id uuid, _reason text DEFAULT 'إلغاء الدين'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_owner uuid := public.get_owner_id(auth.uid());
  v_debt public.debts%ROWTYPE;
BEGIN
  IF v_caller IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  SELECT * INTO v_debt FROM public.debts WHERE id = _debt_id FOR UPDATE;
  IF NOT FOUND OR v_debt.user_id <> v_owner THEN
    RAISE EXCEPTION 'الدين غير موجود';
  END IF;

  IF v_debt.status IN ('cancelled', 'written_off') THEN
    RETURN jsonb_build_object('success', true, 'already_closed', true, 'debt_id', _debt_id);
  END IF;

  -- الدين المرتبط بفاتورة بيع لا يُلغى مباشرة حتى لا تبقى الفاتورة وأرباح الشركاء معلقة
  IF v_debt.invoice_id IS NOT NULL AND NOT COALESCE(v_debt.is_cash_debt, false)
     AND EXISTS (SELECT 1 FROM public.invoices i
                  WHERE i.user_id = v_owner
                    AND (i.invoice_number = v_debt.invoice_id OR i.id::text = v_debt.invoice_id)
                    AND COALESCE(i.status, '') NOT IN ('refunded', 'cancelled')) THEN
    RAISE EXCEPTION 'هذا الدين مرتبط بالفاتورة %: استخدم «تسديد» إذا دفع العميل، أو «استرداد الفاتورة» إذا أُلغي البيع، أو «شطب الدين» إذا تعذر التحصيل', v_debt.invoice_id;
  END IF;

  -- تخفيض رصيد العميل بالمتبقي
  IF COALESCE(v_debt.remaining_debt, 0) > 0 AND v_debt.customer_name IS NOT NULL THEN
    UPDATE public.customers
       SET total_debt = GREATEST(0, round(COALESCE(total_debt, 0) - COALESCE(v_debt.remaining_debt, 0), 8)),
           updated_at = now()
     WHERE user_id = v_owner
       AND (name = v_debt.customer_name OR (v_debt.customer_phone IS NOT NULL AND phone = v_debt.customer_phone));
  END IF;

  -- وسم الدين كملغى مع الاحتفاظ بالسجل
  UPDATE public.debts
     SET status = 'cancelled',
         notes = concat_ws(E'\n', notes, '[ملغى] ' || COALESCE(_reason, 'إلغاء الدين')),
         updated_at = now()
   WHERE id = _debt_id;

  RETURN jsonb_build_object('success', true, 'debt_id', _debt_id, 'cancelled_amount', COALESCE(v_debt.remaining_debt, 0));
END;
$function$
;
