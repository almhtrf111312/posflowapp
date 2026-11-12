-- Local test for supabase/migrations/20261112010000_phase2_unified_profit.sql
-- LOCAL ONLY: run on a throw-away PostgreSQL with stub tables, never on production.
-- Order: stub schema + phase 1 -> the SEED part -> apply the phase 2 migration -> the TEST part.
-- Expected results are written in each \echo line. Last run: 2026-11-12, all matched,
-- and the Istanbul-days close equals the app test in src/lib/__tests__/profit-engine.test.ts
-- (sales 430, realized 49, pending 26, expenses 15, bad-debt loss 60, net -26).

-- ============================== SEED (before the migration) ==============================
INSERT INTO user_roles VALUES
 ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','admin',NULL),
 ('ffffffff-ffff-ffff-ffff-ffffffffffff','cashier','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
INSERT INTO products(id,user_id,category,quantity,cost_price) VALUES
 ('b0000000-0000-0000-0000-000000000001','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','هواتف',5,40),
 ('b0000000-0000-0000-0000-000000000002','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','غذائيات',5,20);
INSERT INTO invoices(id,user_id,invoice_number,invoice_type,total,tax_amount,profit,status,payment_type,debt_paid,debt_remaining,customer_name,created_at,date) VALUES
 ('c0000000-0000-0000-0000-000000000001','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','P2-C1','sale',50,0,10,'paid','cash',0,0,'نقدي','2026-03-01 10:00+00','2026-03-01'),
 ('c0000000-0000-0000-0000-000000000002','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','P2-D1','sale',200,0,40,'pending','debt',70,130,'سامر','2026-03-01 11:00+00','2026-03-01'),
 ('c0000000-0000-0000-0000-000000000003','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','P2-D2','sale',80,0,20,'pending','debt',0,80,'خالد','2026-03-02 09:00+00','2026-03-02');
INSERT INTO invoice_items(invoice_id,product_id,product_name,quantity,unit_price,cost_price,profit) VALUES
 ('c0000000-0000-0000-0000-000000000003','b0000000-0000-0000-0000-000000000001','هاتف',1,55,40,15),
 ('c0000000-0000-0000-0000-000000000003','b0000000-0000-0000-0000-000000000002','رز',1,25,20,5);
INSERT INTO debts(id,user_id,invoice_id,customer_name,total_debt,total_paid,remaining_debt,status,is_cash_debt) VALUES
 ('d0000000-0000-0000-0000-000000000001','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','P2-D1','سامر',200,70,130,'partially_paid',false),
 ('d0000000-0000-0000-0000-000000000002','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','P2-D2','خالد',80,0,80,'due',false),
 ('d0000000-0000-0000-0000-000000000003','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',NULL,'قرض نقدي',15,0,15,'due',true);
INSERT INTO debt_payments(user_id,debt_id,operation_id,amount,created_at) VALUES
 ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','d0000000-0000-0000-0000-000000000001','op-pay-0001',50,'2026-03-03 12:00+00');
INSERT INTO customers(user_id,name,total_debt) VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','خالد',80);
INSERT INTO expenses(user_id,amount,date) VALUES
 ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',12,'2026-03-02'),('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',3,'2026-03-03');
INSERT INTO partners(id,user_id,name,access_all,share_percentage,category_shares,pending_profit,pending_profit_details,confirmed_profit,current_balance,total_profit_earned,profit_history) VALUES
 ('a0000000-0000-0000-0000-000000000001','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','شريك الهواتف',false,0,'[{"categoryName":"هواتف","enabled":true,"percentage":50}]',7.5,'[{"invoiceId":"P2-D2","amount":7.5}]',100,100,100,'[]'),
 ('a0000000-0000-0000-0000-000000000002','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','شريك عام',true,30,NULL,3.75,'[{"invoiceId":"P2-D2","amount":3.75},{"invoiceId":"OTHER","amount":1}]',100,100,100,'[]');

-- ============================== TEST (after the migration) ==============================
\set ON_ERROR_STOP 0
\set VERBOSITY terse
\pset format unaligned
\pset tuples_only on
\echo '== B1 backfill: D1 paid_at_sale = 70 - 50 dated = 20; D2 = 0; cash C1 stays NULL'
SELECT invoice_number, paid_at_sale FROM invoices WHERE invoice_number LIKE 'P2-%' ORDER BY 1;
\echo '== B2 trigger on new rows: cash -> total (120), credit -> down payment (30), explicit value kept (5)'
INSERT INTO invoices(id,user_id,invoice_number,invoice_type,total,tax_amount,profit,status,payment_type,debt_paid,debt_remaining,created_at,date) VALUES
 ('c0000000-0000-0000-0000-000000000004','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','P2-C2','sale',120,20,25,'paid','cash',0,0,'2026-03-03 15:00+00','2026-03-03'),
 ('c0000000-0000-0000-0000-000000000005','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','P2-C3','sale',10,0,2,'paid','cash',0,0,'2026-03-03 22:30+00','2026-03-03');
INSERT INTO invoices(user_id,invoice_number,total,profit,status,payment_type,debt_paid,created_at) VALUES
 ('99999999-9999-9999-9999-999999999999','X-1',100,10,'pending','debt',30,now());
INSERT INTO invoices(user_id,invoice_number,total,profit,status,payment_type,debt_paid,paid_at_sale,created_at) VALUES
 ('99999999-9999-9999-9999-999999999999','X-2',100,10,'pending','debt',30,5,now());
SELECT invoice_number, paid_at_sale FROM invoices WHERE invoice_number IN ('P2-C2','X-1','X-2') ORDER BY 1;

SET ROLE authenticated;
\echo '== W1 cashier write-off (expect owner only)'
SELECT set_config('request.jwt.claim.sub','ffffffff-ffff-ffff-ffff-ffffffffffff',false);
SELECT public.writeoff_debt_atomic('d0000000-0000-0000-0000-000000000002','تعثر','op-wo-000001');
\echo '== W2 owner writes off D2 (80, profit 20): cancelled 20, loss 60; phones 40 -> cat partner 20, general 30% of 20 = 6; food 20 -> general 6; owner 28'
SELECT set_config('request.jwt.claim.sub','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',false);
SELECT jsonb_pretty(public.writeoff_debt_atomic('d0000000-0000-0000-0000-000000000002','تعثر','op-wo-000001'));
\echo '== W3 repeat is a no-op (already_written_off)'
SELECT public.writeoff_debt_atomic('d0000000-0000-0000-0000-000000000002','تعثر','op-wo-000001');
\echo '== W4 cash loan 15, no invoice: loss 15, partners 0, owner 15 (owner decision)'
SELECT public.writeoff_debt_atomic('d0000000-0000-0000-0000-000000000003','قرض','op-wo-000002') - 'partner_impact';
RESET ROLE;
\echo '== W5 partners after: phones 100-20=80 pending 0; general 100-6-6=88 pending 1 (other invoice kept)'
SELECT name, confirmed_profit, current_balance, total_profit_earned, pending_profit, jsonb_array_length(profit_history) AS hist FROM partners WHERE user_id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' ORDER BY name;
\echo '== W6 write-off records, invoice status, customer balance'
SELECT amount, loss_amount, pending_profit_cancelled, capital_impact, jsonb_array_length(partner_impact), notes FROM debt_writeoffs WHERE user_id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' ORDER BY amount DESC;
SELECT status FROM invoices WHERE invoice_number='P2-D2';
SELECT total_debt FROM customers WHERE name='خالد';
-- place the write-offs inside the test period (the function stamps now())
UPDATE debt_writeoffs SET written_off_at = '2026-03-03 16:00+00' WHERE user_id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' AND notes='P2-D2';
UPDATE debt_writeoffs SET written_off_at = '2026-04-10 16:00+00' WHERE user_id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' AND notes IS NULL;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',false);
\echo '== G1 payment on a written-off debt is refused (direct update, as any RPC would do)'
UPDATE debts SET total_paid = 10, remaining_debt = 70, status = 'partially_paid' WHERE id='d0000000-0000-0000-0000-000000000002';
\echo '== G2 refund / amount change on a written-off invoice is refused; a note edit is allowed (UPDATE 1)'
UPDATE invoices SET status = 'refunded' WHERE invoice_number='P2-D2';
UPDATE invoices SET profit = 0 WHERE invoice_number='P2-D2';
UPDATE invoices SET notes = 'ملاحظة' WHERE invoice_number='P2-D2';
\echo '== G3 open debts and other invoices are not affected (UPDATE 1 each)'
UPDATE debts SET notes = 'x' WHERE id='d0000000-0000-0000-0000-000000000001';
UPDATE invoices SET notes = 'x' WHERE invoice_number='P2-D1';
SELECT status, total_paid FROM debts WHERE id='d0000000-0000-0000-0000-000000000002';
\echo '== P1 cashier close (expect owner only); bad timezone; future period'
SELECT set_config('request.jwt.claim.sub','ffffffff-ffff-ffff-ffff-ffffffffffff',false);
SELECT public.close_accounting_period_atomic('2026-03-01','2026-03-03');
SELECT set_config('request.jwt.claim.sub','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',false);
SELECT public.close_accounting_period_atomic('2026-03-01','2026-03-03','Not/AZone');
SELECT public.close_accounting_period_atomic('2026-03-01','2099-03-03');
\echo '== P2 Istanbul days (the 22:30Z sale falls on 04 March): must equal the app test: sales 430, realized 49, pending 26, expenses 15, loss 60, net -26'
BEGIN;
SELECT public.close_accounting_period_atomic('2026-03-01','2026-03-03','Europe/Istanbul') - 'partners' - 'closure_id';
ROLLBACK;
\echo '== P3 UTC days include the 22:30Z sale: sales 440, realized 51, net -24'
SELECT public.close_accounting_period_atomic('2026-03-01','2026-03-03') - 'partners' - 'closure_id';
\echo '== P4 overlapping close refused'
SELECT public.close_accounting_period_atomic('2026-03-02','2026-03-05');
\echo '== P5 April: only the cash-loan write-off: loss 15, net -15'
SELECT public.close_accounting_period_atomic('2026-04-01','2026-04-30') - 'partners' - 'closure_id';
RESET ROLE;
SELECT period_start, total_revenue, gross_profit, realized_profit, pending_profit, total_expenses, bad_debt_loss, net_profit, closing_timezone FROM accounting_period_closures WHERE user_id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' ORDER BY 1;
\echo '== G grants: anon cannot execute either function'
SELECT has_function_privilege('anon','public.close_accounting_period_atomic(date,date,text)','EXECUTE'), has_function_privilege('anon','public.writeoff_debt_atomic(uuid,text,text)','EXECUTE');
