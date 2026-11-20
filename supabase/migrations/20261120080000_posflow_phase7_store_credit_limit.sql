-- PosFlow phase 7: customer store credit ledger, credit limit enforcement, credit→debt settlement, cash payout.
-- (Applied to bwlqfxfvchjvehnbvwaz via MCP as posflow_phase7_store_credit_limit.)
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS credit_limit numeric(18,4) CHECK (credit_limit IS NULL OR credit_limit >= 0);

CREATE TABLE IF NOT EXISTS public.customer_credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  entry_type text NOT NULL CHECK (entry_type IN ('issue','spend','payout','adjustment')),
  amount numeric(18,4) NOT NULL CHECK (amount <> 0),
  invoice_number text, debt_id uuid, shift_id uuid, reason text, operation_id text, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_ledger_op ON public.customer_credit_ledger(user_id, operation_id, entry_type) WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_credit_ledger_customer ON public.customer_credit_ledger(customer_id, created_at);
ALTER TABLE public.customer_credit_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY credit_ledger_select ON public.customer_credit_ledger FOR SELECT TO authenticated USING (user_id = public.get_owner_id(auth.uid()));
REVOKE ALL ON public.customer_credit_ledger FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.customer_credit_ledger FROM authenticated;
-- View customer_credit_balances, functions _credit_actor, set_customer_credit_limit_atomic, issue_store_credit_atomic,
-- apply_store_credit_to_debt_atomic (reuses record_debt_payment_atomic without a shift), payout_store_credit_atomic
-- (shift_transactions type 'store_credit_refund'), close_cash_shift_atomic outflow list + store_credit_refund,
-- and a credit-limit check inserted before the debts INSERT in process_pos_sale_atomic: see the live database for bodies.
