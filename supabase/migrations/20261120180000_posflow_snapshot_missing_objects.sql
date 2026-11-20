-- Idempotent snapshot of live-DB objects that were applied via MCP but missing from earlier migration files.
CREATE TABLE IF NOT EXISTS public.partner_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, partner_id uuid NOT NULL, entry_type text,
  d_current_balance numeric DEFAULT 0, d_pending_profit numeric DEFAULT 0, d_confirmed_profit numeric DEFAULT 0,
  d_total_profit_earned numeric DEFAULT 0, d_total_withdrawn numeric DEFAULT 0, d_current_capital numeric DEFAULT 0,
  source text, reference text, actor uuid, txid bigint DEFAULT txid_current(), created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_partner_ledger_partner ON public.partner_ledger_entries (partner_id, created_at);
ALTER TABLE public.partner_ledger_entries ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='partner_ledger_entries' AND policyname='partner_ledger_select') THEN
    CREATE POLICY partner_ledger_select ON public.partner_ledger_entries FOR SELECT USING (user_id = get_owner_id(auth.uid()) AND is_store_owner(auth.uid()));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public._partner_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN RAISE EXCEPTION 'سجل الشركاء غير قابل للتعديل أو الحذف'; END $f$;
DROP TRIGGER IF EXISTS trg_partner_ledger_immutable ON public.partner_ledger_entries;
CREATE TRIGGER trg_partner_ledger_immutable BEFORE DELETE OR UPDATE ON public.partner_ledger_entries FOR EACH ROW EXECUTE FUNCTION public._partner_ledger_immutable();

CREATE OR REPLACE FUNCTION public._partner_ledger_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE _src text := COALESCE(NULLIF(current_setting('app.partner_source', true),''), NULLIF(current_setting('app.stock_source', true),''), TG_OP);
        _ref text := NULLIF(current_setting('app.partner_ref', true),'');
        _type text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.partner_ledger_entries(user_id,partner_id,entry_type,d_current_balance,d_pending_profit,d_confirmed_profit,d_total_profit_earned,d_total_withdrawn,d_current_capital,source,reference,actor)
    VALUES (NEW.user_id,NEW.id,'opening',COALESCE(NEW.current_balance,0),COALESCE(NEW.pending_profit,0),COALESCE(NEW.confirmed_profit,0),COALESCE(NEW.total_profit_earned,0),COALESCE(NEW.total_withdrawn,0),COALESCE(NEW.current_capital,0),_src,_ref,auth.uid());
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.current_balance,0)=COALESCE(OLD.current_balance,0) AND COALESCE(NEW.pending_profit,0)=COALESCE(OLD.pending_profit,0)
     AND COALESCE(NEW.confirmed_profit,0)=COALESCE(OLD.confirmed_profit,0) AND COALESCE(NEW.total_profit_earned,0)=COALESCE(OLD.total_profit_earned,0)
     AND COALESCE(NEW.total_withdrawn,0)=COALESCE(OLD.total_withdrawn,0) AND COALESCE(NEW.current_capital,0)=COALESCE(OLD.current_capital,0) THEN
    RETURN NEW;
  END IF;
  _type := CASE
    WHEN COALESCE(NEW.total_withdrawn,0) > COALESCE(OLD.total_withdrawn,0) THEN 'withdrawal'
    WHEN COALESCE(NEW.current_capital,0) <> COALESCE(OLD.current_capital,0) THEN 'capital'
    WHEN COALESCE(NEW.pending_profit,0) <> COALESCE(OLD.pending_profit,0) AND COALESCE(NEW.confirmed_profit,0) = COALESCE(OLD.confirmed_profit,0) THEN 'pending_profit'
    WHEN COALESCE(NEW.confirmed_profit,0) > COALESCE(OLD.confirmed_profit,0) THEN 'profit'
    WHEN COALESCE(NEW.confirmed_profit,0) < COALESCE(OLD.confirmed_profit,0) OR COALESCE(NEW.total_profit_earned,0) < COALESCE(OLD.total_profit_earned,0) THEN 'reversal'
    ELSE 'adjustment' END;
  INSERT INTO public.partner_ledger_entries(user_id,partner_id,entry_type,d_current_balance,d_pending_profit,d_confirmed_profit,d_total_profit_earned,d_total_withdrawn,d_current_capital,source,reference,actor)
  VALUES (NEW.user_id,NEW.id,_type,
    COALESCE(NEW.current_balance,0)-COALESCE(OLD.current_balance,0), COALESCE(NEW.pending_profit,0)-COALESCE(OLD.pending_profit,0),
    COALESCE(NEW.confirmed_profit,0)-COALESCE(OLD.confirmed_profit,0), COALESCE(NEW.total_profit_earned,0)-COALESCE(OLD.total_profit_earned,0),
    COALESCE(NEW.total_withdrawn,0)-COALESCE(OLD.total_withdrawn,0), COALESCE(NEW.current_capital,0)-COALESCE(OLD.current_capital,0),
    _src,_ref,auth.uid());
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_partner_ledger_capture ON public.partners;
CREATE TRIGGER trg_partner_ledger_capture AFTER INSERT OR UPDATE ON public.partners FOR EACH ROW EXECUTE FUNCTION public._partner_ledger_capture();

