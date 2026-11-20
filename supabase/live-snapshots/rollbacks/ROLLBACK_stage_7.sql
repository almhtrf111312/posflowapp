DROP FUNCTION IF EXISTS public.payout_store_credit_atomic(uuid,numeric,uuid,text);
DROP FUNCTION IF EXISTS public.apply_store_credit_to_debt_atomic(uuid,numeric,text);
DROP FUNCTION IF EXISTS public.issue_store_credit_atomic(uuid,numeric,text,text,text);
DROP FUNCTION IF EXISTS public.set_customer_credit_limit_atomic(uuid,numeric);
DROP FUNCTION IF EXISTS public._credit_actor(boolean);
DROP VIEW IF EXISTS public.customer_credit_balances;
-- process_pos_sale_atomic: remove the "credit limit" block before the debts INSERT; close_cash_shift_atomic: drop 'store_credit_refund' from outflow lists.
-- Ledger table kept for history: DROP TABLE public.customer_credit_ledger; ALTER TABLE public.customers DROP COLUMN credit_limit;
