-- =============================================================================
-- Rollback for 20261120260000_posflow_audit_review_critical_fixes.sql
-- =============================================================================
DROP INDEX IF EXISTS public.idx_invoices_user_updated_at;

-- Note:
-- - mark_invoice_digital: previous version had a bug (auth.uid() instead of get_owner_id);
--   rolling back breaks cashier digital sales and is NOT recommended.
-- - record_stock_damage_atomic: previous version deducted both products and warehouse_stock;
--   rolling back reintroduces double stock deduction and is NOT recommended.
-- - _partners_trim_history: to restore 400-day trigger, re-run 20261120200000_posflow_audit_fixes_2.sql.
-- - release_pending_partner_profits_for_invoice: to restore prior version, re-run 20261120170000_posflow_audit_fixes.sql.
-- - refund_invoice_partial_atomic / edit_purchase_invoice_atomic / purchase_return_atomic:
--   re-apply bodies from 20261120200000, 20261120230000, and 20261120250000 if ever needed.