CREATE OR REPLACE VIEW public.partner_ledger_reconciliation AS
 SELECT p.id AS partner_id, p.user_id, p.name, p.current_balance, COALESCE(sum(l.d_current_balance),0::numeric) AS ledger_balance,
    p.pending_profit, COALESCE(sum(l.d_pending_profit),0::numeric) AS ledger_pending,
    p.confirmed_profit, COALESCE(sum(l.d_confirmed_profit),0::numeric) AS ledger_confirmed,
    p.total_withdrawn, COALESCE(sum(l.d_total_withdrawn),0::numeric) AS ledger_withdrawn,
    (abs(COALESCE(p.current_balance,0::numeric)-COALESCE(sum(l.d_current_balance),0::numeric))>0.01 OR abs(COALESCE(p.pending_profit,0::numeric)-COALESCE(sum(l.d_pending_profit),0::numeric))>0.01
     OR abs(COALESCE(p.confirmed_profit,0::numeric)-COALESCE(sum(l.d_confirmed_profit),0::numeric))>0.01 OR abs(COALESCE(p.total_withdrawn,0::numeric)-COALESCE(sum(l.d_total_withdrawn),0::numeric))>0.01) AS mismatch
   FROM public.partners p LEFT JOIN public.partner_ledger_entries l ON l.partner_id = p.id GROUP BY p.id;

CREATE OR REPLACE FUNCTION public._split_reversal_by_category(_rec jsonb, _history jsonb, _invoice_number text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public' AS $f$
DECLARE _tot numeric := 0; _out jsonb := '[]'::jsonb; _x record; _w numeric; _n int := 0; _cnt int;
BEGIN
  SELECT COALESCE(SUM(ABS(COALESCE((x->>'amount')::numeric,0))),0), COUNT(DISTINCT COALESCE(NULLIF(x->>'category',''),'-')) INTO _tot, _cnt
    FROM jsonb_array_elements(COALESCE(_history,'[]'::jsonb)) x
   WHERE x->>'invoiceId' = _invoice_number AND COALESCE((x->>'isReversal')::boolean,false)=false AND COALESCE((x->>'isRelease')::boolean,false)=false
     AND COALESCE(x->>'id','') NOT LIKE '%-rel' AND COALESCE(x->>'category','') <> 'تحرير دفعة دين';
  IF _tot = 0 THEN RETURN jsonb_build_array(_rec); END IF;
  FOR _x IN
    SELECT COALESCE(NULLIF(x->>'category',''),'مرتجع فاتورة') cat, SUM(ABS(COALESCE((x->>'amount')::numeric,0))) amt
      FROM jsonb_array_elements(COALESCE(_history,'[]'::jsonb)) x
     WHERE x->>'invoiceId' = _invoice_number AND COALESCE((x->>'isReversal')::boolean,false)=false AND COALESCE((x->>'isRelease')::boolean,false)=false
       AND COALESCE(x->>'id','') NOT LIKE '%-rel' AND COALESCE(x->>'category','') <> 'تحرير دفعة دين' GROUP BY 1
  LOOP
    _w := _x.amt / _tot; _n := _n + 1;
    _out := _out || jsonb_build_array(_rec || jsonb_build_object('id', (_rec->>'id')||'-'||_n::text, 'category', _x.cat,
           'amount', round((_rec->>'amount')::numeric * _w, 8),
           'pendingReverted', round(COALESCE((_rec->>'pendingReverted')::numeric,0) * _w, 8),
           'confirmedReverted', round(COALESCE((_rec->>'confirmedReverted')::numeric,0) * _w, 8)));
  END LOOP;
  RETURN _out;
END $f$;

CREATE OR REPLACE FUNCTION public.record_shift_fx_atomic(_shift_id uuid, _from_ccy text, _from_amount numeric, _from_usd numeric, _to_ccy text, _to_amount numeric, _to_usd numeric, _operation_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE _c uuid := auth.uid(); _o uuid;
BEGIN
  IF _c IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _o := public.get_owner_id(_c);
  IF _o IS NULL THEN RAISE EXCEPTION 'Owner context is required'; END IF;
  IF COALESCE(length(_operation_id),0) < 8 THEN RAISE EXCEPTION 'معرّف العملية غير صالح'; END IF;
  IF COALESCE(_from_ccy,'') = '' OR COALESCE(_to_ccy,'') = '' OR upper(_from_ccy) = upper(_to_ccy) THEN RAISE EXCEPTION 'اختر عملتين مختلفتين'; END IF;
  IF COALESCE(_from_amount,0) <= 0 OR COALESCE(_to_amount,0) <= 0 OR COALESCE(_from_usd,0) <= 0 OR COALESCE(_to_usd,0) <= 0 THEN RAISE EXCEPTION 'المبالغ يجب أن تكون أكبر من الصفر'; END IF;
  PERFORM 1 FROM public.cash_shifts WHERE id=_shift_id AND user_id=_o AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'لا توجد وردية مفتوحة'; END IF;
  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'تحويل عملة في الوردية');
  INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,reference_id,notes,currency,currency_amount,exchange_rate)
  VALUES (_shift_id,_o,'fx_out',round(_from_usd,4),_operation_id,'تحويل عملة (خارج)',upper(_from_ccy),round(_from_amount,4),round(_from_amount/_from_usd,8))
  ON CONFLICT (shift_id,type,reference_id) DO NOTHING;
  INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,reference_id,notes,currency,currency_amount,exchange_rate)
  VALUES (_shift_id,_o,'fx_in',round(_to_usd,4),_operation_id,'تحويل عملة (داخل)',upper(_to_ccy),round(_to_amount,4),round(_to_amount/_to_usd,8))
  ON CONFLICT (shift_id,type,reference_id) DO NOTHING;
END $f$;

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS payment_method text DEFAULT 'cash';
CREATE OR REPLACE FUNCTION public.mark_invoice_digital(_invoice_number text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE _n int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  UPDATE public.invoices SET payment_method = 'digital' WHERE invoice_number = _invoice_number AND user_id = auth.uid() AND payment_method <> 'digital';
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n > 0;
END $f$;
-- NOTE: close_cash_shift_atomic (stored-rate version) lives in the live DB; its full body is recorded in 20261120120000 comments and in pg_proc.
