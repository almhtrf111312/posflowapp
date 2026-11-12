-- distribute_sale_profit_to_partners_atomic(_invoice_id text, _customer_name text, _is_debt boolean, _category_profits jsonb)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.distribute_sale_profit_to_partners_atomic(_invoice_id text, _customer_name text, _is_debt boolean, _category_profits jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _owner uuid;
  _cat_record record;
  _partner record;
  _cat_profit numeric;
  _cat_name text;
  _remaining numeric;
  _partner_share numeric;
  _dist_result jsonb := '[]'::jsonb;
  _profit_record jsonb;
  _category_share record;
  _has_matched boolean;
BEGIN
  IF _uid IS NULL THEN 
    RAISE EXCEPTION 'المستخدم غير مسجل'; 
  END IF;

  -- 1) جلب معرف المالك الحقيقي (حساب الكاشير أو المالك)
  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN 
    RAISE EXCEPTION 'لم يتم العثور على حساب المالك'; 
  END IF;

  IF _category_profits IS NULL OR jsonb_array_length(_category_profits) = 0 THEN
    RETURN jsonb_build_object('success', true, 'distributed_count', 0);
  END IF;

  -- 2) معالجة كل قسم وربحه
  FOR _cat_record IN SELECT * FROM jsonb_to_recordset(_category_profits) AS x(category text, profit numeric) LOOP
    _cat_name := COALESCE(_cat_record.category, 'عام');
    _cat_profit := round(COALESCE(_cat_record.profit, 0), 8);

    IF _cat_profit > 0 THEN
      _remaining := _cat_profit;

      -- أ) الشركاء المتخصصون في القسم (غير الشاملين)
      FOR _partner IN 
        SELECT * FROM public.partners 
        WHERE user_id = _owner AND access_all = false 
        FOR UPDATE 
      LOOP
        -- فحص نسبة الشريك في هذا القسم من مصفوفة category_shares
        SELECT (x->>'percentage')::numeric INTO _partner_share
        FROM jsonb_array_elements(COALESCE(_partner.category_shares, '[]'::jsonb)) AS x
        WHERE (x->>'enabled')::boolean = true AND (x->>'categoryName') = _cat_name
        LIMIT 1;

        IF _partner_share IS NOT NULL AND _partner_share > 0 THEN
          DECLARE
            _calc_share numeric := round((_cat_profit * _partner_share) / 100, 8);
          BEGIN
            _remaining := _remaining - _calc_share;

            _profit_record := jsonb_build_object(
              'id', gen_random_uuid()::text,
              'invoiceId', _invoice_id,
              'amount', _calc_share,
              'category', _cat_name,
              'isDebt', _is_debt,
              'createdAt', now()
            );

            IF _is_debt THEN
              UPDATE public.partners SET
                pending_profit = round(COALESCE(pending_profit, 0) + _calc_share, 8),
                profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
                pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || jsonb_build_object(
                  'invoiceId', _invoice_id, 'amount', _calc_share, 'customerName', _customer_name, 'createdAt', now()
                ),
                updated_at = now()
              WHERE id = _partner.id;
            ELSE
              UPDATE public.partners SET
                confirmed_profit = round(COALESCE(confirmed_profit, 0) + _calc_share, 8),
                current_balance = round(COALESCE(current_balance, 0) + _calc_share, 8),
                total_profit_earned = round(COALESCE(total_profit_earned, 0) + _calc_share, 8),
                profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
                updated_at = now()
              WHERE id = _partner.id;
            END IF;

            _dist_result := _dist_result || jsonb_build_object(
              'partnerId', _partner.id, 'partnerName', _partner.name, 'amount', _calc_share, 'category', _cat_name
            );
          END;
        END IF;
      END LOOP;

      -- ب) الشركاء الشاملون لجميع الأقسام (Access All)
      IF _remaining > 0 THEN
        FOR _partner IN 
          SELECT * FROM public.partners 
          WHERE user_id = _owner AND access_all = true AND COALESCE(share_percentage, 0) > 0
          FOR UPDATE 
        LOOP
          DECLARE
            _full_share numeric := round((_remaining * _partner.share_percentage) / 100, 8);
          BEGIN
            IF _full_share > 0 THEN
              _profit_record := jsonb_build_object(
                'id', gen_random_uuid()::text,
                'invoiceId', _invoice_id,
                'amount', _full_share,
                'category', _cat_name,
                'isDebt', _is_debt,
                'createdAt', now()
              );

              IF _is_debt THEN
                UPDATE public.partners SET
                  pending_profit = round(COALESCE(pending_profit, 0) + _full_share, 8),
                  profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
                  pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || jsonb_build_object(
                    'invoiceId', _invoice_id, 'amount', _full_share, 'customerName', _customer_name, 'createdAt', now()
                  ),
                  updated_at = now()
                WHERE id = _partner.id;
              ELSE
                UPDATE public.partners SET
                  confirmed_profit = round(COALESCE(confirmed_profit, 0) + _full_share, 8),
                  current_balance = round(COALESCE(current_balance, 0) + _full_share, 8),
                  total_profit_earned = round(COALESCE(total_profit_earned, 0) + _full_share, 8),
                  profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
                  updated_at = now()
                WHERE id = _partner.id;
              END IF;

              _dist_result := _dist_result || jsonb_build_object(
                'partnerId', _partner.id, 'partnerName', _partner.name, 'amount', _full_share, 'category', _cat_name
              );
            END IF;
          END;
        END LOOP;
      END IF;

    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', _invoice_id,
    'distributions', _dist_result
  );
END;
$function$
;
