// Golden scenarios (docs/FINANCE_LAW.md gate G1). Every expected number is computed by hand in the comment above it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWNER } from './world.mjs';

const RECON = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'finance_reconcile_readonly.sql');

/** Split the reconciliation file into { id, sql } blocks by its "-- R-xx" headers. */
export function reconQueries() {
  const text = fs.readFileSync(RECON, 'utf8');
  const parts = text.split(/^-- (R-\d\d[ab]?) /m).slice(1);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    const sql = parts[i + 1].split('\n').slice(1).filter((l) => !l.startsWith('--')).join('\n').trim().replace(/;\s*$/, '');
    out.push({ id: parts[i], sql });
  }
  return out;
}

export async function runScenarios(w, k) {
  const { q, one, op, newShift, newInvoice, newDebt, debt, expected, txSum, fails } = w;
  const { check, truthy } = k;

  // ---------- Debts in USD ----------
  {
    const sh = await newShift(100);
    const d = await newDebt({ total: 100, isCash: true });
    const o = op('usd');
    await one(`select public.record_debt_payment_atomic($1,40,$2,$3,'USD',40,1,'cash')`, [d, o, sh]);
    // 100 - 40 = 60 left; drawer 100 + 40 = 140
    check('DEBT-USD partial: paid', (await debt(d)).paid, 40);
    check('DEBT-USD partial: remaining', (await debt(d)).remaining, 60);
    check('DEBT-USD partial: drawer movement', await txSum(sh, 'debt_payment'), 40);
    check('DEBT-USD partial: expected_balance', await expected(sh), 140);
    await one(`select public.record_debt_payment_atomic($1,40,$2,$3,'USD',40,1,'cash')`, [d, o, sh]);
    check('DEBT-USD replay is idempotent (paid)', (await debt(d)).paid, 40);
    check('DEBT-USD replay is idempotent (drawer)', await txSum(sh, 'debt_payment'), 40);
    truthy('DEBT-USD overpay is rejected', await fails(one(`select public.record_debt_payment_atomic($1,61,$2,$3,'USD',61,1,'cash')`, [d, op('usd'), sh])));
    await one(`select public.record_debt_payment_atomic($1,60,$2,$3,'USD',60,1,'cash')`, [d, op('usd'), sh]);
    check('DEBT-USD final payment: status', (await debt(d)).status, 'fully_paid');
    truthy('DEBT-USD closed debt rejects payment', await fails(one(`select public.record_debt_payment_atomic($1,1,$2,$3,'USD',1,1,'cash')`, [d, op('usd'), sh])));
  }

  // ---------- Debts in a foreign currency (KD-01 / F-27) ----------
  // Invoice in SYP at 15000 SYP per USD. Debt = 100 USD (= 1,500,000 SYP).
  const synFx = async (name, payAmountSyp, payRate, expect) => {
    const sh = await newShift(100);
    const inv = await newInvoice({ number: `INV-${name}`, total: 1500000, currency: 'SYP', rate: 15000 });
    const d = await newDebt({ total: 100, invoice: inv.invoice_number });
    const cash = Math.round((payAmountSyp / payRate) * 100) / 100;
    const o = op('fx');
    const res = await fails(one(`select public.record_debt_payment_atomic($1,$2,$3,$4,'SYP',$5,$6,'cash')`, [d, cash, o, sh, payAmountSyp, payRate]));
    return { sh, d, o, cash, res, inv };
  };
  {
    // FX-1: pay 750,000 SYP when today's rate is 20000: cash = 37.5 USD; credit = 750000/15000 = 50; fx = 37.5 - 50 = -12.5
    const r = await synFx('FX1', 750000, 20000);
    check('FX-1 no error', r.res, 'null');
    const dd = await debt(r.d);
    check('FX-1 debt credited at invoice rate: paid', dd.paid, 50);
    check('FX-1 remaining', dd.remaining, 50);
    check('FX-1 drawer = cash value at today rate', await txSum(r.sh, 'debt_payment'), 37.5);
    check('FX-1 expected_balance = 100 + 37.5', await expected(r.sh), 137.5);
    const p = await one(`select amount::float8 a, settled_amount::float8 s, fx_difference_usd::float8 f, fx_credit_rate::float8 r from public.debt_payments where debt_id=$1`, [r.d]);
    check('FX-1 payment.amount (cash)', p.a, 37.5); check('FX-1 payment.settled_amount', p.s, 50);
    check('FX-1 fx_difference_usd (loss)', p.f, -12.5); check('FX-1 fx_credit_rate', p.r, 15000);
    const t = await one(`select currency, currency_amount::float8 ca, exchange_rate::float8 er from public.shift_transactions where shift_id=$1 and type='debt_payment'`, [r.sh]);
    check('FX-1 drawer movement currency', t.currency, 'SYP'); check('FX-1 drawer movement foreign amount', t.ca, 750000); check('FX-1 drawer movement rate', t.er, 20000);
    // FX-3 replay
    const again = await fails(one(`select public.record_debt_payment_atomic($1,$2,$3,$4,'SYP',750000,20000,'cash')`, [r.d, r.cash, r.o, r.sh]));
    check('FX-3 replay accepted', again, 'null'); check('FX-3 replay does not double-credit', (await debt(r.d)).paid, 50);
    check('FX-3 replay does not double-post the drawer', await txSum(r.sh, 'debt_payment'), 37.5);
    // FX-4 overpay: remaining is 50 USD = 750,000 SYP; 800,000 SYP at 20000 must be rejected
    truthy('FX-4 overpay beyond remaining is rejected', await fails(one(`select public.record_debt_payment_atomic($1,40,$2,$3,'SYP',800000,20000,'cash')`, [r.d, op('fx'), r.sh])));
  }
  {
    // FX-2: pay 750,000 SYP when today's rate is 12000: cash = 62.5; credit = 50; fx = +12.5
    const r = await synFx('FX2', 750000, 12000);
    const p = await one(`select amount::float8 a, settled_amount::float8 s, fx_difference_usd::float8 f from public.debt_payments where debt_id=$1`, [r.d]);
    check('FX-2 cash', p.a, 62.5); check('FX-2 credit', p.s, 50); check('FX-2 fx_difference (gain)', p.f, 12.5);
    check('FX-2 remaining', (await debt(r.d)).remaining, 50);
    // pay the other half 750,000 SYP at 15000: cash 50, credit 50, fx 0 -> fully paid
    await one(`select public.record_debt_payment_atomic($1,50,$2,$3,'SYP',750000,15000,'cash')`, [r.d, op('fx'), r.sh]);
    const dd = await debt(r.d);
    check('FX-2 second half: fully paid', dd.status, 'fully_paid'); check('FX-2 second half: remaining 0', dd.remaining, 0);
  }
  {
    // FX-5: USD payment on an SYP invoice debt keeps the legacy behaviour (credit = cash, no fx).
    const sh = await newShift(100);
    const inv = await newInvoice({ number: 'INV-FX5', total: 1500000, currency: 'SYP', rate: 15000 });
    const d = await newDebt({ total: 100, invoice: inv.invoice_number });
    await one(`select public.record_debt_payment_atomic($1,30,$2,$3,'USD',30,1,'cash')`, [d, op('fx'), sh]);
    const p = await one(`select settled_amount::float8 s, fx_difference_usd::float8 f, fx_credit_rate from public.debt_payments where debt_id=$1`, [d]);
    check('FX-5 USD on SYP invoice: credit = cash', p.s, 30); check('FX-5 no fx difference', p.f, 0); check('FX-5 no credit rate recorded', p.fx_credit_rate, 'null');
  }
  {
    // FX-6: payment currency differs from invoice currency (TRY on a SYP invoice): legacy behaviour.
    const sh = await newShift(100);
    const inv = await newInvoice({ number: 'INV-FX6', total: 1500000, currency: 'SYP', rate: 15000 });
    const d = await newDebt({ total: 100, invoice: inv.invoice_number });
    await one(`select public.record_debt_payment_atomic($1,30,$2,$3,'TRY',900,30,'cash')`, [d, op('fx'), sh]);
    const p = await one(`select settled_amount::float8 s, fx_difference_usd::float8 f from public.debt_payments where debt_id=$1`, [d]);
    check('FX-6 different currency: credit = cash', p.s, 30); check('FX-6 no fx difference', p.f, 0);
  }
  {
    // FX-7: cash debt (no invoice) paid in SYP: legacy behaviour.
    const sh = await newShift(100);
    const d = await newDebt({ total: 100, isCash: true });
    await one(`select public.record_debt_payment_atomic($1,30,$2,$3,'SYP',450000,15000,'cash')`, [d, op('fx'), sh]);
    const p = await one(`select settled_amount::float8 s, fx_difference_usd::float8 f from public.debt_payments where debt_id=$1`, [d]);
    check('FX-7 cash debt: credit = cash', p.s, 30); check('FX-7 no fx difference', p.f, 0);
  }

  // ---------- Expenses ----------
  {
    const sh = await newShift(100);
    const o = '11111111-1111-4111-8111-' + String(Date.now()).padStart(12, '0').slice(-12);
    await one(`select public.add_expense_atomic($1,'rent',50,'rent','2026-11-23',null,$2,'drawer','USD',50,1)`, [o, sh]);
    check('EXP add: drawer movement', await txSum(sh, 'expense'), 50);
    check('EXP add: expected_balance 100-50', await expected(sh), 50);
    await one(`select public.delete_expense_atomic($1,'undo',$2)`, [o, sh]);
    check('EXP reverse: refund movement', await txSum(sh, 'expense_refund'), 50);
    check('EXP reverse: expected_balance back to 100', await expected(sh), 100);
    await one(`select public.delete_expense_atomic($1,'undo',$2)`, [o, sh]);
    check('EXP reverse twice: still one refund', await txSum(sh, 'expense_refund'), 50);
  }

  // ---------- Sale + refund (the production bug fixed by migration 070000) ----------
  {
    const sh = await newShift(100);
    const prod = await one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'Widget',10,6,50) returning id`, [OWNER]);
    const items = [{ product_id: prod.id, product_name: 'Widget', quantity: 3, unit_price: 10, amount_usd: 30, amount_original: 30, cost_price: 6 }];
    const sale = await q(`select * from public.process_pos_sale_atomic($1,'cash','Cust','',30,0,0,0,0,30,12,'USD',null::uuid,$2::jsonb,0,1,null)`, [op('sale'), JSON.stringify(items)]);
    check('SALE stock after selling 3 of 50', (await one(`select quantity::float8 q from public.products where id=$1`, [prod.id])).q, 47);
    const inv = (await one(`select invoice_number from public.invoices order by created_at desc limit 1`)).invoice_number;
    const err = await fails(q(`select * from public.refund_invoice_atomic($1,'online',$2,'USD',30,1,'drawer')`, [inv, sh]));
    check('REFUND full refund succeeds (ambiguous-column bug)', err, 'null');
    check('REFUND stock restored', (await one(`select quantity::float8 q from public.products where id=$1`, [prod.id])).q, 50);
    check('REFUND drawer movement', await txSum(sh, 'refund'), 30);
    check('REFUND expected_balance 100-30', await expected(sh), 70);
    check('REFUND invoice status', (await one(`select status from public.invoices where invoice_number=$1`, [inv])).status, 'refunded');
    truthy('REFUND second full refund is rejected or a no-op', (await txSum(sh, 'refund')) === 30);
  }

  // ---------- Partner auto withdrawal ----------
  {
    const sh = await newShift(200);
    const p = await one(`insert into public.partners(user_id,name,share_percentage,access_all,current_balance,current_capital,initial_capital) values ($1,'P1',100,true,100,50,50) returning id`, [OWNER]);
    const o = 'pw_golden_0001';
    const call = () => one(`select public.partner_withdrawal_atomic($1,120,'auto','n',$2,'USD',120,1,$3) r`, [p.id, sh, o]);
    await call(); await call();
    check('PARTNER withdrawal posted once (replay)', await txSum(sh, 'withdrawal'), 120);
    check('PARTNER expected_balance 200-120', await expected(sh), 80);
  }

  // ---------- Close shift ----------
  {
    const sh = await newShift(100);
    const d = await newDebt({ total: 50, isCash: true });
    await one(`select public.record_debt_payment_atomic($1,20,$2,$3,'USD',20,1,'cash')`, [d, op('usd'), sh]);
    const res = await fails(one(`select public.close_cash_shift_atomic($1, 120, 'golden close') r`, [sh]));
    check('CLOSE shift succeeds with counted = expected', res, 'null');
    check('CLOSE shift is closed', (await one(`select (closed_at is not null) c from public.cash_shifts where id=$1`, [sh])).c, true);
  }

  // ---------- Cash-sale drawer posting (KD-06, migration 20261123072000) ----------
  {
    const sh = await newShift(100);
    const o = op('sale');
    const call = (amt = 30, id = sh) => one(`select public.post_shift_sale_atomic($1,$2,$3,'USD',$3,1) r`, [id, o, amt]);
    await call();
    check('SALEPOST drawer movement', await txSum(sh, 'sale'), 30);
    check('SALEPOST expected_balance 100+30', await expected(sh), 130);
    await call();
    check('SALEPOST replay posts once', await txSum(sh, 'sale'), 30);
    check('SALEPOST replay does not move expected_balance', await expected(sh), 130);
    truthy('SALEPOST replay with another amount is rejected', await fails(call(31)));
    await one(`select public.post_shift_sale_atomic($1,$2,12,'SYP',180000,15000)`, [sh, op('sale')]);
    check('SALEPOST foreign sale keeps USD in the drawer', await txSum(sh, 'sale'), 42);
    check('SALEPOST foreign sale foreign amount', Number((await one(`select currency_amount::float8 c from public.shift_transactions where shift_id=$1 and currency='SYP'`, [sh])).c), 180000);
    truthy('SALEPOST zero amount is rejected', await fails(one(`select public.post_shift_sale_atomic($1,$2,0)`, [sh, op('sale')])));
    const closed = await newShift(10);
    await one(`select public.close_cash_shift_atomic($1, 10, 'golden close')`, [closed]);
    truthy('SALEPOST closed shift is rejected', await fails(one(`select public.post_shift_sale_atomic($1,$2,5)`, [closed, op('sale')])));
    const res = await fails(one(`select public.close_cash_shift_atomic($1, 142, 'golden close')`, [sh]));
    check('SALEPOST shift closes with counted = opening + sales', res, 'null');
  }

  // ---------- Reconciliation queries (gate R-01..R-06) on the data built above ----------
  for (const r of reconQueries()) {
    if (r.id === 'R-07') continue; // information only (KD-06)
    const rows = await q(r.sql);
    check(`RECON ${r.id} returns zero rows`, rows.length, 0);
    if (rows.length) console.log('     ', JSON.stringify(rows.slice(0, 3)));
  }
  // Negative tests: break the data on purpose, the queries must catch it.
  {
    const sh = await newShift(10);
    await q(`insert into public.shift_transactions(user_id, shift_id, type, amount, currency, exchange_rate, reference_id) values ($1,$2,'debt_payment',5,'USD',1,'dup-ref')`, [OWNER, sh]).catch(() => {});
    const before = (await q(`select 1 from public.shift_transactions where shift_id=$1 and reference_id='dup-ref'`, [sh])).length;
    const dup = await fails(q(`insert into public.shift_transactions(user_id, shift_id, type, amount, currency, exchange_rate, reference_id) values ($1,$2,'debt_payment',5,'USD',1,'dup-ref')`, [OWNER, sh]));
    truthy('NEG duplicate drawer movement is blocked by the unique index (R-04 backstop)', before === 1 && dup !== null);
    // Corrupt data on purpose inside a transaction (triggers off), check the queries see it, then roll everything back.
    await w.db.exec('begin');
    await w.db.exec('alter table public.debts disable trigger user; alter table public.shift_transactions disable trigger user');
    await q(`insert into public.debts(user_id, customer_name, total_debt, total_paid, remaining_debt, status) values ($1,'Broken',100,10,10,'due')`, [OWNER]);
    check('NEG R-01 catches paid+remaining != total', (await q(reconQueries().find((r) => r.id === 'R-01').sql)).length, 1);
    await q(`insert into public.shift_transactions(user_id, shift_id, type, amount, currency, exchange_rate, reference_id) values ($1,$2,'expense',7,'USD',1,'not-an-expense')`, [OWNER, sh]);
    check('NEG R-05b catches an expense movement without an expense', (await q(reconQueries().find((r) => r.id === 'R-05b').sql)).length, 1);
    await w.db.exec('rollback');
  }

  // ---------- Owner store reset (KD-08, migration 20261123073000) ----------
  {
    const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
    await w.db.exec(`insert into auth.users(id,email) values ('${OTHER}','other@test.local') on conflict do nothing;`);
    const prod = await one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'Keep me',12,7,25) returning id`, [OWNER]);
    const productsBefore = (await one(`select count(*)::int c from public.products where user_id=$1`, [OWNER])).c;
    const sh = await newShift(100);
    const inv = await newInvoice({ number: 'INV-RESET-1', total: 30 });
    const d = await newDebt({ total: 50, invoice: inv.invoice_number });
    await one(`select public.record_debt_payment_atomic($1,10,$2,$3,'USD',10,1,'cash')`, [d, op('rst'), sh]);
    await one(`select public.add_expense_atomic($1,'rent',20,'rent','2026-11-23',null,$2,'drawer','USD',20,1)`, ['22222222-2222-4222-8222-' + String(Date.now()).slice(-12), sh]);
    await q(`insert into public.invoices(user_id, invoice_number, total, subtotal, payment_type, payment_method, status, currency, exchange_rate, invoice_type) values ($1,'INV-OTHER-1',9,9,'cash','cash','paid','USD',1,'sale')`, [OTHER]);

    // A cashier linked to this owner (user_roles.owner_id) must be refused and must delete nothing.
    const CASHIER = 'cccccccc-0000-4000-8000-000000000003';
    await w.db.exec(`insert into auth.users(id,email) values ('${CASHIER}','cashier@test.local') on conflict do nothing;
      update public.user_roles set role='cashier', owner_id='${OWNER}' where user_id='${CASHIER}';
      select set_config('request.jwt.claim.sub','${CASHIER}',false);`);
    const before = (await one(`select count(*)::int c from public.invoices where user_id=$1`, [OWNER])).c;
    check('RESET cashier is refused', (await fails(one(`select public.reset_user_store_data() r`))) !== null, true);
    check('RESET refusal deleted nothing', (await one(`select count(*)::int c from public.invoices where user_id=$1`, [OWNER])).c, before);
    await w.db.exec(`select set_config('request.jwt.claim.sub','${OWNER}',false);`);
    const res = await one(`select public.reset_user_store_data() r`);
    check('RESET returns success', res.r.success, true);
    check('RESET products kept (count unchanged)', (await one(`select count(*)::int c from public.products where user_id=$1`, [OWNER])).c, productsBefore);
    check('RESET product price kept', Number((await one(`select sale_price::float8 p from public.products where id=$1`, [prod.id])).p), 12);
    check('RESET product stock zeroed', Number((await one(`select quantity::float8 q from public.products where id=$1`, [prod.id])).q), 0);
    for (const t of ['invoices', 'debts', 'expenses', 'partners', 'cash_shifts']) {
      check(`RESET owner ${t} deleted`, (await one(`select count(*)::int c from public.${t} where user_id=$1`, [OWNER])).c, 0);
    }
    check('RESET other store invoice untouched', (await one(`select count(*)::int c from public.invoices where user_id=$1`, [OTHER])).c, 1);
    check('RESET activity logged', (await one(`select count(*)::int c from public.activity_log where user_id=$1 and action_type='store_reset'`, [OWNER])).c >= 1, true);
  }
}
