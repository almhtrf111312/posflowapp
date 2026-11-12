-- ============================================================================
-- المرحلة 2 من خطة إصلاح المنظومة الحسابية: تعريف الربح الموحّد
-- ----------------------------------------------------------------------------
-- يُطبَّق يدوياً من محرر SQL في Supabase بعد موافقة المالك.
-- ملف الرجوع: supabase/live-snapshots/2026-11-11/ROLLBACK_phase2.sql
--
-- التعريف المعتمد (نفسه في التطبيق: src/lib/profit-engine.ts):
--   المبيعات          = إجمالي الفواتير بدون الضريبة (نقدي وآجل) في يوم البيع.
--   الربح المحقق      = النقدي كاملاً يوم البيع؛ والآجل = ربح الفاتورة × (المدفوع ÷ الإجمالي)
--                       في يوم كل دفعة. ما دُفع بلا سجل مؤرخ يُعدّ مدفوعاً يوم البيع.
--   الربح المعلّق     = ربح الفاتورة × (المتبقي ÷ الإجمالي) لكل دين مفتوح، ولا يدخل في الصافي.
--   خسارة الدين المعدوم = المبلغ المعدوم − ربحه المعلّق، في يوم الإعدام.
--   صافي الربح        = الربح المحقق − المصاريف − خسارة الديون المعدومة.
--
-- ما يفعله هذا الملف:
--   1) عمود invoices.paid_at_sale (المدفوع لحظة البيع) يُملأ تلقائياً للفواتير الجديدة،
--      ويُعبَّأ للفواتير الآجلة السابقة = المدفوع الذي لا يقابله سجل دفعة مؤرخ.
--   2) أعمدة توثيق الخسارة في debt_writeoffs.
--   3) writeoff_debt_atomic: تحسب خسارة الدين المعدوم وتحمّلها للشركاء بنسبهم
--      (شريك الصنف أولاً ثم الباقي على الشركاء العامين، والباقي على المالك) وتوثّقها.
--   4) close_accounting_period_atomic: تحسب الإقفال بالتعريف الموحّد وتخزّن
--      الربح المحقق والمعلّق وخسارة الديون المعدومة. الإقفالات السابقة لا تُعدَّل.
--
-- لا يغيّر أرصدة أي شريك عند التطبيق، ولا يعدّل أي إقفال أو شطب سابق سوى تعبئة
-- عمودي التوثيق الجديدين (loss_amount / pending_profit_cancelled) للشطوبات القديمة.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) المدفوع لحظة البيع
-- ---------------------------------------------------------------------------
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS paid_at_sale numeric;

COMMENT ON COLUMN public.invoices.paid_at_sale IS
  'المبلغ المحصَّل لحظة البيع (USD). الفاتورة النقدية = الإجمالي، والآجلة = الدفعة الأولى. NULL = فاتورة نقدية قديمة لم يُسجَّل لها.';

CREATE OR REPLACE FUNCTION public.set_invoice_paid_at_sale()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.paid_at_sale IS NULL THEN
    NEW.paid_at_sale := CASE
      WHEN NEW.payment_type = 'debt'
        THEN LEAST(GREATEST(COALESCE(NEW.debt_paid, 0), 0), COALESCE(NEW.total, 0))
      ELSE COALESCE(NEW.total, 0)
    END;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS c_set_invoice_paid_at_sale ON public.invoices;
CREATE TRIGGER c_set_invoice_paid_at_sale
  BEFORE INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_invoice_paid_at_sale();

