-- ============================================================================
-- FINANCE RECONCILIATION SUMMARY (READ-ONLY) — one row per check
--
-- SELECT statements only. Nothing here writes, locks or alters anything.
-- Run this file ONCE in the Supabase SQL editor. It returns one row per check:
--   violations = 0  -> the check passes
--   violations > 0  -> run that check's detailed query from finance_reconcile_readonly.sql
-- R-07 is information only (not a gate, see KD-06): a non-zero value there is expected.
-- The logic of every check is the same as in finance_reconcile_readonly.sql (kept in sync by hand).
-- ============================================================================

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
select 'R-01 debt arithmetic [F-13]' as "check",
       (select count(*) from public.debts
          where status in ('due', 'partially_paid', 'fully_paid')
            and (   abs((coalesce(total_paid,0) + coalesce(remaining_debt,0)) - coalesce(total_debt,0)) > 0.01
                 or coalesce(remaining_debt,0) < -0.0001
                 or coalesce(total_paid,0)    < -0.0001)) as violations
union all
select 'R-02 debt paid = settled payments [F-13]',
       (select count(*) from (
          select d.id, d.user_id, d.total_paid, x.settled_sum, x.refunded_sum,
                 round(coalesce(d.total_paid,0) - (x.settled_sum - x.refunded_sum), 4) as diff
          from public.debts d
          cross join lateral (
            select coalesce((select sum(p.settled_amount) from public.debt_payments p where p.debt_id = d.id), 0) as settled_sum,
                   coalesce((select sum(greatest(coalesce((l.metadata->>'refund_amount')::numeric, 0) - coalesce((l.metadata->>'debt_reduced')::numeric, 0), 0))
                              from public.activity_log l
                              where l.user_id = d.user_id and l.action_type = 'partial_refund' and l.entity_type = 'invoice'
                                and d.invoice_id is not null and d.invoice_id in (l.entity_name, l.entity_id::text)), 0) as refunded_sum
          ) x
          where d.status in ('due', 'partially_paid', 'fully_paid')
            and d.created_at >= timestamptz '2026-11-05'
            and abs(coalesce(d.total_paid,0) - (x.settled_sum - x.refunded_sum)) > 0.01
       ) violations)
union all
select 'R-03 drawer movement orphan / owner / after close [F-19, F-20]',
       (select count(*) from public.shift_transactions t
          left join public.cash_shifts s on s.id = t.shift_id
          where s.id is null
             or s.user_id <> t.user_id
             or (s.closed_at is not null
                 and t.created_at > s.closed_at + interval '1 minute'
                 and t.type not in ('surplus', 'shortage')))
union all
select 'R-04 duplicate drawer movement [F-19]',
       (select count(*) from (
          select 1
          from public.shift_transactions
          where reference_id is not null
          group by shift_id, type, reference_id
          having count(*) > 1
       ) x)
union all
select 'R-05a reversed expense without refund movement [F-22]',
       (select count(*) from public.expenses e
          where coalesce(e.is_reversed, false)
            and exists     (select 1 from public.shift_transactions t where t.type = 'expense'        and t.reference_id = e.id::text)
            and not exists (select 1 from public.shift_transactions t where t.type = 'expense_refund' and t.reference_id = e.id::text))
union all
select 'R-05b expense movement without real expense [F-17, F-22]',
       (select count(*) from public.shift_transactions t
          where t.type = 'expense'
            and not exists (select 1 from public.expenses e where e.id::text = t.reference_id))
union all
select 'R-06 debt FX difference consistency [F-27]',
       (select count(*) from (
          select id, debt_id, amount, settled_amount, fx_difference_usd, fx_credit_rate
          from public.debt_payments
          where fx_credit_rate is not null
            and abs(fx_difference_usd - (amount - settled_amount + coalesce(rounding_adjustment, 0))) > 0.0001
       ) violations)
union all
select 'R-08 partner allocations within expense [F-21, D-09]',
       (select count(*) from (
          select e.id
          from public.expenses e
          cross join lateral jsonb_array_elements(coalesce(e.distributions, '[]'::jsonb)) d
          where not coalesce(e.is_reversed, false)
          group by e.id, e.user_id, e.amount
          having sum((d->>'amount')::numeric) > e.amount + 0.01
       ) x)
union all
select 'R-09 credit quick purchase without supplier [F-25, F7]',
       (select count(*) from (
          select pi.id, pi.invoice_number, pi.supplier_id, pi.actual_grand_total,
                 case when pi.supplier_id is null then 'no supplier' else 'no supplier ledger entry' end as problem
          from public.purchase_invoices pi
          where pi.payment_method = 'credit'
            and pi.status in ('finalized', 'completed')
            and pi.invoice_number like 'QP-%'
            and (pi.supplier_id is null
                 or not exists (select 1 from public.supplier_ledger_entries l
                                where l.user_id = pi.user_id and l.reference_type = 'purchase_invoice'
                                  and l.reference_id = pi.id::text and l.entry_type = 'purchase'))
       ) violations)
union all
select 'R-07 INFO only, open shift cache drift (not a gate, KD-06)',
       (select count(*) from public.cash_shifts s
          left join tx on tx.shift_id = s.id
          where s.closed_at is null
            and abs(coalesce(s.expected_balance,0) - (coalesce(s.opening_balance,0) + coalesce(tx.net,0))) > 0.005);
