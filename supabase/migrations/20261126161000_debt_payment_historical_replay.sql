-- Preserve the deployed payment body and its permissions. Only replace the legacy
-- receipt comparison used when there is no original settlement request to read.
DO $patch$
DECLARE
  target regprocedure := 'public.record_debt_payment_atomic(uuid,numeric,text,uuid,text,numeric,numeric,text)'::regprocedure;
  body text := replace(pg_get_functiondef(target), chr(13) || chr(10), chr(10));
  original_amount text := $old$v_legacy_currency_amount := CASE WHEN v_existing_payment.currency = 'USD' THEN v_existing_payment.amount
      ELSE v_existing_payment.currency_amount END;$old$;
  saved_amount text := $new$v_legacy_currency_amount := COALESCE(v_existing_payment.currency_amount,
      CASE WHEN v_existing_payment.currency = 'USD' THEN v_existing_payment.amount END);$new$;
  original_check text := $old$OR v_existing_payment.settled_amount IS DISTINCT FROM v_credit
       OR v_legacy_currency_amount IS NULL
       OR v_legacy_currency_amount IS DISTINCT FROM COALESCE(round(_currency_amount, 4),
          round(v_cash_amount * v_existing_payment.exchange_rate, 4))$old$;
  receipt_check text := $new$OR (v_existing_payment.settled_amount - COALESCE(v_existing_payment.rounding_adjustment, 0)) IS DISTINCT FROM v_credit
       OR v_existing_payment.fx_credit_rate IS DISTINCT FROM v_fx_credit_rate
       OR v_legacy_currency_amount IS NULL
       OR v_legacy_currency_amount IS DISTINCT FROM COALESCE(round(_currency_amount, 8),
          round(v_cash_amount * v_existing_payment.exchange_rate, 8))$new$;
BEGIN
  IF strpos(body, receipt_check) > 0 AND strpos(body, saved_amount) > 0 THEN RETURN; END IF;
  IF strpos(body, original_amount) = 0 OR strpos(body, original_check) = 0 THEN
    RAISE EXCEPTION 'record_debt_payment_atomic: historical receipt comparison differs from expected definition';
  END IF;
  EXECUTE replace(replace(body, original_amount, saved_amount), original_check, receipt_check);
END
$patch$;