-- تعبئة الفواتير الآجلة السابقة فقط: المدفوع الذي لا يقابله سجل دفعة مؤرخ يُعدّ مدفوعاً يوم البيع
UPDATE public.invoices i
   SET paid_at_sale = GREATEST(
         (CASE WHEN i.status = 'paid' THEN COALESCE(i.total, 0)
               ELSE LEAST(GREATEST(COALESCE(i.debt_paid, 0), 0), COALESCE(i.total, 0)) END)
         - LEAST(
             COALESCE((
               SELECT SUM(dp.amount)
                 FROM public.debts d
                 JOIN public.debt_payments dp ON dp.debt_id = d.id
                WHERE d.user_id = i.user_id
                  AND NOT COALESCE(d.is_cash_debt, false)
                  AND (d.invoice_id = i.invoice_number OR d.invoice_id = i.id::text)
                  AND COALESCE(dp.amount, 0) > 0
             ), 0),
             (CASE WHEN i.status = 'paid' THEN COALESCE(i.total, 0)
                   ELSE LEAST(GREATEST(COALESCE(i.debt_paid, 0), 0), COALESCE(i.total, 0)) END)
           ),
         0)
 WHERE i.payment_type = 'debt'
   AND i.paid_at_sale IS NULL;

-- ---------------------------------------------------------------------------
-- 2) توثيق خسارة الدين المعدوم
-- ---------------------------------------------------------------------------
ALTER TABLE public.debt_writeoffs
  ADD COLUMN IF NOT EXISTS loss_amount numeric,
  ADD COLUMN IF NOT EXISTS pending_profit_cancelled numeric;

COMMENT ON COLUMN public.debt_writeoffs.loss_amount IS
  'خسارة الدين المعدوم = المبلغ المعدوم − ربحه المعلّق الملغى (USD).';
COMMENT ON COLUMN public.debt_writeoffs.pending_profit_cancelled IS
  'الربح المعلّق الذي أُلغي بالإعدام (ليس خسارة) (USD).';

-- الشطوبات السابقة: تعبئة عمودي التوثيق فقط (لا تحميل للشركاء بأثر رجعي)
UPDATE public.debt_writeoffs w
   SET pending_profit_cancelled = COALESCE(x.cancelled, 0),
       loss_amount = COALESCE(w.amount, 0) - COALESCE(x.cancelled, 0)
  FROM public.debt_writeoffs w2
  LEFT JOIN public.debts d ON d.id = w2.debt_id
  LEFT JOIN LATERAL (
    SELECT round(COALESCE(i.profit, 0) * LEAST(COALESCE(w2.amount, 0), i.total) / i.total, 8) AS cancelled
      FROM public.invoices i
     WHERE i.user_id = w2.user_id
       AND NOT COALESCE(d.is_cash_debt, false)
       AND COALESCE(d.invoice_id, w2.notes) IS NOT NULL
       AND (i.invoice_number = COALESCE(d.invoice_id, w2.notes) OR i.id::text = COALESCE(d.invoice_id, w2.notes))
       AND COALESCE(i.total, 0) > 0
     ORDER BY i.created_at
     LIMIT 1
  ) x ON true
 WHERE w2.id = w.id
   AND w.loss_amount IS NULL;

