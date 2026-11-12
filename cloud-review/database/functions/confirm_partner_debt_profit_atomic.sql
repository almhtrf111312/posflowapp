-- confirm_partner_debt_profit_atomic(_invoice_id text, _payment_ratio numeric)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.confirm_partner_debt_profit_atomic(_invoice_id text, _payment_ratio numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _owner uuid := public.get_owner_id(auth.uid());
  p record;
  _updated_details jsonb;
  _updated_history jsonb;
  _total_confirmed numeric := 0;
  _item jsonb;
  _item_amt numeric;
  _confirm_amt numeric;
BEGIN
  IF _owner IS NULL OR _payment_ratio <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_params');
  END IF;

  FOR p IN 
    SELECT * FROM public.partners 
    WHERE user_id = _owner 
      AND pending_profit > 0 
    FOR UPDATE 
  LOOP
    _updated_details := '[]'::jsonb;
    _total_confirmed := 0;

    -- مراجعة تفاصيل الأرباح المعلقة للفاتورة المسددة
    FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.pending_profit_details, '[]'::jsonb))
    LOOP
      IF (_item->>'invoiceId') = _invoice_id THEN
        _item_amt := (_item->>'amount')::numeric;
        _confirm_amt := round(_item_amt * LEAST(_payment_ratio, 1.0), 2);
        _total_confirmed := _total_confirmed + _confirm_amt;

        -- الاحتفاظ بالمتبقي إن وجد
        IF (_item_amt - _confirm_amt) > 0.01 THEN
          _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_item_amt - _confirm_amt, 2)));
        END IF;
      ELSE
        _updated_details := _updated_details || _item;
      END IF;
    END LOOP;

    -- إذا وجد ربح معلق لهذه الفاتورة، يُحرر فوراً إلى الرصيد المؤكد
    IF _total_confirmed > 0 THEN
      -- تحديث السجل التاريخي للأرباح
      _updated_history := '[]'::jsonb;
      FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb))
      LOOP
        IF (_item->>'invoiceId') = _invoice_id AND (_item->>'isDebt')::boolean = true THEN
          _updated_history := _updated_history || jsonb_set(_item, '{isDebt}', 'false'::jsonb);
        ELSE
          _updated_history := _updated_history || _item;
        END IF;
      END LOOP;

      UPDATE public.partners
      SET
        pending_profit = GREATEST(0, round(COALESCE(pending_profit, 0) - _total_confirmed, 2)),
        confirmed_profit = round(COALESCE(confirmed_profit, 0) + _total_confirmed, 2),
        current_balance = round(COALESCE(current_balance, 0) + _total_confirmed, 2),
        total_profit_earned = round(COALESCE(total_profit_earned, 0) + _total_confirmed, 2),
        pending_profit_details = _updated_details,
        profit_history = _updated_history,
        updated_at = now()
      WHERE id = p.id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'invoice_id', _invoice_id);
END;
$function$
;
