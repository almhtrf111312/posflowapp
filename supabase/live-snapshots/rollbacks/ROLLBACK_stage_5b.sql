-- تراجع الوردية متعددة العملات: يحذف الدالتين الجديدتين ويعيد close_cash_shift_atomic (3 معاملات) من 20261120... (النسخة الأصلية في تاريخ الهجرات)
DROP FUNCTION IF EXISTS public.resolve_shift_variance_atomic(uuid,text,text);
DROP FUNCTION IF EXISTS public.close_cash_shift_atomic(uuid,numeric,text,text,jsonb);
-- أعد تعريف close_cash_shift_atomic(uuid,numeric,text) من آخر هجرة سابقة تحتويها قبل 20261120050000.
DROP INDEX IF EXISTS public.idx_cash_shifts_deferred;
ALTER TABLE public.cash_shifts DROP CONSTRAINT IF EXISTS cash_shifts_variance_decision_check;
ALTER TABLE public.cash_shifts DROP COLUMN IF EXISTS opening_by_currency, DROP COLUMN IF EXISTS currency_counts, DROP COLUMN IF EXISTS variance_decision,
  DROP COLUMN IF EXISTS variance_resolved_by, DROP COLUMN IF EXISTS variance_resolved_at, DROP COLUMN IF EXISTS variance_note;
ALTER TABLE public.store_settings DROP COLUMN IF EXISTS shift_variance_tolerance_usd;
