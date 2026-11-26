-- ROLLBACK for migration 20261126170000_s2_block_direct_financial_tampering.sql (S-2, D-32).
-- Run ONLY if S-2 was applied on the live database and must be undone. It removes the 7 guard triggers and their
-- functions, and gives clients EXECUTE on the two internal RPCs again (the state before S-2). It touches no data.
BEGIN;
DROP TRIGGER IF EXISTS a0_guard_direct ON public.shift_transactions;
DROP TRIGGER IF EXISTS a0_guard_direct ON public.debts;
DROP TRIGGER IF EXISTS a0_guard_direct ON public.profit_records;
DROP TRIGGER IF EXISTS a0_guard_direct ON public.cash_shifts;
DROP TRIGGER IF EXISTS a0_guard_cashier_direct ON public.invoices;
DROP TRIGGER IF EXISTS a0_guard_cashier_direct ON public.invoice_items;
DROP TRIGGER IF EXISTS a0_guard_cashier_direct ON public.products;
DROP FUNCTION IF EXISTS public.guard_shift_transactions_direct();
DROP FUNCTION IF EXISTS public.guard_debts_direct();
DROP FUNCTION IF EXISTS public.guard_profit_records_direct();
DROP FUNCTION IF EXISTS public.guard_cash_shifts_direct();
DROP FUNCTION IF EXISTS public.guard_invoices_cashier_direct();
DROP FUNCTION IF EXISTS public.guard_invoice_items_cashier_direct();
DROP FUNCTION IF EXISTS public.guard_products_cost_cashier_direct();
DROP FUNCTION IF EXISTS public._caller_is_store_manager();
DROP FUNCTION IF EXISTS public._direct_client_write();
GRANT EXECUTE ON FUNCTION public.receive_stock_wac(uuid, numeric, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.post_shift_sale_atomic(uuid, text, numeric, text, numeric, numeric, text) TO authenticated;
COMMIT;
