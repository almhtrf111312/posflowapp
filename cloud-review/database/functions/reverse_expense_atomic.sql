-- reverse_expense_atomic(p_expense_id uuid, p_reason text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.reverse_expense_atomic(p_expense_id uuid, p_reason text DEFAULT 'تراجع بواسطة المستخدم'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_caller UUID := auth.uid();
    v_expense RECORD;
BEGIN
    IF v_caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'يج
ب تسجيل الدخول أولاً');
    END IF;

    -- جلب سجل المصروف مع التحقق من ملكية المستخدم أو المتجر
    SELECT * INTO v_expense 
    FROM public.expenses 
    WHERE id = p_expense_id 
      AND (user_id = v_caller OR user_id = public.get_owner_id(v_caller));

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'المصروف غير موجود أو لا تملك صلاحية الوصول إليه');
    END IF;

    IF COALESCE(v_expense.is_reversed, false) THEN
        RETURN jsonb_build_object('success', false, 'message', 'تم التراجع عن هذا المصروف مسبقاً');
    END IF;

    -- وسم المصروف كمسترد مع حفظ وقت وسبب التراجع وهوية المنفذ للتدقيق
    UPDATE public.expenses
    SET is_reversed = TRUE,
        reversed_at = NOW(),
        reversed_by = v_caller,
        reversed_reason = p_reason
    WHERE id = p_expense_id;

    RETURN jsonb_build_object(
        'success', true, 
        'amount', v_expense.amount,
        'expense_type', v_expense.expense_type,
        'message', 'تم التراجع عن المصروف بنجاح'
    );
END;
$function$
;
