-- =========================================================================
-- Migration: 20261104235000_wac_and_close_shift_atomic.sql
-- Description:
-- 1) receive_stock_wac: Atomic server-side high-precision WAC calculation (8 decimals)
--    and stock increment with stock movement logging.
-- 2) Multi-currency support for shift_transactions (currency, currency_amount, exchange_rate)
-- 3) Expanded shift_transactions_type_check to include surplus & shortage
-- 4) close_cash_shift_atomic: Atomic server-side cash shift close, variance calculation,
--    and auto-reconciliation via surplus/shortage shift transactions.
-- =========================================================================

-- ========================================================
-- 1) دالة استلام المخزون وحساب متوسط التكلفة المرجح WAC بدقة عالية
-- ========================================================
CREATE OR REPLACE FUNCTION public.receive_stock_wac(
  _product_id uuid, 
  _quantity numeric, 
  _unit_cost numeric, 
  _reference text DEFAULT NULL::text
)
RETURNS TABLE(new_quantity numeric, new_cost numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE 
  _caller uuid := auth.uid(); 
  _owner uuid; 
  _cur_qty numeric; 
  _cur_cost numeric; 
  _pos_qty numeric; 
  _calc_cost numeric;
BEGIN
  IF _caller IS NULL THEN 
    RAISE EXCEPTION 'المستخدم غير مسجل'; 
  END IF;
  
  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'حساب المالك غير موجود';
  END IF;

  IF COALESCE(_quantity, 0) <= 0 OR COALESCE(_unit_cost, -1) < 0 THEN 
    RAISE EXCEPTION 'قيم الكمية والتكلفة غير صالحة'; 
  END IF;

  -- جلب بيانات المخزون والتكلفة الحالية مع القفل
  SELECT COALESCE(p.quantity, 0), COALESCE(p.cost_price, 0) 
    INTO _cur_qty, _cur_cost 
    FROM public.products p
   WHERE p.id = _product_id AND p.user_id = _owner 
     FOR UPDATE;

  IF NOT FOUND THEN 
    RAISE EXCEPTION 'المنتج غير موجود'; 
  END IF;

  _pos_qty := GREATEST(_cur_qty, 0);

  -- معادلة WAC الدقيقة
  IF _pos_qty = 0 THEN
    _calc_cost := _unit_cost;
  ELSIF _unit_cost = 0 THEN 
    _calc_cost := _cur_cost;
  ELSE 
    _calc_cost := round(((_pos_qty * _cur_cost) + (_quantity * _unit_cost)) / (_pos_qty + _quantity), 8);
  END IF;

  -- تحديث المنتج بالكمية الجديدة والتكلفة المرجحة
  UPDATE public.products 
     SET quantity = _cur_qty + _quantity, 
         cost_price = _calc_cost, 
         updated_at = now() 
   WHERE id = _product_id;

  -- توثيق حركة المخزون في السجل
  BEGIN
    INSERT INTO public.stock_movements (
      user_id, product_id, movement_type, quantity, reference_id, notes, created_at
    ) VALUES (
      _owner, _product_id, 'purchase', _quantity, 
      _reference, 'استلام بضاعة WAC: ' || COALESCE(_reference, ''), now()
    );
  EXCEPTION WHEN undefined_table THEN
    NULL;
  END;

  RETURN QUERY SELECT (_cur_qty + _quantity), _calc_cost;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.receive_stock_wac(uuid, numeric, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_stock_wac(uuid, numeric, numeric, text) TO service_role;

-- ========================================================
-- 2) إضافة أعمدة العملات لجدول حركات الوردية لدعم تعدد العملات
-- ========================================================
ALTER TABLE public.shift_transactions 
  ADD COLUMN IF NOT EXISTS currency text DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS currency_amount numeric,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric DEFAULT 1;

-- ========================================================
-- 3) توسيع أنواع حركات الوردية المسموحة لتشمل التسويات
-- ========================================================
ALTER TABLE public.shift_transactions 
  DROP CONSTRAINT IF EXISTS shift_transactions_type_check;

ALTER TABLE public.shift_transactions 
  ADD CONSTRAINT shift_transactions_type_check 
  CHECK (type = ANY (ARRAY[
    'sale', 'deposit_capital', 'deposit_revenue', 'deposit_purchase_cover', 
    'debt_payment', 'expense', 'refund', 'writeoff', 'withdrawal',
    'surplus', 'shortage'
  ]));

-- ========================================================
-- 4) دالة إقفال الوردية وتسوية الفروقات ذرياً على الخادم
-- ========================================================
CREATE OR REPLACE FUNCTION public.close_cash_shift_atomic(
  _shift_id uuid,
  _actual_balance numeric,
  _variance_reason text DEFAULT NULL
)
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
     AND type IN ('sale', 'deposit_capital', 'deposit_revenue', 'deposit_purchase_cover', 'debt_payment', 'surplus');

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
$function$;

GRANT EXECUTE ON FUNCTION public.close_cash_shift_atomic(uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_cash_shift_atomic(uuid, numeric, text) TO service_role;