-- ---------------------------------------------------------------------------
-- 3) شطب الدين: حساب الخسارة وتحميلها للشركاء بنسبهم
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.writeoff_debt_atomic(_debt_id uuid, _reason text, _operation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _debt public.debts%ROWTYPE;
  _partner record;
  _clean_details jsonb;
  _item jsonb;
  -- المرحلة 2: خسارة الدين المعدوم
  _inv_id uuid;
  _inv_total numeric := 0;
  _inv_profit numeric := 0;
  _has_inv boolean := false;
  _amount numeric := 0;
  _pending_cancelled numeric := 0;
  _loss numeric := 0;
  _total_cost numeric := 0;
  _cat record;
  _cat_loss numeric;
  _remaining_loss numeric;
  _cat_share jsonb;
  _part numeric;
  _impact jsonb := '[]'::jsonb;
  _partners_total numeric := 0;
  _wo_key text;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  -- المرحلة 1: شطب الدين لمالك المتجر فقط
  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'شطب الدين مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  IF _operation_id IS NULL OR length(_operation_id) < 8 THEN
    RAISE EXCEPTION 'معرف العملية غير صالح';
  END IF;

  -- قفل سجل الدين
  SELECT * INTO _debt
    FROM public.debts
   WHERE id = _debt_id AND user_id = _owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'الدين غير موجود أو لا يتبع لهذا المتجر';
  END IF;

  -- الحماية من التكرار
  IF _debt.status = 'written_off' THEN
    RETURN jsonb_build_object('success', true, 'already_written_off', true, 'debt_id', _debt_id);
  END IF;

  -- المرحلة 2: المبلغ المعدوم وربحه المعلّق والخسارة الصافية
  _amount := round(GREATEST(COALESCE(_debt.remaining_debt, 0), 0), 8);
  _wo_key := 'WO-' || COALESCE(_debt.invoice_id, _debt_id::text);

  IF _debt.invoice_id IS NOT NULL AND NOT COALESCE(_debt.is_cash_debt, false) THEN
    SELECT i.id, COALESCE(i.total, 0), COALESCE(i.profit, 0)
      INTO _inv_id, _inv_total, _inv_profit
      FROM public.invoices i
     WHERE i.user_id = _owner
       AND (i.invoice_number = _debt.invoice_id OR i.id::text = _debt.invoice_id)
     ORDER BY i.created_at
     LIMIT 1;
    _has_inv := FOUND;
  END IF;

  IF _has_inv AND _inv_total > 0 THEN
    _pending_cancelled := round(_inv_profit * LEAST(_amount, _inv_total) / _inv_total, 8);
  END IF;
  _loss := round(_amount - _pending_cancelled, 8);

  -- المرحلة 1: علامة داخلية يتحقق منها حارس جدول الديون
  PERFORM set_config('app.debt_writeoff_internal', '1', true);

  -- 1) تعديل حالة الدين إلى مشطوب وتوثيق السبب
  UPDATE public.debts
     SET status = 'written_off',
         notes = concat_ws(E'\n', notes, '[شطب دين]: ' || COALESCE(_reason, 'شطب إداري')),
         updated_at = now()
   WHERE id = _debt_id;

  -- 2) تعديل الفاتورة المرتبطة إن وجدت
  IF _debt.invoice_id IS NOT NULL AND NOT COALESCE(_debt.is_cash_debt, false) THEN
    UPDATE public.invoices
       SET status = 'written_off',
           notes = concat_ws(E'\n', notes, '[دين مشطوب]: ' || COALESCE(_reason, '')),
           updated_at = now()
     WHERE user_id = _owner
       AND (invoice_number = _debt.invoice_id OR id::text = _debt.invoice_id);
  END IF;

  -- 3) خصم رصيد الدين المشطوب من إجمالي ديون العميل
  IF _debt.customer_name IS NOT NULL THEN
    UPDATE public.customers
       SET total_debt = GREATEST(COALESCE(total_debt, 0) - COALESCE(_debt.remaining_debt, 0), 0),
           updated_at = now()
     WHERE user_id = _owner
       AND (name = _debt.customer_name OR (phone IS NOT NULL AND phone = _debt.customer_phone));
  END IF;

  -- 4) تصفير وحذف الأرباح المعلقة المرتبطة بالفاتورة لدى جميع الشركاء (تُلغى ولا تُحسب خسارة)
  IF _debt.invoice_id IS NOT NULL THEN
    FOR _partner IN
      SELECT * FROM public.partners
       WHERE user_id = _owner
         AND pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', _debt.invoice_id))
       FOR UPDATE
    LOOP
      _clean_details := '[]'::jsonb;

      FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb))
      LOOP
        -- استبعاد أرباح الفاتورة المشطوبة
        IF (_item->>'invoiceId') <> _debt.invoice_id THEN
          _clean_details := _clean_details || _item;
        END IF;
      END LOOP;

      UPDATE public.partners
         SET pending_profit_details = _clean_details,
             pending_profit = (
               SELECT COALESCE(SUM((x->>'amount')::numeric), 0)
                 FROM jsonb_array_elements(_clean_details) AS x
             ),
             updated_at = now()
       WHERE id = _partner.id;
    END LOOP;
  END IF;

  -- 5) المرحلة 2: تحميل خسارة الدين المعدوم للشركاء بنسبهم
  --    الخسارة تُقسَّم على الأصناف بنسبة تكلفة كل صنف في الفاتورة؛ شريك الصنف يتحمل
  --    نسبته من خسارة صنفه، ثم يتحمل الشركاء العامون نسبهم من الباقي، والباقي على المالك.
  IF _loss > 0 THEN
    IF _has_inv THEN
      SELECT COALESCE(SUM(COALESCE(ii.cost_price, 0) * COALESCE(ii.quantity, 0)), 0)
        INTO _total_cost
        FROM public.invoice_items ii
       WHERE ii.invoice_id = _inv_id;
    END IF;

    FOR _cat IN
      SELECT c.category_name, c.cat_cost
        FROM (
          SELECT COALESCE(NULLIF(trim(p.category), ''), 'عام') AS category_name,
                 SUM(COALESCE(ii.cost_price, 0) * COALESCE(ii.quantity, 0)) AS cat_cost
            FROM public.invoice_items ii
            LEFT JOIN public.products p ON p.id = ii.product_id AND p.user_id = _owner
           WHERE _has_inv AND _total_cost > 0 AND ii.invoice_id = _inv_id
           GROUP BY COALESCE(NULLIF(trim(p.category), ''), 'عام')
          HAVING SUM(COALESCE(ii.cost_price, 0) * COALESCE(ii.quantity, 0)) > 0
          UNION ALL
          -- دين نقدي بلا فاتورة أو فاتورة بلا تكلفة: الخسارة كلها في خانة واحدة
          SELECT 'عام'::text, 1::numeric WHERE NOT (_has_inv AND _total_cost > 0)
        ) c
    LOOP
      _cat_loss := CASE WHEN _has_inv AND _total_cost > 0
                        THEN round(_loss * _cat.cat_cost / _total_cost, 8)
                        ELSE _loss END;
      _remaining_loss := _cat_loss;

      -- أ) شركاء هذا الصنف بعينه (فقط حين توجد فاتورة)
      IF _has_inv THEN
        FOR _partner IN
          SELECT * FROM public.partners
           WHERE user_id = _owner
             AND COALESCE(access_all, false) = false
             AND category_shares IS NOT NULL
           FOR UPDATE
        LOOP
          SELECT cs INTO _cat_share
            FROM jsonb_array_elements(_partner.category_shares) cs
           WHERE (cs->>'enabled')::boolean = true
             AND cs->>'categoryName' = _cat.category_name
           LIMIT 1;

          IF _cat_share IS NOT NULL AND COALESCE((_cat_share->>'percentage')::numeric, 0) > 0 THEN
            _part := round(_cat_loss * (_cat_share->>'percentage')::numeric / 100.0, 4);
            IF _part > 0 THEN
              _remaining_loss := _remaining_loss - _part;
              _partners_total := _partners_total + _part;

              UPDATE public.partners SET
                confirmed_profit = round(COALESCE(confirmed_profit, 0) - _part, 4),
                current_balance = round(COALESCE(current_balance, 0) - _part, 4),
                total_profit_earned = round(COALESCE(total_profit_earned, 0) - _part, 4),
                profit_history = COALESCE(profit_history, '[]'::jsonb) || jsonb_build_object(
                  'id', 'wo-' || _debt_id::text || '-' || _partner.id::text || '-' || _cat.category_name,
                  'invoiceId', _wo_key,
                  'amount', -_part,
                  'category', 'خسارة دين معدوم',
                  'isDebt', false,
                  'isWriteoff', true,
                  'createdAt', now()
                ),
                updated_at = now()
              WHERE id = _partner.id;

              _impact := _impact || jsonb_build_object(
                'partnerId', _partner.id,
                'partnerName', _partner.name,
                'amount', _part,
                'category', _cat.category_name
              );
            END IF;
          END IF;
        END LOOP;
      END IF;

      -- ب) الشركاء العامون على ما تبقى من خسارة الصنف
      IF _remaining_loss > 0 THEN
        FOR _partner IN
          SELECT * FROM public.partners
           WHERE user_id = _owner
             AND COALESCE(access_all, false) = true
             AND COALESCE(share_percentage, 0) > 0
           FOR UPDATE
        LOOP
          _part := round(_remaining_loss * _partner.share_percentage / 100.0, 4);
          IF _part > 0 THEN
            _partners_total := _partners_total + _part;

            UPDATE public.partners SET
              confirmed_profit = round(COALESCE(confirmed_profit, 0) - _part, 4),
              current_balance = round(COALESCE(current_balance, 0) - _part, 4),
              total_profit_earned = round(COALESCE(total_profit_earned, 0) - _part, 4),
              profit_history = COALESCE(profit_history, '[]'::jsonb) || jsonb_build_object(
                'id', 'wo-' || _debt_id::text || '-' || _partner.id::text || '-' || _cat.category_name,
                'invoiceId', _wo_key,
                'amount', -_part,
                'category', 'خسارة دين معدوم',
                'isDebt', false,
                'isWriteoff', true,
                'createdAt', now()
              ),
              updated_at = now()
            WHERE id = _partner.id;

            _impact := _impact || jsonb_build_object(
              'partnerId', _partner.id,
              'partnerName', _partner.name,
              'amount', _part,
              'category', _cat.category_name
            );
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  -- 6) توثيق الشطب: المبلغ، الربح المعلّق الملغى، الخسارة، وحصة كل شريك وحصة المالك.
  --    السجل إلزامي: إذا تعذّر حفظه يُلغى الشطب كله حتى لا تبقى خسارة بلا توثيق.
  INSERT INTO public.debt_writeoffs(
    user_id, debt_id, customer_name, amount, reason, written_off_at, written_off_by, notes,
    loss_amount, pending_profit_cancelled, partner_impact, capital_impact
  ) VALUES (
    _owner, _debt_id, _debt.customer_name, _amount, COALESCE(_reason, 'شطب إداري'), now(), _caller, _debt.invoice_id,
    _loss, _pending_cancelled, _impact, round(_loss - _partners_total, 8)
  );

  RETURN jsonb_build_object(
    'success', true,
    'debt_id', _debt_id,
    'written_off_amount', _amount,
    'pending_profit_cancelled', _pending_cancelled,
    'loss_amount', _loss,
    'partners_loss', _partners_total,
    'owner_loss', round(_loss - _partners_total, 8),
    'partner_impact', _impact,
    'status', 'written_off'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.writeoff_debt_atomic(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.writeoff_debt_atomic(uuid, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) إقفال الفترة بالتعريف الموحّد
-- ---------------------------------------------------------------------------
ALTER TABLE public.accounting_period_closures
  ADD COLUMN IF NOT EXISTS realized_profit numeric,
  ADD COLUMN IF NOT EXISTS pending_profit numeric,
  ADD COLUMN IF NOT EXISTS bad_debt_loss numeric,
  ADD COLUMN IF NOT EXISTS closing_timezone text;

COMMENT ON COLUMN public.accounting_period_closures.realized_profit IS
  'الربح المحقق في الفترة (نقدي + ما حُصّل من الآجل في يوم تحصيله).';
COMMENT ON COLUMN public.accounting_period_closures.pending_profit IS
  'الربح المعلّق على الديون المفتوحة لحظة الإقفال (لا يدخل في الصافي).';
COMMENT ON COLUMN public.accounting_period_closures.bad_debt_loss IS
  'خسارة الديون المعدومة في الفترة = المبلغ المعدوم − ربحه المعلّق.';
COMMENT ON COLUMN public.accounting_period_closures.net_profit IS
  'من المرحلة 2: الربح المحقق − المصاريف − خسارة الديون المعدومة. الإقفالات الأقدم: مجمل الربح − (المصاريف + المبالغ المعدومة).';

-- التوقيع الجديد يضيف المنطقة الزمنية حتى تطابق أيام الإقفال ما يراه المالك في التطبيق
DROP FUNCTION IF EXISTS public.close_accounting_period_atomic(date, date);

CREATE OR REPLACE FUNCTION public.close_accounting_period_atomic(
  _period_start date,
  _period_end date,
  _timezone text DEFAULT 'UTC'
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _tz text := COALESCE(NULLIF(trim(_timezone), ''), 'UTC');
  _rev numeric := 0;
  _cogs numeric := 0;
  _exp numeric := 0;
  _gross numeric := 0;
  _realized numeric := 0;
  _pending numeric := 0;
  _bad_debt numeric := 0;
  _net numeric := 0;
  _partner_summary jsonb := '[]'::jsonb;
  _closure_id uuid;
  p record;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  -- المرحلة 1: إقفال الفترة لمالك المتجر فقط، بتواريخ صحيحة، ودون تداخل مع إقفال سابق
  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'إقفال الفترة مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  BEGIN
    PERFORM now() AT TIME ZONE _tz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'المنطقة الزمنية غير صحيحة: %', _tz;
  END;

  IF _period_start IS NULL OR _period_end IS NULL OR _period_start > _period_end THEN
    RAISE EXCEPTION 'تواريخ الفترة غير صحيحة';
  END IF;

  IF _period_end > (now() AT TIME ZONE _tz)::date THEN
    RAISE EXCEPTION 'لا يمكن إقفال فترة لم تنتهِ بعد';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.accounting_period_closures c
    WHERE c.user_id = _owner
      AND c.period_start <= _period_end
      AND c.period_end >= _period_start
  ) THEN
    RAISE EXCEPTION 'هذه الفترة تتداخل مع فترة مقفلة سابقاً';
  END IF;

  -- 1) المبيعات والربح المحقق والمعلّق بالتعريف الموحّد
  WITH inv AS (
    SELECT i.id, i.invoice_number,
           (i.created_at AT TIME ZONE _tz)::date AS sale_day,
           COALESCE(i.total, 0) AS total,
           COALESCE(i.tax_amount, 0) AS tax,
           COALESCE(i.profit, 0) AS profit,
           i.payment_type, i.status,
           CASE WHEN i.status = 'paid' THEN COALESCE(i.total, 0)
                ELSE LEAST(GREATEST(COALESCE(i.debt_paid, 0), 0), COALESCE(i.total, 0)) END AS paid_by_invoice
      FROM public.invoices i
     WHERE i.user_id = _owner
       AND i.status NOT IN ('refunded', 'cancelled')
       AND COALESCE(i.invoice_type, 'sale') IN ('sale', 'maintenance')
  ),
  credit AS (
    SELECT * FROM inv WHERE payment_type = 'debt' AND total > 0
  ),
  pay AS (
    SELECT c.id AS invoice_id,
           dp.amount,
           (dp.created_at AT TIME ZONE _tz)::date AS pay_day,
           SUM(dp.amount) OVER (PARTITION BY c.id ORDER BY dp.created_at, dp.id) - dp.amount AS paid_before
      FROM credit c
      JOIN public.debts d
        ON d.user_id = _owner
       AND NOT COALESCE(d.is_cash_debt, false)
       AND (d.invoice_id = c.invoice_number OR d.invoice_id = c.id::text)
      JOIN public.debt_payments dp ON dp.debt_id = d.id
     WHERE COALESCE(dp.amount, 0) > 0
  ),
  credit_paid AS (
    SELECT c.*,
           GREATEST(c.paid_by_invoice, LEAST(c.total, COALESCE(ds.dated_sum, 0))) AS paid_total,
           COALESCE(ds.dated_sum, 0) AS dated_sum,
           (c.status = 'written_off' OR EXISTS (
              SELECT 1 FROM public.debt_writeoffs w
               LEFT JOIN public.debts wd ON wd.id = w.debt_id
              WHERE w.user_id = _owner
                AND COALESCE(wd.invoice_id, w.notes) IN (c.invoice_number, c.id::text)
                AND NOT COALESCE(wd.is_cash_debt, false)
           )) AS is_written_off
      FROM credit c
      LEFT JOIN (SELECT invoice_id, SUM(amount) AS dated_sum FROM pay GROUP BY invoice_id) ds
        ON ds.invoice_id = c.id
  ),
  alloc AS (
    -- الدفعات المؤرخة تُحتسب بالترتيب ولا تتجاوز ما حُصّل فعلاً
    SELECT pm.pay_day,
           GREATEST(0, LEAST(pm.amount, cp.paid_total - pm.paid_before)) AS amount,
           cp.profit, cp.total
      FROM pay pm
      JOIN credit_paid cp ON cp.id = pm.invoice_id
  )
  SELECT
    COALESCE((SELECT SUM(total - tax) FROM inv
               WHERE sale_day BETWEEN _period_start AND _period_end), 0),
    COALESCE((SELECT SUM(profit) FROM inv
               WHERE NOT (payment_type IS NOT DISTINCT FROM 'debt' AND total > 0)
                 AND sale_day BETWEEN _period_start AND _period_end), 0)
    + COALESCE((SELECT SUM(profit * (paid_total - LEAST(dated_sum, paid_total)) / total) FROM credit_paid
                 WHERE sale_day BETWEEN _period_start AND _period_end), 0)
    + COALESCE((SELECT SUM(profit * amount / total) FROM alloc
                 WHERE pay_day BETWEEN _period_start AND _period_end), 0),
    COALESCE((SELECT SUM(profit * (total - paid_total) / total) FROM credit_paid
               WHERE NOT is_written_off AND sale_day <= _period_end), 0)
    INTO _rev, _realized, _pending;

  -- 2) تكلفة البضاعة المباعة (للعرض: مجمل الربح = المبيعات − التكلفة)
  SELECT
    COALESCE(SUM(COALESCE(ii.cost_price, 0) * COALESCE(ii.quantity, 0)), 0)
    INTO _cogs
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE i.user_id = _owner
     AND i.status NOT IN ('refunded', 'cancelled')
     AND COALESCE(i.invoice_type, 'sale') IN ('sale', 'maintenance')
     AND (i.created_at AT TIME ZONE _tz)::date BETWEEN _period_start AND _period_end;

  -- 3) المصاريف التشغيلية للفترة (بدون الديون المعدومة: لها سطر مستقل)
  SELECT COALESCE(SUM(amount), 0) INTO _exp
    FROM public.expenses
   WHERE user_id = _owner
     AND COALESCE(is_reversed, false) = false
     AND date BETWEEN _period_start AND _period_end;

  -- 4) خسارة الديون المعدومة في الفترة = المبلغ المعدوم − ربحه المعلّق
  SELECT COALESCE(SUM(
           COALESCE(
             w.loss_amount,
             CASE WHEN x.total > 0
                  THEN COALESCE(w.amount, 0) - x.profit * LEAST(COALESCE(w.amount, 0), x.total) / x.total
                  ELSE COALESCE(w.amount, 0) END
           )), 0)
    INTO _bad_debt
    FROM public.debt_writeoffs w
    LEFT JOIN public.debts d ON d.id = w.debt_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(i.total, 0) AS total, COALESCE(i.profit, 0) AS profit, i.status
        FROM public.invoices i
       WHERE i.user_id = _owner
         AND NOT COALESCE(d.is_cash_debt, false)
         AND COALESCE(d.invoice_id, w.notes) IS NOT NULL
         AND (i.invoice_number = COALESCE(d.invoice_id, w.notes) OR i.id::text = COALESCE(d.invoice_id, w.notes))
       ORDER BY i.created_at
       LIMIT 1
    ) x ON true
   WHERE w.user_id = _owner
     AND (w.written_off_at AT TIME ZONE _tz)::date BETWEEN _period_start AND _period_end
     AND COALESCE(x.status, '') NOT IN ('refunded', 'cancelled');

  _rev := round(_rev, 8);
  _cogs := round(_cogs, 8);
  _exp := round(_exp, 8);
  _gross := round(_rev - _cogs, 8);
  _realized := round(_realized, 8);
  _pending := round(_pending, 8);
  _bad_debt := round(_bad_debt, 8);
  _net := round(_realized - _exp - _bad_debt, 8);

  -- 5) تجميع أرصدة الشركاء لحظة الإقفال
  FOR p IN
    SELECT id, name, confirmed_profit, current_balance, total_profit_earned
      FROM public.partners
     WHERE user_id = _owner
  LOOP
    _partner_summary := _partner_summary || jsonb_build_object(
      'partner_id', p.id,
      'partner_name', p.name,
      'current_balance', p.current_balance,
      'confirmed_profit', p.confirmed_profit,
      'total_earned', p.total_profit_earned
    );
  END LOOP;

  -- 6) تسجيل قيد الإقفال في السجل التاريخي المحمي
  INSERT INTO public.accounting_period_closures (
    user_id, period_start, period_end, total_revenue, total_cogs,
    gross_profit, total_expenses, net_profit, partner_distributions, closed_by,
    realized_profit, pending_profit, bad_debt_loss, closing_timezone
  ) VALUES (
    _owner, _period_start, _period_end, _rev, _cogs,
    _gross, _exp, _net, _partner_summary, _caller,
    _realized, _pending, _bad_debt, _tz
  ) RETURNING id INTO _closure_id;

  RETURN jsonb_build_object(
    'success', true,
    'closure_id', _closure_id,
    'period_start', _period_start,
    'period_end', _period_end,
    'timezone', _tz,
    'revenue', _rev,
    'cogs', _cogs,
    'gross_profit', _gross,
    'realized_profit', _realized,
    'pending_profit', _pending,
    'expenses', _exp,
    'bad_debt_loss', _bad_debt,
    'net_profit', _net,
    'partners', _partner_summary
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.close_accounting_period_atomic(date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_accounting_period_atomic(date, date, text) TO authenticated, service_role;

COMMIT;

-- ---------------------------------------------------------------------------
-- التحقق بعد التطبيق (كل الأعمدة يجب أن تكون true)
-- ---------------------------------------------------------------------------
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'paid_at_sale') AS paid_at_sale_column,
  EXISTS (SELECT 1 FROM pg_trigger
           WHERE tgrelid = 'public.invoices'::regclass AND tgname = 'c_set_invoice_paid_at_sale' AND NOT tgisinternal) AS paid_at_sale_trigger,
  NOT EXISTS (SELECT 1 FROM public.invoices WHERE payment_type = 'debt' AND paid_at_sale IS NULL) AS debt_invoices_backfilled,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'debt_writeoffs' AND column_name = 'loss_amount') AS writeoff_loss_column,
  NOT EXISTS (SELECT 1 FROM public.debt_writeoffs WHERE loss_amount IS NULL) AS writeoffs_backfilled,
  position('loss_amount' in pg_get_functiondef('public.writeoff_debt_atomic(uuid,text,text)'::regprocedure)) > 0 AS writeoff_computes_loss,
  to_regprocedure('public.close_accounting_period_atomic(date,date)') IS NULL AS old_close_removed,
  position('realized_profit' in pg_get_functiondef('public.close_accounting_period_atomic(date,date,text)'::regprocedure)) > 0 AS close_uses_unified_profit,
  NOT has_function_privilege('anon', 'public.close_accounting_period_atomic(date,date,text)', 'EXECUTE') AS close_blocked_for_anon;
