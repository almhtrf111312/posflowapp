-- ============================================================================
-- FINANCE RECONCILIATION (READ-ONLY) — docs/FINANCE_LAW.md §5, gate G4
--
-- SELECT statements only. Nothing here writes, locks or alters anything.
-- Run each query separately in the Supabase SQL editor. EVERY QUERY MUST RETURN ZERO ROWS.
-- A returned row is a violation of the invariant named in the header comment: report it, never "fix" data
-- by hand and never edit the query to make it pass (docs/FINANCE_LAW.md §6).
--
-- Columns used are the stable ones (generated types + migrations). Gates are R-01..R-06; R-07 is information only.
-- The golden-case harness (npm run finance:sql) runs this very file against a database built from the migrations.
-- ============================================================================


-- R-01 [F-13] Debt arithmetic: total_paid + remaining_debt = total_debt, no negative amounts.
-- Only open/paid debts: other statuses (cancelled, written off...) legitimately break the identity.
select id, user_id, status, total_debt, total_paid, remaining_debt,
       round((coalesce(total_paid,0) + coalesce(remaining_debt,0)) - coalesce(total_debt,0), 4) as diff
from public.debts
where status in ('due', 'partially_paid', 'fully_paid')
  and (   abs((coalesce(total_paid,0) + coalesce(remaining_debt,0)) - coalesce(total_debt,0)) > 0.01
       or coalesce(remaining_debt,0) < -0.0001
       or coalesce(total_paid,0)    < -0.0001);


-- R-02 [F-13] Debt paid total equals the sum of what its payments settled (settled_amount; `amount` is the cash received).
-- Only debts created after debt_payments went live (2026-11-05): older rows may legitimately predate it.
select d.id, d.user_id, d.total_paid, coalesce(sum(p.settled_amount), 0) as settled_sum,
       round(coalesce(d.total_paid,0) - coalesce(sum(p.settled_amount), 0), 4) as diff
from public.debts d
left join public.debt_payments p on p.debt_id = d.id
where d.status in ('due', 'partially_paid', 'fully_paid')
  and d.created_at >= timestamptz '2026-11-05'
group by d.id, d.user_id, d.total_paid
having abs(coalesce(d.total_paid,0) - coalesce(sum(p.settled_amount), 0)) > 0.01;


-- R-03 [F-19, F-20] Every drawer movement belongs to a shift of the same owner, and none was posted after its shift closed.
-- (surplus/shortage are excluded: they are legitimately written when a variance is resolved after closing.)
select t.id, t.shift_id, t.type, t.amount, t.created_at, s.closed_at,
       case when s.id is null then 'orphan: no such shift'
            when s.user_id <> t.user_id then 'owner mismatch'
            else 'posted after the shift closed' end as problem
from public.shift_transactions t
left join public.cash_shifts s on s.id = t.shift_id
where s.id is null
   or s.user_id <> t.user_id
   or (s.closed_at is not null
       and t.created_at > s.closed_at + interval '1 minute'
       and t.type not in ('surplus', 'shortage'));


-- R-04 [F-19] A cash movement is posted once: no duplicate (shift, type, reference).
select shift_id, type, reference_id, count(*) as copies
from public.shift_transactions
where reference_id is not null
group by shift_id, type, reference_id
having count(*) > 1;


-- R-05a [F-22] A reversed expense that moved the drawer must have its refund movement.
select e.id, e.user_id, e.amount, e.reversed_at
from public.expenses e
where coalesce(e.is_reversed, false)
  and exists     (select 1 from public.shift_transactions t where t.type = 'expense'        and t.reference_id = e.id::text)
  and not exists (select 1 from public.shift_transactions t where t.type = 'expense_refund' and t.reference_id = e.id::text);


-- R-05b [F-17, F-22] Every 'expense' drawer movement points at a real expense (reference_id = expenses.id).
-- legacy_ref = true marks rows written by the old client path (reference "exp_<timestamp>"): they predate the
-- fix and cannot be reversed by delete_expense_atomic — review them, do not delete them.
select t.id, t.shift_id, t.amount, t.reference_id, t.created_at,
       (t.reference_id like 'exp\_%') as legacy_ref
from public.shift_transactions t
where t.type = 'expense'
  and not exists (select 1 from public.expenses e where e.id::text = t.reference_id);


-- R-06 [F-27] FX difference consistency for debt payments credited at the invoice rate (needs migration
-- 20261123071000_debt_payment_invoice_rate_fx_difference.sql to be applied; before that the column does not exist).
select id, debt_id, amount, settled_amount, fx_difference_usd, fx_credit_rate
from public.debt_payments
where fx_credit_rate is not null
  and abs(fx_difference_usd - (amount - settled_amount)) > 0.0001;


-- R-07 [F-18] INFORMATION ONLY — NOT a gate (KD-06). cash_shifts.expected_balance is a best-effort cache during an open shift:
-- cash sales, client deposits, quick purchases and FX conversions write drawer movements without updating it. The
-- authoritative balance is the sum of shift_transactions, recomputed when the shift closes. Non-zero drift here is expected.
with tx as (
  select shift_id,
         sum(case
               when type in ('sale','deposit','deposit_capital','deposit_revenue','deposit_purchase_cover',
                             'debt_payment','surplus','expense_refund','supplier_refund','fx_in','transfer_in') then amount
               when type in ('expense','refund','withdrawal','supplier_payment','store_credit_refund',
                             'shortage','fx_out','transfer_out') then -amount
               else 0 end) as net
  from public.shift_transactions
  group by shift_id
)
select s.id, s.user_id, s.opened_at, s.opening_balance, s.expected_balance,
       round(coalesce(s.opening_balance,0) + coalesce(tx.net,0), 2) as recomputed_from_movements,
       round(coalesce(s.expected_balance,0) - (coalesce(s.opening_balance,0) + coalesce(tx.net,0)), 2) as cache_drift
from public.cash_shifts s
left join tx on tx.shift_id = s.id
where s.closed_at is null;
