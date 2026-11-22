-- ============================================================================
-- Migration: 20261123050000_pkg5_data_integrity_and_fk_hardening.sql
-- Package 5: Safe Historical Data Integrity Cleanup & FK Hardening
-- NOTE: Non-destructive cleanup ONLY — zero physical row deletions.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Nullify orphaned shift_id references in public.debt_payments
--    (preserves all debt_payments rows; documents cleanup in activity_log)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_rec record;
BEGIN
  FOR v_rec IN
    SELECT
      dp.user_id,
      count(*)::int AS affected_count,
      array_agg(dp.id ORDER BY dp.created_at) AS payment_ids,
      array_agg(DISTINCT dp.shift_id) AS orphan_shift_ids
    FROM public.debt_payments dp
    WHERE dp.shift_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.cash_shifts cs WHERE cs.id = dp.shift_id
      )
    GROUP BY dp.user_id
  LOOP
    UPDATE public.debt_payments
       SET shift_id = NULL
     WHERE id = ANY(v_rec.payment_ids);

    INSERT INTO public.activity_log (
      user_id,
      actor_id,
      actor_name,
      actor_role,
      action_type,
      entity_type,
      entity_id,
      entity_name,
      description,
      metadata
    ) VALUES (
      v_rec.user_id,
      NULL,
      'system_migration',
      'system',
      'data_integrity_cleanup',
      'debt_payments',
      NULL,
      'orphan_shift_id_cleanup',
      format(
        'تنظيف آمن: تصفير shift_id لعدد %s دفعة دين تشير إلى ورديات غير موجودة دون حذف أي سجل.',
        v_rec.affected_count
      ),
      jsonb_build_object(
        'migration', '20261123050000_pkg5_data_integrity_and_fk_hardening',
        'affected_count', v_rec.affected_count,
        'payment_ids', to_jsonb(v_rec.payment_ids),
        'orphan_shift_ids', to_jsonb(v_rec.orphan_shift_ids)
      )
    );
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 2. Add FOREIGN KEY (shift_id) REFERENCES public.cash_shifts(id) ON DELETE RESTRICT
--    on public.debt_payments (idempotent / guarded by IF NOT EXISTS)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.debt_payments'::regclass
      AND conname = 'debt_payments_shift_id_fkey'
  ) THEN
    ALTER TABLE public.debt_payments
      ADD CONSTRAINT debt_payments_shift_id_fkey
      FOREIGN KEY (shift_id)
      REFERENCES public.cash_shifts(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. Zero out residual profit & debt_remaining on refunded invoices
--    - Keeps total unchanged
--    - Skips invoices falling inside closed accounting periods
--    - Logs per-store summary in public.activity_log
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_rec record;
  v_skipped_closed int;
BEGIN
  FOR v_rec IN
    SELECT
      i.user_id,
      count(*)::int AS affected_count,
      round(COALESCE(SUM(COALESCE(i.profit, 0)), 0), 4) AS zeroed_profit_sum,
      round(COALESCE(SUM(COALESCE(i.debt_remaining, 0)), 0), 4) AS zeroed_debt_remaining_sum,
      array_agg(i.id ORDER BY i.created_at) AS invoice_ids,
      array_agg(i.invoice_number ORDER BY i.created_at) AS invoice_numbers
    FROM public.invoices i
    WHERE i.status = 'refunded'
      AND (COALESCE(i.profit, 0) > 0 OR COALESCE(i.debt_remaining, 0) > 0)
      AND NOT EXISTS (
        SELECT 1
        FROM public.accounting_period_closures apc
        WHERE apc.user_id = i.user_id
          AND (i.created_at AT TIME ZONE COALESCE(NULLIF(trim(apc.closing_timezone), ''), 'UTC'))::date
              BETWEEN apc.period_start AND apc.period_end
      )
    GROUP BY i.user_id
  LOOP
    SELECT count(*)::int
      INTO v_skipped_closed
      FROM public.invoices i
     WHERE i.user_id = v_rec.user_id
       AND i.status = 'refunded'
       AND (COALESCE(i.profit, 0) > 0 OR COALESCE(i.debt_remaining, 0) > 0)
       AND EXISTS (
         SELECT 1
         FROM public.accounting_period_closures apc
         WHERE apc.user_id = i.user_id
           AND (i.created_at AT TIME ZONE COALESCE(NULLIF(trim(apc.closing_timezone), ''), 'UTC'))::date
               BETWEEN apc.period_start AND apc.period_end
       );

    UPDATE public.invoices
       SET profit = 0,
           debt_remaining = 0,
           updated_at = now()
     WHERE id = ANY(v_rec.invoice_ids);

    INSERT INTO public.activity_log (
      user_id,
      actor_id,
      actor_name,
      actor_role,
      action_type,
      entity_type,
      entity_id,
      entity_name,
      description,
      metadata
    ) VALUES (
      v_rec.user_id,
      NULL,
      'system_migration',
      'system',
      'data_integrity_cleanup',
      'invoices',
      NULL,
      'refunded_invoice_residuals_cleanup',
      format(
        'تنظيف آمن: تصفير بقايا الربح (%s) والمتبقي للدين (%s) على %s فاتورة مرتجعة مع الإبقاء على الإجمالي كما هو (تم تخطي %s فاتورة ضمن فترات مقفلة).',
        v_rec.zeroed_profit_sum,
        v_rec.zeroed_debt_remaining_sum,
        v_rec.affected_count,
        COALESCE(v_skipped_closed, 0)
      ),
      jsonb_build_object(
        'migration', '20261123050000_pkg5_data_integrity_and_fk_hardening',
        'affected_count', v_rec.affected_count,
        'skipped_closed_period_count', COALESCE(v_skipped_closed, 0),
        'zeroed_profit_sum', v_rec.zeroed_profit_sum,
        'zeroed_debt_remaining_sum', v_rec.zeroed_debt_remaining_sum,
        'invoice_ids', to_jsonb(v_rec.invoice_ids),
        'invoice_numbers', to_jsonb(v_rec.invoice_numbers)
      )
    );
  END LOOP;
END $$;
