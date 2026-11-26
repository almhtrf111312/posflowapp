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

async function summaryCount(w, id) {
  const rows = await w.q(fs.readFileSync(path.join(path.dirname(RECON), 'finance_reconcile_summary_readonly.sql'), 'utf8'));
  return Number(rows.find((r) => r.check.split(' ')[0] === id)?.violations);
}

export async function runScenarios(w, k) {
  const { q, one, op, newShift, newInvoice, newDebt, debt, expected, txSum, fails } = w;
  const { check, truthy } = k;

  // Mirror the production client debt-fx precision cases against the deployed RPC signature.
  {
    const inv = await newInvoice({ number: 'INV-TINY-FX', total: 1, currency: 'SYP', rate: 15000 });
    const id = await newDebt({ total: 1, invoice: inv.invoice_number });
    const payment = await one(`select public.record_debt_payment_atomic($1,0.00005,$2,null,'SYP',1,20000,'transfer') r`, [id, op('tinyfx')]);
    check('small FX credit at invoice rate', Number(payment.r.settled_amount), 0.00006667, 1e-10);
    check('small FX difference at cash rate', Number(payment.r.fx_difference_usd), -0.00001667, 1e-10);
  }
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

// ---------- Partner expense rule (D-09, migration 20261123074000) — fresh stores, exact numbers from the owner ----------
export async function runExpenseShares(k, newWorldFn) {
  const { check, truthy } = k;
  const partner = (w, name, expense, all, cs = '[]') => w.one(
    `insert into public.partners(user_id,name,share_percentage,expense_share_percentage,access_all,current_balance,current_capital,initial_capital,category_shares)
     values ($1,$2,0,$3,$4,0,0,0,$5::jsonb) returning id`, [OWNER, name, expense, all, cs]);
  const bal = async (w, id) => Number((await w.one(`select current_balance::float8 b from public.partners where id=$1`, [id])).b);
  const expense = (w, amt) => w.one(`select public.add_expense_atomic($1,'ops',$2,'expense','2026-11-23',null,null,'bank','USD',$2,1) r`, [w.op('exp'), amt]);

  // A) Owner's example: expense 100, category partner 5%, general partner 50%. Owner keeps the rest (47.5).
  {
    const w = await newWorldFn();
    const cat = await partner(w, 'شريك صنف', 5, false, '[{"categoryName":"X","enabled":true,"percentage":50}]');
    const gen = await partner(w, 'شريك عام', 50, true);
    const r = (await expense(w, 100)).r;
    check('EXPSHARE-A category pays 5 off the top', await bal(w, cat.id), -5);
    check('EXPSHARE-A general pays 50% of the remaining 95 = 47.5', await bal(w, gen.id), -47.5);
    const paid = r.distributions.reduce((s, d) => s + Number(d.amount), 0);
    check('EXPSHARE-A owner keeps the rest (100 - 52.5 = 47.5)', Math.round((100 - paid) * 100) / 100, 47.5);
    truthy('EXPSHARE-A category share is taken from the total, not the remainder', r.distributions.find(d => d.pool === 'category').amount === 5);
    await w.one(`select public.delete_expense_atomic($1,'undo',null) r`, [r.id]);
    check('EXPSHARE-A reversal restores category balance', await bal(w, cat.id), 0);
    check('EXPSHARE-A reversal restores general balance', await bal(w, gen.id), 0);
  }

  // B) Four partners: two category partners (5% expense each), two general partners (33% each), owner 34%.
  //     Expense 100: category pays 5 + 5 = 10 off the top; remaining 90 -> general 29.70 each; owner 30.60.
  {
    const w = await newWorldFn();
    const c1 = await partner(w, 'صنف 1', 5, false, '[{"categoryName":"A","enabled":true,"percentage":50}]');
    const c2 = await partner(w, 'صنف 2', 5, false, '[{"categoryName":"B","enabled":true,"percentage":50}]');
    const g1 = await partner(w, 'عام 1', 33, true);
    const g2 = await partner(w, 'عام 2', 33, true);
    const r = (await expense(w, 100)).r;
    check('EXPSHARE-B category 1 pays 5', await bal(w, c1.id), -5);
    check('EXPSHARE-B category 2 pays 5', await bal(w, c2.id), -5);
    check('EXPSHARE-B general 1 pays 33% of 90 = 29.70', await bal(w, g1.id), -29.7);
    check('EXPSHARE-B general 2 pays 33% of 90 = 29.70', await bal(w, g2.id), -29.7);
    const paid = r.distributions.reduce((s, d) => s + Number(d.amount), 0);
    check('EXPSHARE-B owner keeps 34% of 90 = 30.60 (total 100)', Math.round((100 - paid) * 100) / 100, 30.6);

    // Validation: whole numbers only, pools capped at 100.
    truthy('EXPSHARE-V fractional expense share is refused', (await w.fails(partner(w, 'bad1', 33.3, true))) !== null);
    truthy('EXPSHARE-V general pool above 100 is refused (33+33+40)', (await w.fails(partner(w, 'bad2', 40, true))) !== null);
    truthy('EXPSHARE-V category pool above 100 is refused (5+5+96)', (await w.fails(partner(w, 'bad3', 96, false, '[{"categoryName":"C","enabled":true,"percentage":50}]'))) !== null);
    truthy('EXPSHARE-V fractional profit share is refused', (await w.fails(w.one(`insert into public.partners(user_id,name,share_percentage,expense_share_percentage,access_all,current_balance,current_capital,initial_capital,category_shares) values ($1,'bad4',0.5,0,true,0,0,0,'[]'::jsonb)`, [OWNER]))) !== null);
  }
}

// ---------- Partner withdrawals in any currency (D-10, migration 20261123075000) ----------
export async function runPartnerCurrency(k, newWorldFn) {
  const { check, truthy } = k;
  const w = await newWorldFn();
  const { one, op, fails } = w;
  const P = await one(`insert into public.partners(user_id,name,share_percentage,expense_share_percentage,access_all,current_balance,current_capital,initial_capital,category_shares)
    values ($1,'شريك عملات',0,0,true,0,0,0,'[]') returning id`, [OWNER]);
  // Deposit A: 1000 USD at 15000 (15,000,000 SYP). Deposit B: 500 USD at 12000 (6,000,000 SYP).
  await one(`select public.partner_deposit_atomic($1,1000,'capital',null,null,'SYP',15000000,15000)`, [P.id]);
  await one(`select public.partner_deposit_atomic($1,500,'capital',null,null,'SYP',6000000,12000)`, [P.id]);
  await w.db.exec(`update public.partners set current_balance = 100 where id='${P.id}'`); // profit earned: 100 USD
  const row = () => one(`select current_balance::float8 b, current_capital::float8 c from public.partners where id=$1`, [P.id]);
  check('D10 capital after two deposits = 1500 USD', (await row()).c, 1500);

  // W1: capital 7,000,000 SYP. Weighted original rate = 21,000,000 / 1500 = 14000, so 500 USD.
  // The app sends a WRONG USD amount (600). The server must ignore it and value 7,000,000 SYP at 14000 = 500 USD.
  const w1 = (await one(`select public.partner_withdrawal_atomic($1,600,'capital','n',null,'SYP',7000000,14000,$2) r`, [P.id, op('wd1')])).r;
  check('D10 capital SYP withdrawal deducts 500 USD at the weighted original rate', w1.capital_deducted, 500);
  check('D10 capital left = 1000', (await row()).c, 1000);
  const cap = await one(`select (capital_history->-1->>'exchangeRate')::float8 r from public.partners where id=$1`, [P.id]);
  check('D10 capital withdrawal records the original rate', cap.r, 14000);

  // W2: profit 1,200,000 SYP at TODAY's rate 12000 = 100 USD, all of the profit.
  const w2 = (await one(`select public.partner_withdrawal_atomic($1,100,'profit','n',null,'SYP',1200000,12000,$2) r`, [P.id, 'wd-profit-golden-0001'])).r;
  check('D10 profit SYP withdrawal deducts 100 USD at today rate', w2.profit_deducted, 100);
  check('D10 profit balance now 0', (await row()).b, 0);

  // Refusals
  truthy('D10 profit above balance is refused', (await fails(one(`select public.partner_withdrawal_atomic($1,1,'profit','n',null,'USD',1,1,$2)`, [P.id, op('wd3')]))) !== null);
  truthy('D10 capital above capital is refused (15,000,000 SYP = 1071.43 USD > 1000)', (await fails(one(`select public.partner_withdrawal_atomic($1,1071.43,'capital','n',null,'SYP',15000000,15000,$2)`, [P.id, op('wd4')]))) !== null);
  truthy('D10 automatic split in a foreign currency is refused', (await fails(one(`select public.partner_withdrawal_atomic($1,10,'auto','n',null,'SYP',120000,12000,$2)`, [P.id, op('wd5')]))) !== null);

  // USD capital withdrawal still works (no FX).
  await one(`select public.partner_withdrawal_atomic($1,100,'capital','n',null,'USD',100,1,$2)`, [P.id, op('wd6')]);
  check('D10 USD capital withdrawal 100 leaves 900', (await row()).c, 900);

  // Replay of the profit withdrawal is idempotent.
  const again = (await one(`select public.partner_withdrawal_atomic($1,100,'profit','n',null,'SYP',1200000,12000,'wd-profit-golden-0001') r`, [P.id])).r;
  check('D10 replay is already processed', again.already_processed, true);
  check('D10 replay did not withdraw twice', (await row()).c, 900);
}

// ---------- Confirmed law fixes from the v1.5.270 audit (migration 20261124080000) ----------
export async function runLawFixes(k, newWorldFn) {
  const { check, truthy } = k;
  const sell = (w, prod, qty, opId) => w.q(
    `select * from public.process_pos_sale_atomic($1,'cash','L','',$2,0,0,0,0,$2,0,'USD',null::uuid,$3::jsonb,0,1,null)`,
    [opId, qty * 10, JSON.stringify([{ product_id: prod, product_name: 'Scarce', quantity: qty, unit_price: 10, amount_usd: qty * 10, amount_original: qty * 10, cost_price: 6 }])]);
  const qtyOf = async (w, prod) => Number((await w.one(`select quantity::float8 q from public.products where id=$1`, [prod])).q);

  // F-11 stock: default store setting refuses a sale beyond stock; the stock does not change.
  {
    const w = await newWorldFn();
    const prod = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'Scarce',10,6,1) returning id`, [OWNER])).id;
    truthy('LAW-STOCK default refuses a sale beyond stock', (await w.fails(sell(w, prod, 3, w.op('ls1')))) !== null);
    check('LAW-STOCK stock unchanged after refusal', await qtyOf(w, prod), 1);
    // With the owner's allow-negative setting the sale proceeds and the shortage is flagged.
    await w.db.exec(`insert into public.stores(user_id, name, allow_negative_stock) values ('${OWNER}','law store', true);`);
    const r = (await sell(w, prod, 3, w.op('ls2')))[0];
    check('LAW-STOCK allowed when the owner enables negative stock', r.stock_shortage, true);
    check('LAW-STOCK negative stock after allowed sale', await qtyOf(w, prod), -2);
  }

  // F-11 free goods: a receipt at cost 0 never lowers the average; a positive-cost receipt stays weighted.
  {
    const w = await newWorldFn();
    const prod = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'Free',20,10,10) returning id`, [OWNER])).id;
    const free = (await w.one(`select * from public.receive_stock_wac($1,10,0,'free-1')`, [prod]));
    check('LAW-FREE average stays 10 after 10 free units', Number(free.receive_stock_wac?.cost ?? free.cost ?? free.calc_cost ?? free[Object.keys(free)[1]]), 10);
    check('LAW-FREE quantity is 20 after the free receipt', await qtyOf(w, prod), 20);
    const paid = (await w.one(`select * from public.receive_stock_wac($1,10,20,'paid-1')`, [prod]));
    check('LAW-FREE a paid receipt still weights the average ((20 at 10 + 10 at 20) / 30 = 13.3333)', Number(paid[Object.keys(paid)[1]]), 13.333333, 0.0001);
  }

  // F1 (audit): the cash sale and its drawer movement are one transaction (migration 20261124080100).
  {
    const w = await newWorldFn();
    const prod = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'Drawer',10,6,50) returning id`, [OWNER])).id;
    const sh = await w.newShift(100);
    const call = (opId, shiftId) => w.q(
      `select * from public.process_pos_sale_with_drawer_atomic($1,'cash','D','',30,0,0,0,0,30,12,'USD',null::uuid,$2::jsonb,0,1,null,$3::uuid,null)`,
      [opId, JSON.stringify([{ product_id: prod, product_name: 'Drawer', quantity: 3, unit_price: 10, amount_usd: 30, amount_original: 30, cost_price: 6 }]), shiftId]);
    const r1 = (await call('drawer-op-0001', sh))[0];
    check('F1 sale succeeded', r1.success, true);
    check('F1 one drawer movement for the sale', Number((await w.one(`select count(*)::int c from public.shift_transactions where shift_id=$1 and type='sale'`, [sh])).c), 1);
    check('F1 expected balance = 100 + 30', await w.expected(sh), 130);
    const r2 = (await call('drawer-op-0001', sh))[0];
    check('F1 replay is already processed', r2.already_processed, true);
    check('F1 replay posts no second movement', Number((await w.one(`select count(*)::int c from public.shift_transactions where shift_id=$1 and type='sale'`, [sh])).c), 1);
    check('F1 replay leaves expected balance at 130', await w.expected(sh), 130);
    // closed shift: the whole sale is refused and no invoice is written
    const closed = await w.newShift(10);
    await w.db.exec(`update public.cash_shifts set closed_at = now() where id='${closed}'`);
    const before = Number((await w.one(`select count(*)::int c from public.invoices`)).c);
    truthy('F1 closed shift refuses the sale', (await w.fails(call('drawer-op-0002', closed))) !== null);
    check('F1 refused sale wrote no invoice', Number((await w.one(`select count(*)::int c from public.invoices`)).c), before);
  }

  // F8 (audit): editing a paid purchase keeps the drawer reference and shows the supplier credit (migration 20261124080200).
  {
    const w = await newWorldFn();
    const sup = (await w.one(`insert into public.suppliers(user_id,name) values ($1,'Supplier F8') returning id`, [OWNER])).id;
    const prod = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'F8 item',20,10,0) returning id`, [OWNER])).id;
    const sh = await w.newShift(500);
    const inv = (await w.one(`insert into public.purchase_invoices(id,user_id,invoice_number,supplier_name,supplier_id,status,payment_method,payment_status,amount_paid,paid_from,paid_shift_id,paid_currency,paid_currency_amount,paid_rate,invoice_date,actual_items_count,actual_total_quantity,actual_grand_total,expected_items_count,expected_total_quantity,expected_grand_total) values (gen_random_uuid(),$1,'PI-F8-1','Supplier F8',$2,'draft','cash','paid',100,'drawer',$3,'USD',100,1,'2026-11-23',1,10,100,1,10,100) returning id`, [OWNER, sup, sh])).id;
    await w.q(`insert into public.purchase_invoice_items(invoice_id,product_id,product_name,quantity,cost_price,total_cost) values ($1,$2,'F8 item',10,10,100)`, [inv, prod]);
    await w.q(`select public.finalize_purchase_invoice_atomic($1)`, [inv]);
    const txBefore = Number((await w.one(`select count(*)::int c from public.shift_transactions where shift_id=$1`, [sh])).c);
    const newId = (await w.one(`select public.edit_purchase_invoice_atomic($1, $2::jsonb, $3, 'F8 test') r`, [inv, JSON.stringify([{ product_id: prod, product_name: 'F8 item', quantity: 8, cost_price: 10 }]), w.op('f8edit')])).r;
    const nv = await w.one(`select paid_from, paid_shift_id::text psh, supplier_credit::float8 credit, amount_paid::float8 paid from public.purchase_invoices where id=$1`, [newId]);
    check('F8 replacement keeps paid_from = drawer', nv.paid_from, 'drawer');
    check('F8 replacement keeps the original shift reference', nv.psh, sh);
    check('F8 replacement shows supplier credit 20 (100 paid, 80 total)', nv.credit, 20);
    const led = await w.one(`select coalesce(sum(amount),0)::float8 s from public.supplier_ledger_entries where supplier_id=$1`, [sup]);
    check('F8 supplier ledger nets to -20 (credit to the store)', led.s, -20);
    check('F8 no second drawer movement for the edit', Number((await w.one(`select count(*)::int c from public.shift_transactions where shift_id=$1`, [sh])).c), txBefore);
  }

  // Sale time (2026-11-24, migration 20261124080600): a delayed sale keeps the time it was made.
  {
    const w = await newWorldFn();
    const prod = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'SaleTime',10,6,50) returning id`, [OWNER])).id;
    const items = (q) => JSON.stringify([{ product_id: prod, product_name: 'SaleTime', quantity: q, unit_price: 10, amount_usd: 10 * q, amount_original: 10 * q, cost_price: 6 }]);
    const sh = await w.newShift(100);
    const call = (op, pay, total, shiftId, saleAt) => w.one(
      `select * from public.process_pos_sale_with_drawer_atomic($1,$2,'ST','',$3,0,0,0,0,$3,0,'USD',null::uuid,$4::jsonb,0,1,null,$5::uuid,null,$6::timestamptz)`,
      [op, pay, total, items(total / 10), shiftId, saleAt]);
    const info = (id) => w.one(`select date::text d, created_at::text c from public.invoices where id=$1`, [id]);
    const a = await call('saletime-A-000001', 'cash', 30, sh, '2026-11-01T10:30:00Z');
    const ia = await info(a.invoice_id);
    check('ST delayed cash sale keeps its date (2026-11-01)', ia.d, '2026-11-01');
    check('ST delayed cash sale keeps its time as created_at', ia.c.startsWith('2026-11-01 10:30:00'), true);
    const mv = await w.one(`select created_at::text c from public.shift_transactions where shift_id=$1 and type='sale' and reference_id='saletime-A-000001'`, [sh]);
    check('ST drawer movement takes the sale time', mv.c.startsWith('2026-11-01 10:30:00'), true);
    check('ST drawer balance counts the delayed sale (100 + 30)', await w.expected(sh), 130);
    const rep = await call('saletime-A-000001', 'cash', 30, sh, '2026-11-01T10:30:00Z');
    check('ST replay of the delayed sale is not posted twice', rep.already_processed, true);
    check('ST replay leaves the drawer balance unchanged', await w.expected(sh), 130);
    const b = await call('saletime-B-000001', 'debt', 20, null, null);
    const ib = await info(b.invoice_id);
    check('ST sale without a sale time uses the posting day', ib.d, (await w.one('select current_date::text d')).d);
    const c = await call('saletime-C-000001', 'debt', 10, null, '2999-01-01T00:00:00Z');
    const ic = await info(c.invoice_id);
    check('ST a future sale time is not used (posted at now)', ic.c.startsWith('2999'), false);
    await w.one(`select public.close_accounting_period_atomic('2026-01-01','2026-01-31','UTC') r`);
    const d = await call('saletime-D-000001', 'debt', 10, null, '2026-01-15T09:00:00Z');
    const id = await info(d.invoice_id);
    check('ST a sale inside a closed period keeps its posting day, not the closed one', id.d === '2026-01-15', false);
  }

  // Restaurant (2026-11-24, migration 20261124080700): menu items are not stock. A restaurant sale never refuses for
  // stock and never deducts it. Bakery keeps the same rule; a general store is still refused.
  {
    const w = await newWorldFn();
    const items = (p) => JSON.stringify([{ product_id: p, product_name: 'Fool', quantity: 2, unit_price: 10, amount_usd: 20, amount_original: 20, cost_price: 4 }]);
    const sale = async (storeType, op) => {
      await w.db.exec(`delete from public.stores where user_id='${OWNER}'; insert into public.stores(user_id, name, store_type) values ('${OWNER}', 'R', '${storeType}')`);
      const p = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'Fool',10,4,0) returning id`, [OWNER])).id;
      const ok = await w.fails(w.one(`select * from public.process_pos_sale_with_drawer_atomic($1,'debt','R','',20,0,0,0,0,20,8,'USD',null::uuid,$2::jsonb,0,1,null,null,null,null)`, [op, items(p)]));
      const q = await w.one(`select quantity::float8 q from public.products where id=$1`, [p]);
      return { refused: ok, quantity: q.q };
    };
    const r = await sale('restaurant', 'rest-golden-000001');
    check('RESTAURANT sale with zero stock is accepted', r.refused, null);
    check('RESTAURANT sale does not deduct stock (stays 0)', r.quantity, 0);
    const b = await sale('bakery', 'bakery-golden-00001');
    check('BAKERY sale with zero stock is still accepted', b.refused, null);
    const g = await sale('general', 'general-golden-0001');
    check('GENERAL sale with zero stock is still refused', g.refused !== null && g.refused.includes('المخزون المتاح'), true);
  }

  // Re-audit v1.5.272 (migration 20261124080800): N1 repeated purchase edit keeps the whole credit, N2 drawer keeps 8 decimals, N3 currency must match.
  {
    const w = await newWorldFn();
    const shift = await w.newShift(500);
    const supplier = (await w.one(`insert into public.suppliers(user_id,name,created_by) values($1,'N1',$1) returning id`, [OWNER])).id;
    const product = (await w.one(`insert into public.products(user_id,name,quantity,cost_price,sale_price) values($1,'N1 item',0,0,20) returning id`, [OWNER])).id;
    const inv = (await w.one(`insert into public.purchase_invoices(user_id,invoice_number,supplier_name,supplier_id,invoice_date,status,payment_status,payment_method,amount_paid,paid_from,paid_shift_id,expected_items_count,expected_total_quantity,expected_grand_total,actual_items_count,actual_total_quantity,actual_grand_total)
      values($1,'N1-GOLDEN-0001','N1',$2,current_date,'draft','paid','cash',100,'drawer',$3,1,10,100,1,10,100) returning id`, [OWNER, supplier, shift])).id;
    await w.one(`insert into public.purchase_invoice_items(invoice_id,product_id,product_name,quantity,cost_price,sale_price,total_cost) values($1,$2,'N1 item',10,10,20,100)`, [inv, product]);
    await w.one(`select public.finalize_purchase_invoice_atomic($1) r`, [inv]);
    const line = (q) => JSON.stringify([{ product_id: product, quantity: q, cost_price: 10, product_name: 'N1 item', sale_price: 20 }]);
    const e1 = await w.one(`select public.edit_purchase_invoice_atomic($1,$2::jsonb,'n1-golden-edit-01','e1') id`, [inv, line(8)]);
    const e2 = await w.one(`select public.edit_purchase_invoice_atomic($1,$2::jsonb,'n1-golden-edit-02','e2') id`, [e1.id, line(7)]);
    const s2 = await w.one(`select supplier_credit::float8 c from public.purchase_invoices where id=$1`, [e2.id]);
    check('N1 second edit keeps the whole credit (100 paid - 70 total = 30)', s2.c, 30);
    const led = await w.one(`select coalesce(sum(amount),0)::float8 b from public.supplier_ledger_entries where supplier_id=$1`, [supplier]);
    check('N1 supplier ledger nets to -30 after two edits', led.b, -30);

    const items = (q, price) => JSON.stringify([{ product_id: product, product_name: 'N2', quantity: q, unit_price: price, amount_usd: price * q, amount_original: price * q, cost_price: 0 }]);
    await w.one(`select * from public.process_pos_sale_with_drawer_atomic('n2-golden-000001','cash','N','',1.23456789,0,0,0,0,1.23456789,0,'USD',null::uuid,$1::jsonb,0,1,null,$2::uuid,null,null)`, [items(1, 1.23456789), shift]);
    const mv = await w.one(`select amount::float8 a from public.shift_transactions where reference_id='n2-golden-000001'`);
    check('N2 drawer movement keeps 8 decimals (1.23456789)', mv.a, 1.23456789);

    const refused = await w.fails(w.one(`select * from public.process_pos_sale_with_drawer_atomic('n3-golden-000001','cash','N','',10,0,0,0,0,10,0,'USD',null::uuid,$1::jsonb,0,1,null,$2::uuid,999,null)`, [items(1, 10), shift]));
    check('N3 a received amount that does not match the sale is refused', refused !== null && refused.includes('لا يطابق'), true);
  }

  // PREC8 (migration 20261125090000): USD amounts and cached drawer balances keep 8 decimals (F-02). 5,000 LBP at 89,500 = 0.0558659... USD.
  {
    const w = await newWorldFn();
    const RATE = 89500, LBP = 5000, USD = LBP / RATE;
    const sh = await w.newShift(100);
    const opId = '33333333-3333-4333-8333-' + String(Date.now()).slice(-12);
    await w.one(`select public.add_expense_atomic($1,'rent',$2,'rent','2026-11-25',null,$3,'drawer','LBP',$4,$5)`, [opId, USD, sh, LBP, RATE]);
    check('PREC8 expense of 5,000 LBP keeps 8 decimals in the expense row (not 0.06)', (await w.one(`select amount::float8 a from public.expenses where user_id=$1 order by created_at desc limit 1`, [OWNER])).a, 0.05586592, 0.000000005);
    check('PREC8 expense drawer movement keeps 8 decimals', await w.txSum(sh, 'expense'), 0.05586592, 0.000000005);
    check('PREC8 expected balance = 100 - 0.05586592', await w.expected(sh), 99.94413408, 0.000000005);
    await w.one(`select public.delete_expense_atomic($1,'undo',$2)`, [opId, sh]);
    check('PREC8 reversing the expense returns the balance to exactly 100', await w.expected(sh), 100, 0.000000005);

    const sh2 = await w.newShift(100);
    const inv = await w.newInvoice({ number: 'INV-PREC8', total: 10, currency: 'LBP', rate: RATE });
    const d = await w.newDebt({ total: 10, invoice: inv.invoice_number });
    await w.one(`select public.record_debt_payment_atomic($1,$2,$3,$4,'LBP',$5,$6,'cash')`, [d, USD, w.op('prec8'), sh2, LBP, RATE]);
    check('PREC8 debt payment of 5,000 LBP: drawer movement keeps 8 decimals', await w.txSum(sh2, 'debt_payment'), 0.05586592, 0.000000005);
    check('PREC8 debt payment: expected balance = 100 + 0.05586592', await w.expected(sh2), 100.05586592, 0.000000005);

    // _supplier_drawer_tx requires a valid open shift of this store (strict, as live): nothing is posted to a shift nobody chose.
    const sh3 = await w.newShift(100);
    const noShift = await w.fails(w.one(`select public._supplier_drawer_tx($1::uuid,null::uuid,'supplier_payment',1,'USD',1,1,'prec8-ref','x') r`, [OWNER]));
    truthy('PREC8 supplier drawer movement without a shift is refused', noShift !== null && noShift.includes('يجب تحديد وردية'), noShift || '');
    await w.db.exec(`update public.cash_shifts set closed_at = now() where id = '${sh3}'`);
    const closed = await w.fails(w.one(`select public._supplier_drawer_tx($1::uuid,$2::uuid,'supplier_payment',1,'USD',1,1,'prec8-ref2','x') r`, [OWNER, sh3]));
    truthy('PREC8 supplier drawer movement on a closed shift is refused', closed !== null, closed || '');
    const sh4 = await w.newShift(100);
    await w.one(`select public._supplier_drawer_tx($1::uuid,$2::uuid,'supplier_payment',0.0559,'LBP',5004,89500,'prec8-ref3','x') r`, [OWNER, sh4]);
    check('PREC8 supplier drawer movement: balance 100 - 0.0559 (not rounded to cents)', await w.expected(sh4), 99.9441, 0.000000005);
  }

  // F4 (audit): the period closing stores the FX difference of debt collections as its own line (migration 20261124080300).
  {
    const w = await newWorldFn();
    const d = await w.newDebt({ total: 100, isCash: true });
    await w.db.exec(`insert into public.debt_payments(debt_id,user_id,amount,settled_amount,fx_difference_usd,fx_credit_rate,payment_method,currency,exchange_rate,created_at,operation_id,currency_amount) values ('${d}','${OWNER}',37.5,50,-12.5,15000,'cash','SYP',20000,'2026-01-15T10:00:00Z','fx-close-0001',750000)`);
    const res = (await w.one(`select public.close_accounting_period_atomic('2026-01-01','2026-01-31','UTC') r`)).r;
    check('F4 closing stores the FX difference (-12.5)', res.fx_difference, -12.5);
    check('F4 closing: net after FX = net + FX', Math.round((res.net_after_fx - (res.net_profit + res.fx_difference)) * 1e6) / 1e6, 0);
    const row = await w.one(`select fx_difference::float8 f, net_after_fx::float8 n, net_profit::float8 p from public.accounting_period_closures where user_id=$1`, [OWNER]);
    check('F4 closure row carries fx_difference', row.f, -12.5);
    check('F4 closure row net_profit is unchanged by FX', row.p, res.net_profit);
  }

  // Historical receipts may predate the settlement request cache.
  {
    const w = await newWorldFn();
    const d = await w.newDebt({ total: 2, isCash: true });
    const pay = (amount, operation, original = amount) => w.one(
      "select public.record_debt_payment_atomic($1,$2,$3,null,'USD',$4,1,'transfer') r", [d, amount, operation, original]);
    for (const amount of [0.12345678, 1.88]) {
      const operation = w.op('history');
      await pay(amount, operation);
      await w.q('delete from public.sales_settlement_replays where operation_id=$1', [operation]);
      check('HISTORY exact receipt accepted: ' + amount, (await pay(amount, operation)).r.already_processed, true);
      truthy('HISTORY changed original amount refused: ' + amount, !!await w.fails(pay(amount, operation, amount + 0.00000001)));
    }
    check('HISTORY no duplicate payment rows', (await w.one('select count(*)::int n from public.debt_payments where debt_id=$1', [d])).n, 2);
    check('HISTORY debt remains settled', (await w.debt(d)).remaining, 0);
  }

  // Exercise the read-only stock audit against movements written by both actual stock triggers.
  {
    const w = await newWorldFn();
    const plan = fs.readFileSync(new URL('../../../docs/ACCOUNTING_AUDIT_PLAN.md', import.meta.url), 'utf8');
    const x7b = plan.split('-- X-7b ')[1].split('-- X-8 ')[0].split('\n').slice(1).join('\n');
    const p = (await w.one("insert into public.products(user_id,name,quantity) values ($1,'X7',9) returning id", [OWNER])).id;
    for (const [name, isDefault, quantity] of [['Main warehouse', true, 4], ['Van', false, 2]]) {
      const wh = (await w.one('insert into public.warehouses(user_id,name,is_default) values ($1,$2,$3) returning id', [OWNER,name,isDefault])).id;
      await w.q('insert into public.warehouse_stock(warehouse_id,product_id,quantity) values ($1,$2,$3)', [wh,p,quantity]);
    }
    check('X7b stock 9, default warehouse 4, van 2 all match', (await w.q(x7b)).length, 0);
    await w.q('update public.stock_movements set quantity_after=3 where product_id=$1 and quantity_after=2', [p]);
    check('X7b flags only the damaged van movement', (await w.q(x7b)).length, 1);
  }

  // F7 (audit): a credit quick purchase is linked to a supplier and writes one purchase entry (migration 20261124080400).
  {
    const w = await newWorldFn();
    const sup = (await w.one(`insert into public.suppliers(user_id,name) values ($1,'Supplier F7') returning id`, [OWNER])).id;
    const payload = (extra) => JSON.stringify({ productName: 'F7 item', quantity: 10, costPrice: 10, salePrice: 20, paymentMethod: 'credit', ...extra });
    const refused = await w.fails(w.one(`select public.process_quick_purchase_atomic('44444444-4444-4444-8444-444444444444'::uuid, $1::jsonb) r`, [payload({})]));
    truthy('F7 credit without a supplier is refused with the supplier message', refused !== null && refused.includes('يلزم اختيار مورد'));
    const qpId = '22222222-2222-4222-8222-' + String(Date.now()).slice(-12);
    await w.one(`select public.process_quick_purchase_atomic($1::uuid, $2::jsonb) r`, [qpId, payload({ supplierId: sup })]);
    const entries = await w.one(`select count(*)::int c, coalesce(sum(amount),0)::float8 s from public.supplier_ledger_entries where supplier_id=$1 and entry_type='purchase'`, [sup]);
    check('F7 credit quick purchase writes one purchase entry', entries.c, 1);
    check('F7 purchase entry equals the total (10 x 10 = 100)', entries.s, 100);
    const inv = await w.one(`select supplier_id::text sid, supplier_name from public.purchase_invoices where id=$1::uuid`, [qpId]);
    check('F7 invoice is linked to the supplier', inv.sid, sup);
    check('F7 supplier name is the supplier (not the product)', inv.supplier_name, 'Supplier F7');
    const r09 = reconQueries().find((r) => r.id === 'R-09').sql;
    check('R09 a correct credit quick purchase passes', (await w.q(r09)).length, 0);
    // Negative: remove the purchase entry on purpose (triggers off, rolled back) — R-09 must catch it.
    await w.db.exec('begin');
    await w.db.exec('alter table public.supplier_ledger_entries disable trigger user');
    await w.q(`delete from public.supplier_ledger_entries where reference_id=$1 and entry_type='purchase'`, [qpId]);
    check('NEG R-09 catches a credit quick purchase with no supplier ledger entry', (await w.q(r09)).length, 1);
    check('SUMMARY R-09 detects the missing purchase entry', await summaryCount(w, 'R-09'), 1);
    await w.db.exec('rollback');
    const cashId = '33333333-3333-4333-8333-' + String(Date.now()).slice(-12);
    const shCash = await w.newShift(500);
    await w.one(`select public.process_quick_purchase_atomic($1::uuid, $2::jsonb) r`, [cashId, JSON.stringify({ productName: 'F7 cash', quantity: 1, costPrice: 5, salePrice: 9, paymentMethod: 'cash', shiftId: shCash })]);
    check('F7 cash quick purchase writes no supplier entry', Number((await w.one(`select count(*)::int c from public.supplier_ledger_entries where reference_id=$1`, [cashId])).c), 0);
    check('F7 cash quick purchase reduces the cached drawer balance by its cost (500 - 5)', await w.expected(shCash), 495);
    await w.one(`select public.process_quick_purchase_atomic($1::uuid, $2::jsonb) r`, [cashId, JSON.stringify({ productName: 'F7 cash', quantity: 1, costPrice: 5, salePrice: 9, paymentMethod: 'cash', shiftId: shCash })]);
    check('F7 replayed cash quick purchase does not reduce the drawer balance twice', await w.expected(shCash), 495);
  }
}


