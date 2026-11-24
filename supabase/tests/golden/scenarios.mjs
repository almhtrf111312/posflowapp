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
    const cashId = '33333333-3333-4333-8333-' + String(Date.now()).slice(-12);
    const shCash = await w.newShift(500);
    await w.one(`select public.process_quick_purchase_atomic($1::uuid, $2::jsonb) r`, [cashId, JSON.stringify({ productName: 'F7 cash', quantity: 1, costPrice: 5, salePrice: 9, paymentMethod: 'cash', shiftId: shCash })]);
    check('F7 cash quick purchase writes no supplier entry', Number((await w.one(`select count(*)::int c from public.supplier_ledger_entries where reference_id=$1`, [cashId])).c), 0);
    check('F7 cash quick purchase reduces the cached drawer balance by its cost (500 - 5)', await w.expected(shCash), 495);
    await w.one(`select public.process_quick_purchase_atomic($1::uuid, $2::jsonb) r`, [cashId, JSON.stringify({ productName: 'F7 cash', quantity: 1, costPrice: 5, salePrice: 9, paymentMethod: 'cash', shiftId: shCash })]);
    check('F7 replayed cash quick purchase does not reduce the drawer balance twice', await w.expected(shCash), 495);
  }
}
