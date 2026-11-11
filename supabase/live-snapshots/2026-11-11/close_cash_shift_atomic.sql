CREATE OR REPLACE FUNCTION public.close_cash_shift_atomic(_shift_id uuid, _actual_balance numeric, _variance_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _shift record;
  _calc_expected numeric := 0;
  _inflow numeric := 0;
  _outflow numeric := 0;
  _variance numeric := 0;
  _status text := 'matched';
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  -- 1) قفل سجل الوردية
  SELECT * INTO _shift 
    FROM public.cash_shifts 
   WHERE id = _shift_id AND user_id = _owner 
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'الوردية غير موجودة أو لا تتبع للمتجر';
  END IF;

  IF _shift.closed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true, 
      'already_closed', true, 
      'shift_id', _shift_id
    );
  END IF;

  -- 2) حساب التدفقات المالية الداخلة (Sales, Deposits, Debt Payments, Surplus)
  SELECT COALESCE(SUM(amount), 0) INTO _inflow
    FROM public.shift_transactions
   WHERE shift_id = _shift_id 
     AND type IN ('sale', 'deposit_capital', 'deposit_revenue', 'deposit_purchase_cover', 'debt_payment', 'surplus', 'expense_refund');

  -- 3) حساب التدفقات المالية الخارجة (Expenses, Refunds, Withdrawals, Shortage)
  SELECT COALESCE(SUM(amount), 0) INTO _outflow
    FROM public.shift_transactions
   WHERE shift_id = _shift_id 
     AND type IN ('expense', 'refund', 'withdrawal', 'shortage');

  -- 4) احتساب الرصيد المتوقع والفارق
  _calc_expected := round(COALESCE(_shift.opening_balance, 0) + _inflow - _outflow, 2);
  _variance := round(COALESCE(_actual_balance, 0) - _calc_expected, 2);

  IF abs(_variance) >= 0.01 THEN
    _status := CASE WHEN _variance_reason IS NOT NULL AND length(trim(_variance_reason)) > 0 THEN 'matched' ELSE 'unmatched' END;
    
    -- تسجيل حركة تسوية بالصندوق لتوثيق الفارق في سجل الحركات
    IF _variance > 0 THEN
      INSERT INTO public.shift_transactions (
        shift_id, user_id, type, amount, notes, created_at
      ) VALUES (
        _shift_id, _owner, 'surplus', _variance, 
        'فائض صندوق عند الإقفال: ' || COALESCE(_variance_reason, ''), now()
      );
    ELSE
      INSERT INTO public.shift_transactions (
        shift_id, user_id, type, amount, notes, created_at
      ) VALUES (
        _shift_id, _owner, 'shortage', abs(_variance), 
        'عجز صندوق عند الإقفال: ' || COALESCE(_variance_reason, ''), now()
      );
    END IF;
  END IF;

  -- 5) إقفال الوردية وتحديث الرصيد الفعلي والمتوقع والحالة
  UPDATE public.cash_shifts
     SET closed_at = now(),
         expected_balance = _calc_expected,
         actual_balance = round(COALESCE(_actual_balance, 0), 2),
         variance = _variance,
         variance_reason = _variance_reason,
         reconciliation_status = _status,
         updated_at = now()
   WHERE id = _shift_id;

  RETURN jsonb_build_object(
    'success', true,
    'shift_id', _shift_id,
    'opening_balance', _shift.opening_balance,
    'expected_balance', _calc_expected,
    'actual_balance', _actual_balance,
    'variance', _variance,
    'status', _status
  );
END;
$function$