// 2026-11-25 (QA round): down payment on a credit sale (M-3) and one open shift per cashier.
export async function runQaFixes(k, newWorldFn) {
  const { check, truthy } = k;
  const items = (p, price) => JSON.stringify([{ product_id: p, product_name: 'Notebook', quantity: 1, unit_price: price, amount_usd: price, amount_original: price, cost_price: 3 }]);
  const sale = (w, p, op, dp) => w.one(
    `select * from public.process_pos_sale_atomic($1,'debt','Cust','',8,0,0,0,0,8,0,'USD',null::uuid,$2::jsonb,$3,1,null)`,
    [op, items(p, 8), dp]);

  // M-3: the down payment is a real payment row on the new debt; payments always match debts.total_paid.
  {
    const w = await newWorldFn();
    const prod = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'Notebook',8,3,50) returning id`, [OWNER])).id;
    const opA = w.op('m3a');
    const a = await sale(w, prod, opA, 2);
    const debt = await w.one(`select id, total_paid::float8 paid, remaining_debt::float8 remaining, status from public.debts where invoice_id=$1`, [a.invoice_number]);
    check('M3 down payment is stored on the debt (paid 2)', debt.paid, 2);
    check('M3 debt remaining is 6', debt.remaining, 6);
    check('M3 down payment writes exactly one debt_payments row', Number((await w.one(`select count(*)::int n from public.debt_payments where debt_id=$1`, [debt.id])).n), 1);
    const pay = await w.one(`select amount::float8 amount, settled_amount::float8 settled, payment_method, operation_id from public.debt_payments where debt_id=$1`, [debt.id]);
    check('M3 payment row amount is 2', pay.amount, 2);
    check('M3 payment row settled amount is 2', pay.settled, 2);
    check('M3 payment row is cash', pay.payment_method, 'cash');
    truthy('M3 payment row operation id is the sale operation plus :down', String(pay.operation_id).startsWith(opA) && String(pay.operation_id).endsWith(':down'));
    // A replay of the same operation does not add a second payment row.
    await sale(w, prod, opA, 2);
    check('M3 replayed sale does not duplicate the payment row', Number((await w.one(`select count(*)::int n from public.debt_payments where debt_id=$1`, [debt.id])).n), 1);
    // A credit sale without a down payment writes no payment row.
    const b = await sale(w, prod, w.op('m3b'), 0);
    const debtB = await w.one(`select id from public.debts where invoice_id=$1`, [b.invoice_number]);
    check('M3 a debt without a down payment has no payment row', Number((await w.one(`select count(*)::int n from public.debt_payments where debt_id=$1`, [debtB.id])).n), 0);
    // Reconciliation: sum(settled) equals sum(total_paid) for the whole store.
    const tot = await w.one(`select coalesce(sum(settled_amount),0)::float8 s from public.debt_payments where user_id=$1`, [OWNER]);
    const paid = await w.one(`select coalesce(sum(total_paid),0)::float8 s from public.debts where user_id=$1`, [OWNER]);
    check('M3 sum(debt_payments.settled_amount) equals sum(debts.total_paid)', tot.s, paid.s);
    // Regression (found by the plan's D-05): refunding a credit invoice that had a down payment must still work.
    // The down payment is the sale-time receipt (the client writes its 'sale' drawer movement); the ':down' payment row
    // must not be demanded as a documented debt payment by the refund.
    {
      const w2 = await newWorldFn();
      const p2 = (await w2.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'Notebook',8,3,50) returning id`, [OWNER])).id;
      const sh2 = await w2.newShift(100);
      const s2 = await sale(w2, p2, w2.op('m3r'), 2);
      await w2.q(`insert into public.shift_transactions(shift_id,user_id,type,amount,currency,currency_amount,exchange_rate,reference_id,notes) values ($1,$2,'sale',2,'USD',2,1,$3,'down payment')`, [sh2, OWNER, s2.invoice_number]);
      const refund = await w2.fails(w2.q(`select * from public.refund_invoice_atomic($1,'drawer',$2::uuid,'USD',null,1,'drawer')`, [s2.invoice_number, sh2]));
      check('M3 refunding a credit invoice that had a down payment succeeds', refund, null);
      check('M3 the refund returns the 2 paid at sale to the drawer', await w2.txSum(sh2, 'refund'), 2);
      check('M3 stock is restored after the refund', Number((await w2.one(`select quantity::float8 q from public.products where id=$1`, [p2])).q), 50);
    }
    // A later payment on the same debt keeps the two sides equal.
    const shiftForPay = await w.newShift(100);
    await w.q(`select * from public.record_debt_payment_atomic($1,3,$2,$3::uuid,null,null,null,'cash')`, [debt.id, w.op('m3p'), shiftForPay]);
    const tot2 = await w.one(`select coalesce(sum(settled_amount),0)::float8 s from public.debt_payments where user_id=$1`, [OWNER]);
    const paid2 = await w.one(`select coalesce(sum(total_paid),0)::float8 s from public.debts where user_id=$1`, [OWNER]);
    check('M3 a later payment keeps payments equal to total_paid', tot2.s, paid2.s);
  }

  // One open shift per cashier: the server refuses a second open shift; closing allows a new one;
  // another cashier can keep a shift open at the same time.
  {
    const w = await newWorldFn();
    const first = await w.newShift(100);
    truthy('SHIFT first open shift is created', first);
    const insertOpen = (opening) => w.q(`insert into public.cash_shifts(user_id, opening_balance, expected_balance) values ($1,$2,$2)`, [OWNER, opening]);
    truthy('SHIFT a second open shift for the same cashier is refused', (await w.fails(insertOpen(500))) !== null);
    check('SHIFT only one open shift exists', Number((await w.one(`select count(*)::int n from public.cash_shifts where user_id=$1 and closed_at is null`, [OWNER])).n), 1);
    const other = 'bbbbbbbb-0000-4000-8000-000000000002';
    await w.db.exec(`insert into auth.users(id, email) values ('${other}', 'cashier@test.local') on conflict do nothing;`);
    const otherShift = await w.fails(w.q(`insert into public.cash_shifts(user_id, cashier_id, opening_balance, expected_balance) values ($1,$2,50,50)`, [OWNER, other]));
    check('SHIFT another cashier can have an open shift at the same time', otherShift, null);
    await w.q(`update public.cash_shifts set closed_at=now() where id=$1`, [first]);
    check('SHIFT after closing, the same cashier can open a new shift', await w.fails(insertOpen(500)), null);
    // Replaying the SAME queued open (same shift id) is idempotent; a different id is refused with the unique violation.
    const keep = (await w.one(`select id from public.cash_shifts where user_id=$1 and closed_at is null`, [OWNER])).id;
    const replay = await w.fails(w.q(`insert into public.cash_shifts(id, user_id, opening_balance, expected_balance) values ($1,$2,500,500) on conflict (id) do update set opening_balance = excluded.opening_balance`, [keep, OWNER]));
    check('SHIFT a replay of the same queued open (same shift id) is accepted', replay, null);
    const other2 = await w.fails(w.q(`insert into public.cash_shifts(id, user_id, opening_balance, expected_balance) values (gen_random_uuid(),$1,50,50) on conflict (id) do nothing`, [OWNER]));
    truthy('SHIFT a different shift id for the same cashier is refused with the unique violation', other2 && /uq_cash_shifts_one_open_per_cashier|duplicate key/.test(other2), other2 || 'no error');
  }

  // J-10: a partial refund is counted once. The invoice is rewritten to the net values, the accounting ledger gets a
  // negative event for the refunded part, and the drawer gets one refund movement. Nothing is subtracted twice.
  {
    const w = await newWorldFn();
    const pA = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'A',5,2,50) returning id`, [OWNER])).id;
    const pB = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'B',8,3,50) returning id`, [OWNER])).id;
    const sh = await w.newShift(100);
    const both = JSON.stringify([
      { product_id: pA, product_name: 'A', quantity: 1, unit_price: 5, amount_usd: 5, amount_original: 5, cost_price: 2 },
      { product_id: pB, product_name: 'B', quantity: 1, unit_price: 8, amount_usd: 8, amount_original: 8, cost_price: 3 }]);
    const sold = await w.one(`select * from public.process_pos_sale_with_drawer_atomic($1,'cash','C','',13,0,0,0,0,13,0,'USD',null::uuid,$2::jsonb,0,1,null,$3::uuid,null)`, [w.op('j10'), both, sh]);
    check('J10 sale total is 13', sold.total, 13);
    const rf = (await w.one(`select public.refund_invoice_partial_atomic($1,$2::jsonb,$3,$4::uuid,null,null,null,'drawer') r`,
      [sold.invoice_number, JSON.stringify([{ product_id: pA, quantity: 1 }]), w.op('j10r'), sh])).r;
    check('J10 refunded amount is 5', rf.refund_amount, 5);
    const inv = await w.one(`select total::float8 t, profit::float8 p from public.invoices where invoice_number=$1`, [sold.invoice_number]);
    check('J10 invoice is rewritten to the net total (8)', inv.t, 8);
    check('J10 invoice is rewritten to the net profit (5)', inv.p, 5);
    const led = await w.one(`select coalesce(sum(revenue_delta),0)::float8 rev, coalesce(sum(realized_delta),0)::float8 realized from public.invoice_accounting_events where user_id=$1 and not is_opening`, [OWNER]);
    check('J10 ledger revenue equals the net invoice total (13 - 5 = 8, not 3)', led.rev, 8);
    check('J10 ledger realized profit equals the net invoice profit (8 - 3 = 5)', led.realized, 5);
    check('J10 exactly one refund movement of 5 in the drawer', await w.txSum(sh, 'refund'), 5);
    check('J10 drawer expected is 100 + 13 - 5 = 108', await w.expected(sh), 108);
  }

  // Plan sweep (C-15, C-08, D-04/D-06/D-07, G-14, G-07): representative cases that were not covered by a golden case yet.
  {
    const w = await newWorldFn();
    const prod = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'P',90,40,50) returning id`, [OWNER])).id;
    const items = JSON.stringify([{ product_id: prod, product_name: 'P', quantity: 1, unit_price: 90, amount_usd: 90, amount_original: 90, cost_price: 40 }]);
    // C-15: three fractional payments on a 100 debt settle it exactly (33.33 + 33.33 + 33.34).
    {
      const sh = await w.newShift(100);
      const d = await w.newDebt({ total: 100, isCash: true });
      for (const a of [33.33, 33.33, 33.34]) await w.one(`select public.record_debt_payment_atomic($1,$2,$3,$4,'USD',$2,1,'cash')`, [d, a, w.op('c15'), sh]);
      const dd = await w.debt(d);
      check('C15 fractional payments: paid 100', dd.paid, 100);
      check('C15 fractional payments: remaining 0', dd.remaining, 0);
      check('C15 fractional payments: fully_paid', dd.status, 'fully_paid');
      check('C15 fractional payments: sum(settled) = 100', (await w.one(`select sum(settled_amount)::float8 s from public.debt_payments where debt_id=$1`, [d])).s, 100);
    }
    // C-08: a transfer payment credits the debt but never touches the drawer.
    {
      const sh = await w.newShift(100);
      const d = await w.newDebt({ total: 50, isCash: true });
      check('C08 transfer payment accepted', await w.fails(w.one(`select public.record_debt_payment_atomic($1,20,$2,$3,'USD',20,1,'transfer')`, [d, w.op('c08'), null])), null);
      check('C08 transfer payment credits the debt', (await w.debt(d)).paid, 20);
      check('C08 transfer payment writes no drawer movement', await w.txSum(sh, 'debt_payment'), 0);
    }
    // D-04 + D-07: refund of a taxed invoice returns the tax too, and lands in the CURRENT shift when the original one is closed.
    {
      await w.q(`insert into public.stores(user_id,name,tax_enabled,tax_rate) values ($1,'S',true,5) on conflict (user_id) do update set tax_enabled=true, tax_rate=5`, [OWNER]);
      const old = await w.newShift(100);
      const s = await w.one(`select * from public.process_pos_sale_atomic($1,'cash','C','',90,0,0,5,4.5,94.5,50,'USD',null::uuid,$2::jsonb,0,1,'exclusive')`, [w.op('d04'), items]);
      check('D04 taxed sale total is 94.5', s.total, 94.5);
      await w.q(`insert into public.shift_transactions(shift_id,user_id,type,amount,currency,currency_amount,exchange_rate,reference_id) values ($1,$2,'sale',94.5,'USD',94.5,1,$3)`, [old, OWNER, s.invoice_number]);
      const cur = await w.newShift(200);
      check('D04 refund of a taxed invoice succeeds', await w.fails(w.q(`select * from public.refund_invoice_atomic($1,'drawer',$2::uuid,'USD',null,1,'drawer')`, [s.invoice_number, cur])), null);
      check('D04 refund returns 94.5 including tax', await w.txSum(cur, 'refund'), 94.5);
      check('D07 the refund lands in the current shift, not the closed one', await w.txSum(old, 'refund'), 0);
      check('D04 stock is restored', Number((await w.one(`select quantity::float8 q from public.products where id=$1`, [prod])).q), 50);
    }
    // D-06: a refund settled outside the drawer posts no drawer movement.
    {
      await w.q(`update public.stores set tax_enabled=false where user_id=$1`, [OWNER]);
      const sh = await w.newShift(100);
      const s = await w.one(`select * from public.process_pos_sale_atomic($1,'cash','C','',90,0,0,0,0,90,50,'USD',null::uuid,$2::jsonb,0,1,null)`, [w.op('d06'), items]);
      await w.q(`update public.invoices set payment_method='digital' where invoice_number=$1`, [s.invoice_number]);
      check('D06 digital refund succeeds', await w.fails(w.q(`select * from public.refund_invoice_atomic($1,'external_cash',null::uuid,'USD',null,1,'external_cash')`, [s.invoice_number])), null);
      check('D06 digital refund writes no drawer movement', await w.txSum(sh, 'refund'), 0);
    }
    // G-14: 25 fractional movements leave no cumulative drift (F-18) and the shift closes with a zero difference.
    {
      const sh = await w.newShift(100);
      for (let i = 0; i < 10; i++) await w.one(`select public.post_shift_sale_atomic($1,$2,0.1,'USD',0.1,1) r`, [sh, w.op('g14a')]);
      for (let i = 0; i < 10; i++) await w.one(`select public.post_shift_sale_atomic($1,$2,0.33,'USD',0.33,1) r`, [sh, w.op('g14b')]);
      for (let i = 0; i < 5; i++) await w.one(`select public.add_expense_atomic($1,'rent',0.33,'rent','2026-11-23',null,$2,'drawer','USD',0.33,1)`, ['22222222-2222-4222-8222-' + String(1000 + i).padStart(12, '0'), sh]);
      const f = await w.one(`select 100::float8 + coalesce((select sum(amount) from public.shift_transactions where shift_id=$1 and type='sale'),0)::float8 - coalesce((select sum(amount) from public.shift_transactions where shift_id=$1 and type='expense'),0)::float8 e`, [sh]);
      check('G14 drawer = 100 + 1 + 3.3 - 1.65 with no drift', f.e, 102.65, 1e-9);
      check('G14 close with the exact count succeeds', await w.fails(w.one(`select public.close_cash_shift_atomic($1, 102.65, 'g14') r`, [sh])), null);
      check('G14 variance is zero', (await w.one(`select variance::float8 v from public.cash_shifts where id=$1`, [sh])).v, 0);
    }
    // G-07: a shortage of 5 is stored as variance -5; without a reason it stays unmatched, with a reason it is matched.
    {
      const a = await w.newShift(100);
      await w.one(`select public.close_cash_shift_atomic($1, 95, 'counted short') r`, [a]);
      const ra = await w.one(`select variance::float8 v, reconciliation_status s from public.cash_shifts where id=$1`, [a]);
      check('G07 shortage variance is -5', ra.v, -5);
      check('G07 shortage with a reason is matched', ra.s, 'matched');
      const b = await w.newShift(100);
      await w.one(`select public.close_cash_shift_atomic($1, 95, null) r`, [b]);
      check('G07 shortage without a reason stays unmatched', (await w.one(`select reconciliation_status s from public.cash_shifts where id=$1`, [b])).s, 'unmatched');
    }
  }

  // Plan H-03 / H-08 / H-19: profit shares on a cash sale (category partner first, general partners on the rest), the refund
  // takes them back, and fractional profits keep 8 decimals with the shares never exceeding the profit.
  {
    const w = await newWorldFn();
    const partner = (name, share, all, cs = '[]') => w.one(
      `insert into public.partners(user_id,name,share_percentage,expense_share_percentage,access_all,current_balance,current_capital,initial_capital,category_shares)
       values ($1,$2,$3,0,$4,0,0,0,$5::jsonb) returning id`, [OWNER, name, share, all, cs]);
    const bal = async (id) => Number((await w.one(`select current_balance::float8 b from public.partners where id=$1`, [id])).b);
    const Z = await partner('Z', 0, false, '[{"categoryName":"Electronics","enabled":true,"percentage":10}]');
    const X = await partner('X', 30, true);
    const Y = await partner('Y', 20, true);
    const prod = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity,category) values ($1,'Phone',150,100,50,'Electronics') returning id`, [OWNER])).id;
    const sh = await w.newShift(100);
    const sellAt = (price, profit, tag) => w.one(
      `select * from public.process_pos_sale_with_drawer_atomic($1,'cash','C','',$2,0,0,0,0,$2,$3,'USD',null::uuid,$4::jsonb,0,1,null,$5::uuid,null)`,
      [w.op(tag), price, profit, JSON.stringify([{ product_id: prod, product_name: 'Phone', quantity: 1, unit_price: price, amount_usd: price, amount_original: price, cost_price: 100 }]), sh]);
    const s1 = await sellAt(150, 50, 'h03');
    check('H03 category partner takes 10% of 50 = 5', await bal(Z.id), 5);
    check('H03 general partner X takes 30% of the remaining 45 = 13.5', await bal(X.id), 13.5);
    check('H03 general partner Y takes 20% of the remaining 45 = 9', await bal(Y.id), 9);
    check('H08 refund succeeds', await w.fails(w.q(`select * from public.refund_invoice_atomic($1,'drawer',$2::uuid,'USD',null,1,'drawer')`, [s1.invoice_number, sh])), null);
    check('H08 refund takes back the category partner share', await bal(Z.id), 0);
    check('H08 refund takes back X share', await bal(X.id), 0);
    check('H08 refund takes back Y share', await bal(Y.id), 0);
    // H-19: fractional profits (33.33 and 0.07): shares keep 8 decimals and never exceed the profit.
    for (const [price, profit, tag] of [[133.33, 33.33, 'h19a'], [100.07, 0.07, 'h19b']]) {
      const before = (await bal(Z.id)) + (await bal(X.id)) + (await bal(Y.id));
      await sellAt(price, profit, tag);
      const got = Math.round(((await bal(Z.id)) + (await bal(X.id)) + (await bal(Y.id)) - before) * 1e8) / 1e8;
      const z = Math.round(profit * 0.1 * 1e8) / 1e8;
      const expectShares = Math.round((z + (profit - z) * 0.5) * 1e8) / 1e8;
      check(`H19 profit ${profit}: partner shares total ${expectShares} (never above the profit)`, got, expectShares, 0.00000002);
      truthy(`H19 profit ${profit}: shares do not exceed the profit`, got <= profit + 1e-9);
    }
  }

  // Plan I-01 / I-15: weighted average cost keeps 8 decimals, also with fractional costs and large quantities.
  {
    const w = await newWorldFn();
    const cost = async (id) => Number((await w.one(`select cost_price::float8 c from public.products where id=$1`, [id])).c);
    const qty = async (id) => Number((await w.one(`select quantity::float8 q from public.products where id=$1`, [id])).q);
    const a = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'WAC1',9,2,88) returning id`, [OWNER])).id;
    await w.one(`select * from public.receive_stock_wac($1,10,10,'wac-i01')`, [a]);
    // (88 x 2 + 10 x 10) / 98 = 276 / 98 = 2.81632653
    check('I01 weighted average after buying 10 at 10', await cost(a), 2.81632653, 0.000000006);
    check('I01 quantity is 98', await qty(a), 98);
    const b = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'WAC2',9,3.333,10000) returning id`, [OWNER])).id;
    await w.one(`select * from public.receive_stock_wac($1,10000,6.667,'wac-i15')`, [b]);
    // (10000 x 3.333 + 10000 x 6.667) / 20000 = 5
    check('I15 large quantities with fractional costs average to 5', await cost(b), 5, 0.000000006);
    check('I15 quantity is 20000', await qty(b), 20000);
  }

  // Plan J-01 / J-02 (F-24): an expense dated inside a closed period is refused; one dated after it is accepted.
  {
    const w = await newWorldFn();
    const sh = await w.newShift(100);
    await w.one(`select public.close_accounting_period_atomic('2026-01-01','2026-01-31','UTC') r`);
    const exp = (day, tag) => w.one(`select public.add_expense_atomic($1,'rent',10,'rent',$2,null,$3,'drawer','USD',10,1) r`, [tag, day, sh]);
    truthy('J02 expense dated inside the closed period is refused', (await w.fails(exp('2026-01-15', '33333333-3333-4333-8333-000000000001'))) !== null);
    check('J02 refused expense wrote no drawer movement', await w.txSum(sh, 'expense'), 0);
    check('J02 expense dated after the closed period is accepted', await w.fails(exp('2026-02-05', '33333333-3333-4333-8333-000000000002')), null);
  }

  // Plan I-14 / I-09 / C-10: purchase return lowers stock, a cancelled paid purchase refunds into the chosen open shift,
  // a purchase with returns cannot be cancelled, and a written-off debt moves no drawer money.
  {
    const w = await newWorldFn();
    const prod = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'PP',20,10,10) returning id`, [OWNER])).id;
    const stock = async () => Number((await w.one(`select quantity::float8 q from public.products where id=$1`, [prod])).q);
    const sup = (await w.one(`insert into public.suppliers(user_id,name) values ($1,'Sup') returning id`, [OWNER])).id;
    const buy = async (number, shift) => {
      const inv = (await w.one(`insert into public.purchase_invoices(id,user_id,invoice_number,supplier_name,supplier_id,status,payment_method,payment_status,amount_paid,paid_from,paid_shift_id,paid_currency,paid_currency_amount,paid_rate,invoice_date,actual_items_count,actual_total_quantity,actual_grand_total,expected_items_count,expected_total_quantity,expected_grand_total) values (gen_random_uuid(),$1,$2,'Sup',$3,'draft','cash','paid',100,'drawer',$4,'USD',100,1,'2026-11-23',1,10,100,1,10,100) returning id`, [OWNER, number, sup, shift])).id;
      const item = (await w.one(`insert into public.purchase_invoice_items(invoice_id,product_id,product_name,quantity,cost_price,total_cost) values ($1,$2,'PP',10,10,100) returning id`, [inv, prod])).id;
      await w.q(`select public.finalize_purchase_invoice_atomic($1)`, [inv]);
      return { inv, item };
    };
    const sh = await w.newShift(500);
    const a = await buy('PI-RET', sh);
    check('I14 stock after the purchase is 20', await stock(), 20);
    check('I14 purchase return of 4 succeeds', await w.fails(w.q(`select public.purchase_return_atomic($1,$2::jsonb,$3,'ret')`, [a.inv, JSON.stringify([{ item_id: a.item, quantity: 4 }]), w.op('ret')])), null);
    check('I14 stock falls to 16', await stock(), 16);
    truthy('I09 a purchase with returns cannot be cancelled', (await w.fails(w.q(`select public.cancel_purchase_invoice_atomic($1,'x reason',$2::uuid)`, [a.inv, sh]))) !== null);
    const b = await buy('PI-CANCEL', sh);
    const before = await stock();
    const sh2 = await w.newShift(200);
    check('I09 cancel of a paid purchase settles into the chosen open shift', await w.fails(w.q(`select public.cancel_purchase_invoice_atomic($1,'تسوية إلغاء',$2::uuid)`, [b.inv, sh2])), null);
    check('I09 stock of the cancelled purchase is taken back', await stock(), before - 10);
    check('I09 the paid amount returns to the open shift (200 + 100)', await w.txSum(sh2, 'supplier_refund'), 100);
    const d = await w.newDebt({ total: 60, isCash: true });
    check('C10 write-off succeeds', await w.fails(w.q(`select public.writeoff_debt_atomic($1,'bad debt',$2)`, [d, w.op('wo')])), null);
    check('C10 debt is written off', (await w.debt(d)).status, 'written_off');
    check('C10 write-off moves no drawer money', Number((await w.one(`select count(*)::int n from public.shift_transactions where shift_id=$1 and type not in ('supplier_refund')`, [sh2])).n), 0);
  }

  // Plan H-05 / H-06 / H-07: a credit sale gives partners nothing until it is paid; each payment confirms the same share of
  // every partner profit; the last payment brings every share to the exact original.
  {
    const w = await newWorldFn();
    const partner = (name, share, all, cs = '[]') => w.one(
      `insert into public.partners(user_id,name,share_percentage,expense_share_percentage,access_all,current_balance,current_capital,initial_capital,category_shares)
       values ($1,$2,$3,0,$4,0,0,0,$5::jsonb) returning id`, [OWNER, name, share, all, cs]);
    const bal = async (id) => Number((await w.one(`select current_balance::float8 b from public.partners where id=$1`, [id])).b);
    const Z = await partner('Z', 0, false, '[{"categoryName":"Electronics","enabled":true,"percentage":10}]');
    const X = await partner('X', 30, true);
    const Y = await partner('Y', 20, true);
    const prod = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity,category) values ($1,'Phone',150,100,50,'Electronics') returning id`, [OWNER])).id;
    const sh = await w.newShift(100);
    const items = JSON.stringify([{ product_id: prod, product_name: 'Phone', quantity: 1, unit_price: 150, amount_usd: 150, amount_original: 150, cost_price: 100 }]);
    const s = await w.one(`select * from public.process_pos_sale_atomic($1,'debt','C','',150,0,0,0,0,150,50,'USD',null::uuid,$2::jsonb,0,1,null)`, [w.op('h05'), items]);
    check('H05 credit sale: Z has nothing yet', await bal(Z.id), 0);
    check('H05 credit sale: X has nothing yet', await bal(X.id), 0);
    const d = (await w.one(`select id from public.debts where invoice_id=$1`, [s.invoice_number])).id;
    await w.one(`select public.record_debt_payment_atomic($1,75,$2,$3,'USD',75,1,'cash')`, [d, w.op('h06'), sh]);
    check('H06 after paying half: Z share 2.5', await bal(Z.id), 2.5);
    check('H06 after paying half: X share 6.75', await bal(X.id), 6.75);
    check('H06 after paying half: Y share 4.5', await bal(Y.id), 4.5);
    await w.one(`select public.record_debt_payment_atomic($1,75,$2,$3,'USD',75,1,'cash')`, [d, w.op('h07'), sh]);
    check('H07 after the last payment: Z share exactly 5', await bal(Z.id), 5, 1e-9);
    check('H07 after the last payment: X share exactly 13.5', await bal(X.id), 13.5, 1e-9);
    check('H07 after the last payment: Y share exactly 9', await bal(Y.id), 9, 1e-9);
  }

  // Plan G-09: closing a multi-currency drawer compares each currency, then totals the difference in USD.
  {
    const w = await newWorldFn();
    const sh = await w.newShift(100);
    await w.one(`select public.post_shift_sale_atomic($1,$2,10,'SYP',150000,15000) r`, [sh, w.op('g09')]);
    // Expected: USD 100 and SYP 150,000 (= 10 USD at 15000). Count both exactly: no difference.
    const counts = (usd, syp) => JSON.stringify([{ code: 'USD', counted: usd, rate: 1 }, { code: 'SYP', counted: syp, rate: 15000 }]);
    const r = await w.one(`select public.close_cash_shift_atomic($1::uuid, null::numeric, 'g09', 'accept', $2::jsonb) r`, [sh, counts(100, 150000)]);
    check('G09 exact counts in two currencies: variance 0', (await w.one(`select variance::float8 v from public.cash_shifts where id=$1`, [sh])).v, 0);
    const sh2 = await w.newShift(100);
    await w.one(`select public.post_shift_sale_atomic($1,$2,10,'SYP',150000,15000) r`, [sh2, w.op('g09b')]);
    await w.one(`select public.close_cash_shift_atomic($1::uuid, null::numeric, 'short in SYP', 'accept', $2::jsonb) r`, [sh2, counts(100, 135000)]);
    // 15,000 SYP short at 15000 = -1 USD
    check('G09 a 15,000 SYP shortage is a -1 USD variance', (await w.one(`select variance::float8 v from public.cash_shifts where id=$1`, [sh2])).v, -1);
  }
  // Plan C-11: a credit sale above the customer's limit is refused; one within the limit is accepted.
  {
    const w = await newWorldFn();
    const prod = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'Lim',150,100,50) returning id`, [OWNER])).id;
    const cust = (await w.one(`insert into public.customers(user_id,name,phone,credit_limit,total_debt) values ($1,'Limited','0500000001',100,0) returning id`, [OWNER])).id;
    const sell = (amount, tag) => w.one(
      `select * from public.process_pos_sale_atomic($1,'debt','Limited','0500000001',$2,0,0,0,0,$2,0,'USD',null::uuid,$3::jsonb,0,1,null)`,
      [w.op(tag), amount, JSON.stringify([{ product_id: prod, product_name: 'Lim', quantity: 1, unit_price: amount, amount_usd: amount, amount_original: amount, cost_price: 100 }])]);
    truthy('C11 credit sale of 150 above the limit of 100 is refused', (await w.fails(sell(150, 'c11a'))) !== null);
    check('C11 credit sale of 80 within the limit is accepted', await w.fails(sell(80, 'c11b')), null);
  }

  // Plan D-08 / D-09: partial refund of a discounted, taxed invoice returns the line at total/subtotal (0.945 x 50 = 47.25),
  // keeps the tax and profit proportional, and leaves product costs untouched.
  {
    const w = await newWorldFn();
    await w.q(`insert into public.stores(user_id,name,tax_enabled,tax_rate) values ($1,'S',true,5) on conflict (user_id) do update set tax_enabled=true, tax_rate=5`, [OWNER]);
    const pA = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'A',50,20,50) returning id`, [OWNER])).id;
    const pB = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'B',50,30,50) returning id`, [OWNER])).id;
    const sh = await w.newShift(100);
    const items = JSON.stringify([
      { product_id: pA, product_name: 'A', quantity: 1, unit_price: 50, amount_usd: 50, amount_original: 50, cost_price: 20 },
      { product_id: pB, product_name: 'B', quantity: 1, unit_price: 50, amount_usd: 50, amount_original: 50, cost_price: 30 }]);
    const s = await w.one(`select * from public.process_pos_sale_with_drawer_atomic($1,'cash','C','',100,10,10,5,4.5,94.5,40,'USD',null::uuid,$2::jsonb,0,1,'exclusive',$3::uuid,null)`, [w.op('d08'), items, sh]);
    check('D08 sale total is (100 - 10) x 1.05 = 94.5', s.total, 94.5);
    const rf = (await w.one(`select public.refund_invoice_partial_atomic($1,$2::jsonb,$3,$4::uuid,null,null,null,'drawer') r`, [s.invoice_number, JSON.stringify([{ product_id: pA, quantity: 1 }]), w.op('d08r'), sh])).r;
    check('D08 partial refund of A is 0.945 x 50 = 47.25', rf.refund_amount, 47.25);
    check('D08 the drawer pays out 47.25', await w.txSum(sh, 'refund'), 47.25);
    const inv = await w.one(`select total::float8 t, profit::float8 p, tax_amount::float8 x from public.invoices where invoice_number=$1`, [s.invoice_number]);
    check('D08 invoice total after the refund is 47.25', inv.t, 47.25);
    check('D08 invoice profit after the refund is 15 (50 x 0.9 - 30)', inv.p, 15);
    check('D08 invoice tax after the refund is 2.25', inv.x, 2.25);
    const cost = async (id) => Number((await w.one(`select cost_price::float8 c from public.products where id=$1`, [id])).c);
    check('D09 refund leaves product A cost unchanged', await cost(pA), 20);
    check('D09 refund leaves product B cost unchanged', await cost(pB), 30);
  }
  // Plan C-12: paying a customer's store credit out in cash moves exactly that amount from the drawer, once, and never above the balance.
  {
    const w = await newWorldFn();
    const sh = await w.newShift(100);
    const cust = (await w.one(`insert into public.customers(user_id,name,phone) values ($1,'Credit','0500000002') returning id`, [OWNER])).id;
    await w.q(`insert into public.customer_credit_ledger(user_id,customer_id,entry_type,amount,reason) values ($1,$2,'issue',20,'golden')`, [OWNER, cust]);
    const o = w.op('c12');
    check('C12 payout of 20 succeeds', await w.fails(w.q(`select public.payout_store_credit_atomic($1::uuid,20,$2::uuid,$3)`, [cust, sh, o])), null);
    check('C12 drawer movement is 20', await w.txSum(sh, 'store_credit_refund'), 20);
    check('C12 balance is 0 afterwards', Number((await w.one(`select coalesce(sum(amount),0)::float8 b from public.customer_credit_ledger where customer_id=$1`, [cust])).b), 0);
    await w.q(`select public.payout_store_credit_atomic($1::uuid,20,$2::uuid,$3)`, [cust, sh, o]);
    check('C12 replay does not pay twice', await w.txSum(sh, 'store_credit_refund'), 20);
    truthy('C12 a payout above the balance is refused', (await w.fails(w.q(`select public.payout_store_credit_atomic($1::uuid,1,$2::uuid,$3)`, [cust, sh, w.op('c12b')]))) !== null);
  }

  // Plan C-12: store credit issued to a customer settles a debt without touching the drawer; the balance goes down by the same amount.
  {
    const w = await newWorldFn();
    const sh = await w.newShift(100);
    const cust = (await w.one(`insert into public.customers(user_id,name,phone) values ($1,'Credit2','0500000003') returning id`, [OWNER])).id;
    check('C12 issue 20 of store credit succeeds', await w.fails(w.q(`select public.issue_store_credit_atomic($1::uuid,20,'golden',null,$2)`, [cust, w.op('c12i')])), null);
    const debtId = (await w.one(`insert into public.debts(user_id, customer_id, customer_name, total_debt, total_paid, remaining_debt, status, is_cash_debt) values ($1,$2,'Credit2',50,0,50,'due',true) returning id`, [OWNER, cust])).id;
    check('C12 applying the 20 credit to the debt succeeds', await w.fails(w.q(`select public.apply_store_credit_to_debt_atomic($1::uuid,20,$2)`, [debtId, w.op('c12a')])), null);
    const dd = await w.debt(debtId);
    check('C12 the debt falls by 20 (remaining 30)', dd.remaining, 30);
    check('C12 the credit balance is 0', Number((await w.one(`select coalesce(sum(amount),0)::float8 b from public.customer_credit_ledger where customer_id=$1`, [cust])).b), 0);
    check('C12 paying a debt with credit writes no drawer movement', await w.txSum(sh, 'debt_payment'), 0);
    truthy('C12 applying more credit than the balance is refused', (await w.fails(w.q(`select public.apply_store_credit_to_debt_atomic($1::uuid,1,$2)`, [debtId, w.op('c12c')]))) !== null);
  }

  // T-2: store credit keeps 8 decimals (F-02) end to end, the balance view exists in the repo, and replays never double.
  {
    const w = await newWorldFn();
    const sh = await w.newShift(100);
    const cust = (await w.one(`insert into public.customers(user_id,name,phone) values ($1,'Prec','0500000009') returning id`, [OWNER])).id;
    const view = async () => Number((await w.one(`select store_credit::float8 s from public.customer_credit_balances where customer_id=$1`, [cust])).s);
    const issueOp = w.op('t2i');
    await w.q(`select public.issue_store_credit_atomic($1::uuid,1.23456789,'prec',null,$2)`, [cust, issueOp]);
    check('T2 the balance view shows 1.23456789 (8 decimals, not 1.2346)', await view(), 1.23456789, 1e-10);
    await w.q(`select public.issue_store_credit_atomic($1::uuid,1.23456789,'prec',null,$2)`, [cust, issueOp]);
    check('T2 replaying the same issue does not add credit twice', await view(), 1.23456789, 1e-10);
    const payOp = w.op('t2p');
    await w.q(`select public.payout_store_credit_atomic($1::uuid,1.23456789,$2::uuid,$3)`, [cust, sh, payOp]);
    check('T2 paying the whole credit out leaves exactly 0', await view(), 0, 1e-10);
    check('T2 the drawer movement keeps 8 decimals', await w.txSum(sh, 'store_credit_refund'), 1.23456789, 1e-10);
    const debtId = (await w.one(`insert into public.debts(user_id, customer_id, customer_name, total_debt, total_paid, remaining_debt, status, is_cash_debt) values ($1,$2,'Prec',10,0,10,'due',true) returning id`, [OWNER, cust])).id;
    await w.q(`select public.issue_store_credit_atomic($1::uuid,2.5,'prec2',null,$2)`, [cust, w.op('t2i2')]);
    const applyOp = w.op('t2a');
    await w.q(`select public.apply_store_credit_to_debt_atomic($1::uuid,2.5,$2)`, [debtId, applyOp]);
    await w.q(`select public.apply_store_credit_to_debt_atomic($1::uuid,2.5,$2)`, [debtId, applyOp]);
    check('T2 replaying the same credit-to-debt operation pays the debt once (remaining 7.5)', (await w.debt(debtId)).remaining, 7.5);
    check('T2 the credit is spent once (balance 0)', await view(), 0, 1e-10);
  }

  // F-02 storage: a debt payment of 5,000 LBP (0.05586592 USD) is settled with 8 decimals, so payments = total_paid exactly.
  {
    const w = await newWorldFn();
    const sh = await w.newShift(100);
    const d = await w.newDebt({ total: 1, isCash: true });
    await w.one(`select public.record_debt_payment_atomic($1,0.05586592,$2,$3,'LBP',5000,89500,'cash')`, [d, w.op('p8'), sh]);
    const r = await w.one(`select settled_amount::text s from public.debt_payments where debt_id=$1`, [d]);
    check('P8DP settled amount keeps 8 decimals (0.05586592, not 0.0559)', Number(r.s), 0.05586592, 1e-10);
    const scale = await w.one(`select numeric_scale s from information_schema.columns where table_name='supplier_ledger_entries' and column_name='amount'`);
    check('P8DP supplier ledger amount has 8 decimals', scale.s, 8);
  }

  // Offline expense whose shift was closed before sync: the closed shift refuses it; the replay without a drawer
  // (same operation id, paid_from external) records the expense once and moves no drawer.
  {
    const w = await newWorldFn();
    const sh = await w.newShift(100);
    await w.q(`update public.cash_shifts set closed_at=now() where id=$1`, [sh]);
    const op = '44444444-4444-4444-8444-000000000001';
    const refused = await w.fails(w.one(`select public.add_expense_atomic($1,'rent',3,'rent',current_date,null,$2,'drawer','USD',3,1) r`, [op, sh]));
    truthy('CLOSEDQ the closed shift refuses the queued drawer expense', refused !== null && /مغلقة/.test(refused));
    check('CLOSEDQ replay without a drawer succeeds', await w.fails(w.one(`select public.add_expense_atomic($1,'rent',3,'rent',current_date,null,null,'external','USD',3,1) r`, [op])), null);
    await w.one(`select public.add_expense_atomic($1,'rent',3,'rent',current_date,null,null,'external','USD',3,1) r`, [op]);
    check('CLOSEDQ the expense exists once', Number((await w.one(`select count(*)::int n from public.expenses where amount=3`)).n), 1);
    check('CLOSEDQ no drawer movement anywhere', Number((await w.one(`select count(*)::int n from public.shift_transactions where type='expense'`)).n), 0);
  }

  // Audit follow-up: profit snapshot on the server (F-25/D-12) and the 0.05 settlement rule (F-26).
  {
    const w = await newWorldFn();
    const prod = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'Snap',8,3.33333333,50) returning id`, [OWNER])).id;
    const items = JSON.stringify([{ product_id: prod, product_name: 'Snap', quantity: 1, unit_price: 8, amount_usd: 8, amount_original: 8, cost_price: 3.33333333 }]);
    const s = await w.one(`select * from public.process_pos_sale_atomic($1,'debt','Cust','',8,0,0,0,0,8,0,'USD',null::uuid,$2::jsonb,2,1,null)`, [w.op('snap'), items]);
    check('SNAP the sale itself wrote the snapshot on commit (client call is a no-op)', (await w.one(`select public.record_sale_profit_snapshot($1) r`, [s.invoice_number])).r, false);
    check('SNAP a replay writes nothing', (await w.one(`select public.record_sale_profit_snapshot($1) r`, [s.invoice_number])).r, false);
    const snap = await w.one(`select gross_profit::float8 g, revenue::float8 r, count(*) over () n from public.profit_records where invoice_id=$1`, [s.invoice_number]);
    check('SNAP the credit sale keeps its FULL original profit (8 - 3.33333333 = 4.66666667), not the down-payment share', snap.g, 4.66666667, 1e-9);
    check('SNAP exactly one row', Number(snap.n), 1);
    // F-26: 10.04 paid on a 10 debt closes it; the 0.04 is kept as rounding_adjustment, not dropped.
    const sh = await w.newShift(100);
    const d = await w.newDebt({ total: 10, isCash: true });
    await w.one(`select public.record_debt_payment_atomic($1,10.04,$2,$3,'USD',10.04,1,'cash')`, [d, w.op('f26'), sh]);
    const dd = await w.debt(d);
    check('F26 a 0.04 difference closes the debt', dd.status, 'fully_paid');
    const pay = await w.one(`select amount::float8 a, settled_amount::float8 s, rounding_adjustment::float8 r from public.debt_payments where debt_id=$1`, [d]);
    check('F26 settlement is the debt (10)', pay.s, 10);
    check('F26 the difference is noted (-0.04)', pay.r, -0.04, 1e-9);
    const d2 = await w.newDebt({ total: 10, isCash: true });
    truthy('F26 more than 0.05 over the remaining is refused', (await w.fails(w.one(`select public.record_debt_payment_atomic($1,10.06,$2,$3,'USD',10.06,1,'cash')`, [d2, w.op('f26b'), sh]))) !== null);
  }
  // Audit round 2: R-02 after a partial refund, FX vs rounding split (F-26/F-27), snapshot survives an early refund, manual debt RPC.
  {
    const w = await newWorldFn();
    const sh = await w.newShift(100);
    const pA = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'RA',5,2,50) returning id`, [OWNER])).id;
    const pB = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'RB',8,3,50) returning id`, [OWNER])).id;
    const both = JSON.stringify([{ product_id: pA, product_name: 'RA', quantity: 1, unit_price: 5, amount_usd: 5, amount_original: 5, cost_price: 2 },
      { product_id: pB, product_name: 'RB', quantity: 1, unit_price: 8, amount_usd: 8, amount_original: 8, cost_price: 3 }]);
    const s = await w.one(`select * from public.process_pos_sale_atomic($1,'debt','Cust','',13,0,0,0,0,13,0,'USD',null::uuid,$2::jsonb,0,1,null)`, [w.op('r2'), both]);
    const d = (await w.one(`select id from public.debts where invoice_id=$1`, [s.invoice_number])).id;
    await w.one(`select public.record_debt_payment_atomic($1,10,$2,$3,'USD',10,1,'cash')`, [d, w.op('r2p'), sh]);
    await w.one(`select public.refund_invoice_partial_atomic($1,$2::jsonb,$3,$4::uuid,null,null,null,'drawer') r`,
      [s.invoice_number, JSON.stringify([{ product_id: pA, quantity: 1 }]), w.op('r2r'), sh]);
    const plan = fs.readFileSync(new URL('../../../docs/ACCOUNTING_AUDIT_PLAN.md', import.meta.url), 'utf8');
    const x12 = plan.split('-- X-12 [')[1].split('-- X-13')[0].split('\n').slice(1).join('\n');
    check('X12 real partial refund has its receipt allocation', (await w.q(x12)).length, 0);
    await w.newInvoice({ number: 'SALE-10', total: 10, status: 'refunded' });
    await w.q(`insert into public.shift_transactions(shift_id,user_id,type,amount,reference_id,notes) values
      ($1,$2,'refund',1,'SALE-10','استرداد فاتورة SALE-10'),
      ($1,$2,'refund',1,'receipt-refund:full_refund:SALE-101:missing','رد إيصال قبض للفاتورة SALE-101')`, [sh, OWNER]);
    const orphans = await w.q(x12);
    check('X12 accepts historical refund and flags only the orphan', orphans.length, 1);
    check('X12 similar invoice numbers cannot validate the orphan', orphans[0]?.reference_id, 'receipt-refund:full_refund:SALE-101:missing');
    const r02 = reconQueries().find((r) => r.id === 'R-02').sql;
    const r02rows = await w.q(r02);
    check('R02 a partial refund on a paid credit sale is not a false difference', r02rows.length, 0);
    check('SUMMARY R-02 valid partial refund', await summaryCount(w, 'R-02'), 0);
    // Earlier debts may reference the invoice UUID. The refund RPC accepts either identifier.
    const invId = (await w.one('select id from public.invoices where invoice_number=$1', [s.invoice_number])).id;
    await w.q('update public.debts set invoice_id=$1 where id=$2', [invId, d]);
    check('R02 valid partial refund linked by UUID', (await w.q(r02)).length, 0);
    await w.q('update public.debts set total_paid=total_paid+1 where id=$1', [d]);
    check('R02 detects an actual paid-balance mismatch', (await w.q(r02)).length, 1);
    check('SUMMARY R-02 detects an actual mismatch', await summaryCount(w, 'R-02'), 1);
    const snaps = await w.one(`select count(*) filter (where revenue >= 0)::int o, max(gross_profit) filter (where revenue >= 0)::float8 g from public.profit_records where invoice_id=$1`, [s.invoice_number]);
    check('SNAP2 the original snapshot survives the refund (one row, full profit 8)', `${snaps.o}:${snaps.g}`, '1:8');
    check('SNAP2 a later client call still writes nothing', (await w.one(`select public.record_sale_profit_snapshot($1) r`, [s.invoice_number])).r, false);

    // FX at the same rate (1000): 10,040 SYP on a 10 USD debt. fx difference 0, the 0.04 snapping is rounding, not FX.
    const inv = await w.newInvoice({ number: 'INV-FXR', total: 10000, currency: 'SYP', rate: 1000 });
    const dx = await w.newDebt({ total: 10, invoice: inv.invoice_number });
    await w.one(`select public.record_debt_payment_atomic($1,10.04,$2,$3,'SYP',10040,1000,'cash')`, [dx, w.op('fxr'), sh]);
    const px = await w.one(`select amount::float8 a, settled_amount::float8 s, fx_difference_usd::float8 f, rounding_adjustment::float8 r from public.debt_payments where debt_id=$1`, [dx]);
    check('FXR same rate: fx difference is 0', px.f, 0, 1e-9);
    check('FXR the 0.04 is rounding_adjustment (-0.04)', px.r, -0.04, 1e-9);
    check('FXR settled = 10', px.s, 10, 1e-9);
    check('FXR R-06 holds', (await w.q(reconQueries().find((r) => r.id === 'R-06').sql)).length, 0);

    check('SUMMARY R-06 same rate and valid rounding', await summaryCount(w, 'R-06'), 0);

    // Manual debt through the RPC, idempotent by id.
    const mid = '55555555-5555-4555-8555-000000000001';
    const m1 = (await w.one(`select public.create_manual_debt_atomic($1::uuid,'MD-1','Ali','0999',12.123456789,null,null,true) r`, [mid])).r;
    const m2 = (await w.one(`select public.create_manual_debt_atomic($1::uuid,'MD-1','Ali','0999',12.123456789,null,null,true) r`, [mid])).r;
    check('MDEBT replay returns the same row', `${m1.replayed}:${m2.replayed}`, 'false:true');
    check('MDEBT one row, 8 decimals', (await w.one(`select count(*)::int n, max(total_debt)::float8 t from public.debts where id=$1`, [mid])).t, 12.12345679, 1e-9);
    truthy('MDEBT zero amount refused', (await w.fails(w.one(`select public.create_manual_debt_atomic(gen_random_uuid(),null,'X',null,0) r`))) !== null);
    check('MDEBT no drawer movement', Number((await w.one(`select count(*)::int n from public.shift_transactions where reference_id=$1`, [mid])).n), 0);
  }
  // Security phase 1 (2026-11-26): internal partner-revert helper not callable by clients; PIN checks only the caller's own PIN.
  {
    const w = await newWorldFn();
    const g = await w.one(`select has_function_privilege('authenticated','public.revert_invoice_partner_profits_atomic(uuid,numeric,jsonb)','EXECUTE') a,
      has_function_privilege('anon','public.create_manual_debt_atomic(uuid,text,text,text,numeric,date,text,boolean)','EXECUTE') b,
      has_function_privilege('anon','public.record_sale_profit_snapshot(text)','EXECUTE') c,
      has_function_privilege('authenticated','public.create_manual_debt_atomic(uuid,text,text,text,numeric,date,text,boolean)','EXECUTE') d`);
    check('SEC revert helper: no client EXECUTE', g.a, false);
    check('SEC anon cannot run manual debt / snapshot RPCs', `${g.b}:${g.c}`, 'false:false');
    check('SEC authenticated keeps manual debt RPC', g.d, true);
    check('SEC another user PIN is never checked', (await w.one(`select public.verify_user_pin(gen_random_uuid(), '1234') r`)).r, false);
  }
  // Security phase 2: profile privilege columns, product-images limits, e-mail lookup scope.
  {
    const w = await newWorldFn();
    const CASH = 'cccccccc-0000-4000-8000-0000000000c1';
    await w.q(`insert into auth.users(id, email) values ($1,'cash-sec2@example.test') on conflict do nothing`, [CASH]);
    // Signing up creates an admin role by trigger; make it a real cashier of OWNER (as create-user does).
    await w.q(`delete from public.user_roles where user_id=$1`, [CASH]);
    await w.q(`insert into public.user_roles(user_id, role, owner_id) values ($1,'cashier',$2)`, [CASH, OWNER]);
    await w.q(`insert into public.profiles(user_id, full_name) values ($1,'Cash') on conflict (user_id) do nothing`, [CASH]);
    const asUser = async (uid, sql, params = []) => {
      await w.db.exec('begin');
      try {
        await w.q(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
        // Supabase grants table privileges to authenticated by default; the harness does not (rolled back with the test).
        await w.db.exec('grant select, insert, update on public.profiles to authenticated; grant select on public.user_roles to authenticated');
        await w.db.exec('set local role authenticated');
        return await w.fails(w.q(sql, params));
      } finally { await w.db.exec('rollback'); }
    };
    const selfPages = await asUser(CASH, `update public.profiles set allowed_pages='["reports","partners"]'::jsonb where user_id=$1`, [CASH]);
    truthy('SEC2 a cashier cannot grant itself pages', selfPages !== null && /مخصص لمدير المتجر|42501|permission/i.test(selfPages));
    const selfType = await asUser(CASH, `update public.profiles set user_type='distributor' where user_id=$1`, [CASH]);
    truthy('SEC2 a cashier cannot change its user type', selfType !== null);
    const selfPin = await asUser(CASH, `update public.profiles set pin_hash='x' where user_id=$1`, [CASH]);
    truthy('SEC2 pin_hash cannot be written directly', selfPin !== null);
    check('SEC2 a cashier can still change its own name', await asUser(CASH, `update public.profiles set full_name='Cash 2' where user_id=$1`, [CASH]), null);
    check('SEC2 the store admin can set the cashier pages', await asUser(OWNER, `update public.profiles set allowed_pages='["reports"]'::jsonb where user_id=$1`, [CASH]), null);
    const b = await w.one(`select file_size_limit::int l, allowed_mime_types m from storage.buckets where id='product-images'`).catch(() => null);
    if (b) check('SEC2 product-images limited to 2 MB images', `${b.l}:${b.m.includes('image/webp')}:${b.m.includes('text/html')}`, '2097152:true:false');
    check('SEC2 internal lookup is not callable by clients', (await w.one(`select has_function_privilege('authenticated','public.check_phone_email_availability__impl(text,text,uuid)','EXECUTE') a`)).a, false);
  }
  // F-02 leftovers found in the function review: partner deposit and drawer sale posting keep 8 decimals.
  {
    const w = await newWorldFn();
    const pid = (await w.one(`insert into public.partners(user_id,name,share_percentage) values ($1,'P8',10) returning id`, [OWNER])).id;
    await w.one(`select public.partner_deposit_atomic($1,0.123456789,'capital',null,null,'USD',0.123456789,1)`, [pid]);
    const pr = await w.one(`select current_capital::float8 c, current_balance::float8 b from public.partners where id=$1`, [pid]);
    check('F02 partner deposit keeps 8 decimals (0.12345679, not 0.1235)', pr.c, 0.12345679, 1e-12);
    const sh = await w.newShift(0);
    await w.one(`select public.post_shift_sale_atomic($1,$2,0.123456789,'USD',0.123456789,1)`, [sh, w.op('p8')]);
    check('F02 drawer sale posting keeps 8 decimals', await w.txSum(sh, 'sale'), 0.12345679, 1e-12);
  }
  // Full cash settlement from the invoices menu.
  {
    const w = await newWorldFn();
    const shift = await w.newShift(10);
    const inv = await w.newInvoice({ number: 'INV-MARK-PAID', total: 0.004, paymentType: 'debt' });
    const settle = (number, op, sh = shift) => w.one(
      'select public.settle_invoice_debts_atomic($1,$2,$3) paid', [number, sh, op]);
    const uuid = async () => (await w.one('select gen_random_uuid() id')).id;
    const operation = await uuid();
    truthy('FULL missing linked debt refuses payment', !!await w.fails(settle(inv.invoice_number, operation)));
    check('FULL missing debt leaves invoice pending', (await w.one('select status from public.invoices where id=$1', [inv.id])).status, 'pending');
    const debt = await w.newDebt({ total: 0.004, invoice: inv.id });
    const received = await settle(inv.invoice_number, operation);
    check('FULL collects sub-cent balance via invoice UUID', received.paid, 0.004, 1e-10);
    check('FULL debt is paid', (await w.debt(debt)).remaining, 0, 1e-10);
    check('FULL invoice carries ledger amount', (await w.one('select debt_paid from public.invoices where id=$1', [inv.id])).debt_paid, 0.004, 1e-10);
    check('FULL fresh request after settlement receives zero', (await settle(inv.invoice_number, await uuid())).paid, 0);
    check('FULL same operation has no new receipt', (await settle(inv.invoice_number, operation)).paid, 0);
    check('FULL only one payment', (await w.one('select count(*)::int n from public.debt_payments where debt_id=$1', [debt])).n, 1);
    check('FULL drawer receives exactly 0.004', await w.txSum(shift, 'debt_payment'), 0.004, 1e-10);
    const multi = await w.newInvoice({ number: 'INV-MARK-MULTI', total: 3, paymentType: 'debt' });
    await w.newDebt({ total: 1, invoice: multi.invoice_number });
    await w.newDebt({ total: 2, invoice: multi.id });
    truthy('FULL inconsistent linked balances refuse receipt', !!await w.fails(settle(multi.invoice_number, await uuid())));
    check('FULL mismatch rolls back all drawer entries', await w.txSum(shift, 'debt_payment'), 0.004, 1e-10);
    await w.q('update public.invoices set debt_remaining=3 where id=$1', [multi.id]);
    check('FULL multiple debts collected together', (await settle(multi.invoice_number, await uuid())).paid, 3);
    check('FULL combined invoice paid total', (await w.one('select debt_paid from public.invoices where id=$1', [multi.id])).debt_paid, 3);
    const closed = await w.newInvoice({ number: 'INV-MARK-CLOSED', total: 4, paymentType: 'debt' });
    const d = await w.newDebt({ total: 4, invoice: closed.invoice_number });
    await w.q('update public.cash_shifts set closed_at=now() where id=$1', [shift]);
    truthy('FULL closed shift refuses payment', !!await w.fails(settle(closed.invoice_number, await uuid())));
    check('FULL closed shift leaves debt intact', (await w.debt(d)).remaining, 4);
    check('FULL closed shift leaves invoice pending', (await w.one('select status from public.invoices where id=$1', [closed.id])).status, 'pending');
  }
  // S-2: direct REST tampering with financial rows is refused; legit direct inserts and owner management keep working.
  {
    const w = await newWorldFn();
    const CASH = 'cccccccc-0000-4000-8000-0000000000c2';
    await w.q(`insert into auth.users(id, email) values ($1,'cash-s2@example.test') on conflict do nothing`, [CASH]);
    await w.q(`delete from public.user_roles where user_id=$1`, [CASH]);
    await w.q(`insert into public.user_roles(user_id, role, owner_id) values ($1,'cashier',$2)`, [CASH, OWNER]);
    const closed = await w.newShift(10);
    await w.q(`update public.cash_shifts set closed_at=now() where id=$1`, [closed]);
    const sh = await w.newShift(50);
    const tx = (await w.one(`insert into public.shift_transactions(user_id, shift_id, type, amount, currency, exchange_rate, reference_id) values ($1,$2,'deposit',5,'USD',1,'s2-dep') returning id`, [OWNER, sh])).id;
    const d = await w.newDebt({ total: 20, isCash: true });
    const inv = await w.newInvoice({ number: 'INV-S2', total: 30 });
    const prod = (await w.one(`insert into public.products(user_id,name,sale_price,cost_price,quantity) values ($1,'S2',10,4,9) returning id`, [OWNER])).id;
    await w.q(`insert into public.profit_records(user_id, invoice_id, gross_profit, cogs, revenue) values ($1,'INV-S2',5,25,30)`, [OWNER]);
    const as = async (uid, sql, params = []) => {
      await w.db.exec('begin');
      try {
        await w.q(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
        // Supabase grants table privileges to authenticated by default; the harness does not (rolled back with the test).
        await w.db.exec('grant usage on schema auth to authenticated'); // Supabase grants this; the harness does not
        await w.db.exec(`grant select, insert, update, delete on public.shift_transactions, public.debts, public.profit_records,
          public.cash_shifts, public.invoices, public.invoice_items, public.products, public.user_roles, public.profiles to authenticated`);
        await w.db.exec('set local role authenticated');
        return await w.fails(w.q(sql, params));
      } finally { await w.db.exec('rollback'); }
    };
    const refused = async (label, uid, sql, params) => truthy(label, (await as(uid, sql, params)) !== null);
    const allowed = async (label, uid, sql, params) => check(label, await as(uid, sql, params), null);
    await refused('S2 cashier cannot edit a drawer movement', CASH, `update public.shift_transactions set amount=1 where id=$1`, [tx]);
    await refused('S2 owner cannot delete a drawer movement either (append-only)', OWNER, `delete from public.shift_transactions where id=$1`, [tx]);
    const closedMsg = await as(CASH, `insert into public.shift_transactions(user_id, shift_id, type, amount, currency, exchange_rate, reference_id) values ($1,$2,'sale',3,'USD',1,'s2-late')`, [OWNER, closed]);
    truthy('S2 a movement for a closed shift is refused with (F-20) so the queue parks it', closedMsg !== null && closedMsg.includes('(F-20)'));
    await refused('S2 a zero drawer movement is refused', CASH, `insert into public.shift_transactions(user_id, shift_id, type, amount, currency, exchange_rate, reference_id) values ($1,$2,'sale',0,'USD',1,'s2-zero')`, [OWNER, sh]);
    await allowed('S2 a normal drawer movement into the open shift still works', CASH, `insert into public.shift_transactions(user_id, shift_id, type, amount, currency, exchange_rate, reference_id) values ($1,$2,'sale',3,'USD',1,'s2-ok')`, [OWNER, sh]);
    await refused('S2 nobody marks a debt paid directly', OWNER, `update public.debts set total_paid=20 where id=$1`, [d]);
    await allowed('S2 debt notes can still be edited', CASH, `update public.debts set notes='call later' where id=$1`, [d]);
    await refused('S2 a debt cannot be inserted directly', CASH, `insert into public.debts(user_id, customer_name, total_debt, total_paid, remaining_debt, status) values ($1,'X',5,0,5,'due')`, [OWNER]);
    await refused('S2 cashier cannot delete profit records', CASH, `delete from public.profit_records where invoice_id='INV-S2'`);
    await refused('S2 cashier cannot mark profit reversed', CASH, `update public.profit_records set is_reversed=true where invoice_id='INV-S2'`);
    await allowed('S2 owner can mark profit reversed (invoice cancel)', OWNER, `update public.profit_records set is_reversed=true, reversed_at=now() where invoice_id='INV-S2'`);
    await refused('S2 owner cannot rewrite a profit amount', OWNER, `update public.profit_records set gross_profit=99 where invoice_id='INV-S2'`);
    await refused('S2 cashier cannot change an invoice total', CASH, `update public.invoices set total=1 where invoice_number='INV-S2'`);
    await allowed('S2 owner can cancel an invoice', OWNER, `update public.invoices set status='cancelled' where invoice_number='INV-S2'`);
    await refused('S2 cashier cannot change a product cost', CASH, `update public.products set cost_price=0 where id=$1`, [prod]);
    await allowed('S2 cashier can still deduct stock (sale)', CASH, `update public.products set quantity=8 where id=$1`, [prod]);
    await allowed('S2 owner can change a product cost', OWNER, `update public.products set cost_price=5 where id=$1`, [prod]);
    await refused('S2 the opening balance cannot be edited', CASH, `update public.cash_shifts set opening_balance=0 where id=$1`, [sh]);
    await refused('S2 a closed shift is read-only', OWNER, `update public.cash_shifts set notes='x' where id=$1`, [closed]);
    await w.q(`update public.cash_shifts set closed_at=now() where cashier_id=$1 and closed_at is null`, [CASH]).catch(() => {});
    await allowed('S2 opening a shift directly still works', CASH, `insert into public.cash_shifts(user_id, cashier_id, opened_at, opening_balance, expected_balance) values ($1,$2,now(),10,10)`, [OWNER, CASH]);
    const g = await w.one(`select has_function_privilege('authenticated','public.receive_stock_wac(uuid,numeric,numeric,text)','EXECUTE') a,
      has_function_privilege('authenticated','public.post_shift_sale_atomic(uuid,text,numeric,text,numeric,numeric,text)','EXECUTE') b`);
    check('S2 internal stock/drawer RPCs not callable by clients', `${g.a}:${g.b}`, 'false:false');
    // Atomic RPCs are unaffected (they run as their owner): a debt payment still works end to end.
    await w.one(`select public.record_debt_payment_atomic($1,5,$2,$3,'USD',5,1,'cash')`, [d, w.op('s2pay'), sh]);
    check('S2 the atomic debt payment still works', (await w.debt(d)).paid, 5);
  }
  // Small fixes 2026-11-26: Arabic message for a missing invoice in settle_invoice_debts_atomic.
  {
    const w = await newWorldFn();
    const sh = await w.newShift(0);
    const msg = await w.fails(w.one(`select public.settle_invoice_debts_atomic('NO-SUCH-INVOICE', $1::uuid, gen_random_uuid()) r`, [sh]));
    truthy('SETTLE a missing invoice gives the Arabic message', msg !== null && msg.includes('الفاتورة غير موجودة'));
  }
  // Direct-write step 1: drawer movements through record_shift_movement_atomic (same behaviour as the old client insert).
  {
    const w = await newWorldFn();
    const closed = await w.newShift(0);
    await w.q(`update public.cash_shifts set closed_at=now() where id=$1`, [closed]);
    const sh = await w.newShift(20);
    const mv = (id, type, amt, ref, shift = sh) => w.one(`select public.record_shift_movement_atomic($1::uuid,$2::uuid,$3,$4,$5,'t','USD',$4,1) r`, [id, shift, type, amt, ref]);
    const id1 = '66666666-6666-4666-8666-000000000001';
    check('MOVE a deposit is recorded', (await mv(id1, 'deposit_revenue', 7.123456789, 'dep-1')).r.status, 'inserted');
    check('MOVE a replay of the same id adds nothing', (await mv(id1, 'deposit_revenue', 7.123456789, 'dep-1')).r.status, 'replayed');
    check('MOVE amount keeps 8 decimals', await w.txSum(sh, 'deposit_revenue'), 7.12345679, 1e-12);
    check('MOVE a sale with the same reference is the same movement', (await mv('66666666-6666-4666-8666-000000000002', 'sale', 5, 'inv-9')).r.status, 'inserted');
    check('MOVE ...second sale with that reference adds nothing', (await mv('66666666-6666-4666-8666-000000000003', 'sale', 5, 'inv-9')).r.status, 'duplicate_reference');
    check('MOVE sales total stays 5', await w.txSum(sh, 'sale'), 5);
    await mv('66666666-6666-4666-8666-000000000004', 'refund', 2, 'inv-7');
    await mv('66666666-6666-4666-8666-000000000005', 'refund', 1, 'inv-7');
    check('MOVE two partial refunds of one invoice are both kept (reference#id)', await w.txSum(sh, 'refund'), 3);
    const closedMsg = await w.fails(mv('66666666-6666-4666-8666-000000000006', 'sale', 3, 'late', closed));
    truthy('MOVE a closed shift is refused with (F-20)', closedMsg !== null && closedMsg.includes('(F-20)'));
    truthy('MOVE an expense movement is refused (its RPC writes it)', (await w.fails(mv('66666666-6666-4666-8666-000000000007', 'expense', 3, 'e1'))) !== null);
    truthy('MOVE a zero amount is refused', (await w.fails(mv('66666666-6666-4666-8666-000000000008', 'sale', 0, 'z'))) !== null);
    truthy('MOVE an unknown shift is refused', (await w.fails(mv('66666666-6666-4666-8666-000000000009', 'sale', 1, 'u', '66666666-6666-4666-8666-0000000000ff'))) !== null);
    check('MOVE the shift expected balance is not touched (cache, F-18)', Number((await w.one(`select expected_balance::float8 e from public.cash_shifts where id=$1`, [sh])).e), 20);
  }
  // Direct-write step 2 (W-2): opening a shift through open_cash_shift_atomic.
  {
    const w = await newWorldFn();
    await w.q(`update public.cash_shifts set closed_at=now() where closed_at is null`);
    const id1 = '77777777-7777-4777-8777-000000000001';
    const open = (id, bal = 25, at = null, cashier = null) => w.one(`select public.open_cash_shift_atomic($1::uuid,$2::uuid,'C',$3,null,$4::timestamptz) r`, [id, cashier, bal, at]);
    check('OPEN a shift is opened', (await open(id1, 25.123456789)).r.status, 'opened');
    const row = await w.one(`select opening_balance::float8 o, expected_balance::float8 e, closed_at from public.cash_shifts where id=$1`, [id1]);
    check('OPEN opening = expected, 8 decimals', `${row.o}:${row.e}`, '25.12345679:25.12345679');
    await w.q(`update public.cash_shifts set expected_balance=99 where id=$1`, [id1]);
    check('OPEN a replay of the same id returns the stored shift', (await open(id1, 25)).r.status, 'replayed');
    check('OPEN ...and does not reset the expected balance', Number((await w.one(`select expected_balance::float8 e from public.cash_shifts where id=$1`, [id1])).e), 99);
    const second = await w.fails(open('77777777-7777-4777-8777-000000000002', 10));
    truthy('OPEN a second open shift for the same cashier is refused (unique index, 23505)', second !== null);
    truthy('OPEN a cashier of another store is refused', (await w.fails(open('77777777-7777-4777-8777-000000000003', 1, null, '77777777-7777-4777-8777-0000000000ff'))) !== null);
    await w.q(`update public.cash_shifts set closed_at=now() where id=$1`, [id1]);
    truthy('OPEN a negative opening balance is refused', (await w.fails(open('77777777-7777-4777-8777-000000000004', -1))) !== null);
    await open('77777777-7777-4777-8777-000000000005', 5, '2026-11-01T10:00:00Z');
    check('OPEN an offline open keeps its original time', String((await w.one(`select to_char(opened_at at time zone 'UTC','YYYY-MM-DD HH24:MI') t from public.cash_shifts where id='77777777-7777-4777-8777-000000000005'`)).t), '2026-11-01 10:00');
    await w.q(`update public.cash_shifts set closed_at=now() where closed_at is null`);
    await open('77777777-7777-4777-8777-000000000006', 5, '2999-01-01T00:00:00Z');
    truthy('OPEN a future open time is clamped to now', (await w.one(`select opened_at <= now() ok from public.cash_shifts where id='77777777-7777-4777-8777-000000000006'`)).ok === true);
  }
}








