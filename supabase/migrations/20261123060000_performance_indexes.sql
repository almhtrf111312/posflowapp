-- ============================================================================
-- Migration: 20261123060000_performance_indexes.sql
-- Purpose  : Add missing high-impact composite & foreign-key B-tree indexes
--            verified against live Supabase project `posflowapp`
--            (bwlqfxfvchjvehnbvwaz) on 2026-11-23.
-- Safety   : Fully idempotent (CREATE INDEX IF NOT EXISTS).
--            Zero schema/data/accounting-logic changes.
-- Notes    :
--   - Existing indexes on `invoices (user_id, created_at DESC)`,
--     `invoice_items (invoice_id)`, `debts (user_id, status)`,
--     `debts (customer_id)`, `purchase_invoice_items (invoice_id, product_id)`,
--     `activity_log (user_id, created_at DESC / action_type)`, and
--     `support_messages (conversation_id, created_at)` were verified as
--     already present and are NOT duplicated here.
--   - Live schema uses `shift_transactions` (for cash drawer transactions)
--     and `partner_ledger_entries` (for partner profit/balance ledger).
-- ============================================================================

-- 1. invoices: tenant + status filtering (reports, archive, refunds)
CREATE INDEX IF NOT EXISTS idx_invoices_user_status
  ON public.invoices (user_id, status);

-- 2. invoice_items: product_id lookup & FK join/check (not leading in composite idx)
CREATE INDEX IF NOT EXISTS idx_invoice_items_product_id
  ON public.invoice_items (product_id)
  WHERE product_id IS NOT NULL;

-- 3. products: tenant-scoped ordering, archive filter, and fast POS barcode lookup
CREATE INDEX IF NOT EXISTS idx_products_user_created_at
  ON public.products (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_products_user_archived
  ON public.products (user_id, archived);

CREATE INDEX IF NOT EXISTS idx_products_user_barcode
  ON public.products (user_id, barcode)
  WHERE barcode IS NOT NULL;

-- 4. customers: tenant-scoped chronological listing & sync
CREATE INDEX IF NOT EXISTS idx_customers_user_created_at
  ON public.customers (user_id, created_at DESC);

-- 5. debts: tenant-scoped chronological listing & sync
CREATE INDEX IF NOT EXISTS idx_debts_user_created_at
  ON public.debts (user_id, created_at DESC);

-- 6. debt_payments: missing FK indexes (debt_id, shift_id) & tenant history
CREATE INDEX IF NOT EXISTS idx_debt_payments_debt_id
  ON public.debt_payments (debt_id);

CREATE INDEX IF NOT EXISTS idx_debt_payments_shift_id
  ON public.debt_payments (shift_id)
  WHERE shift_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_debt_payments_user_created_at
  ON public.debt_payments (user_id, created_at DESC);

-- 7. expenses: tenant-scoped date/created_at ordering & reversed status filter
CREATE INDEX IF NOT EXISTS idx_expenses_user_created_at
  ON public.expenses (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_user_date
  ON public.expenses (user_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_user_is_reversed
  ON public.expenses (user_id, is_reversed);

-- 8. cash_shifts: tenant timeline, active open-shift lookup, reconciliation filter
CREATE INDEX IF NOT EXISTS idx_cash_shifts_user_opened_at
  ON public.cash_shifts (user_id, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_cash_shifts_user_open
  ON public.cash_shifts (user_id)
  WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cash_shifts_user_reconciliation_status
  ON public.cash_shifts (user_id, reconciliation_status);

-- 9. shift_transactions (cash drawer transactions): tenant & shift timelines
CREATE INDEX IF NOT EXISTS idx_shift_transactions_user_created_at
  ON public.shift_transactions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shift_transactions_shift_created_at
  ON public.shift_transactions (shift_id, created_at DESC);

-- 10. purchase_invoices: tenant ordering, tenant+status filter, shift payment FK
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_user_created_at
  ON public.purchase_invoices (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_invoices_user_status
  ON public.purchase_invoices (user_id, status);

CREATE INDEX IF NOT EXISTS idx_purchase_invoices_paid_shift_id
  ON public.purchase_invoices (paid_shift_id)
  WHERE paid_shift_id IS NOT NULL;

-- 11. profit_records: tenant profit reporting & chronological queries
CREATE INDEX IF NOT EXISTS idx_profit_records_user_reversed_recorded
  ON public.profit_records (user_id, is_reversed, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_profit_records_user_created_at
  ON public.profit_records (user_id, created_at DESC);

-- 12. partner_ledger_entries: missing tenant (user_id) RLS & timeline index
CREATE INDEX IF NOT EXISTS idx_partner_ledger_entries_user_created_at
  ON public.partner_ledger_entries (user_id, created_at DESC);

-- 13. support_messages: fast unread count per conversation
CREATE INDEX IF NOT EXISTS idx_support_messages_conv_unread
  ON public.support_messages (conversation_id)
  WHERE is_read = false;
