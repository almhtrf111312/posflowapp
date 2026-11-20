-- تراجع الهجرتين 20261120031000 و 20261120032000
-- 1) عكس ربط التصنيفات:
DO $$ DECLARE _oid oid; _def text;
BEGIN
  SELECT oid INTO _oid FROM pg_proc WHERE proname='revert_invoice_partner_profits_atomic' AND pronamespace='public'::regnamespace;
  _def := replace(pg_get_functiondef(_oid), 'public._split_reversal_by_category(_revert_record, profit_history, _inv.invoice_number)', '_revert_record');
  EXECUTE _def;
END $$;
DROP FUNCTION IF EXISTS public._split_reversal_by_category(jsonb,jsonb,text);
-- 2) edit_purchase_invoice_atomic: النسخة السابقة كانت معطوبة (أعمدة غير موجودة)؛ لا يُنصح بالرجوع إليها.
