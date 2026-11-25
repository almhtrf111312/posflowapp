// Golden-case fixture: one owner, helpers to open shifts and create invoices/debts, tiny assertion kit.
// Used only by scripts/finance-sql-check.mjs against an in-memory PGlite database built from the migrations.
import { buildDb } from './db.mjs';

export const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001';

export async function newWorld() {
  const { db, errors } = await buildDb({ log: false });
  await db.exec(`
    insert into auth.users(id, email) values ('${OWNER}', 'owner@test.local') on conflict do nothing;
    insert into public.user_roles(user_id, role) values ('${OWNER}', 'admin') on conflict do nothing;
    insert into public.app_licenses(user_id, expires_at)
      select '${OWNER}', now() + interval '1 year' where not exists (select 1 from public.app_licenses where user_id = '${OWNER}');
    select set_config('request.jwt.claim.sub', '${OWNER}', false), set_config('request.jwt.claim.role', 'authenticated', false);`);
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  let seq = 0;
  const op = (p = 'op') => `${p}-${String(++seq).padStart(6, '0')}-golden`;
  // The server allows one open shift per cashier (20261125173000): opening a new one closes the previous
  // test shift first, like a real device would after closing its drawer.
  const newShift = async (opening = 100) => {
    await db.query(`update public.cash_shifts set closed_at = now() where user_id = $1 and closed_at is null`, [OWNER]);
    return (await one(`insert into public.cash_shifts(user_id, opening_balance, expected_balance) values ($1,$2,$2) returning id`, [OWNER, opening])).id;
  };
  const newInvoice = async ({ number, total, currency = 'USD', rate = 1, paymentType = 'credit', status = 'pending' }) =>
    one(`insert into public.invoices(user_id, invoice_number, total, subtotal, payment_type, payment_method, status, currency, exchange_rate, invoice_type)
         values ($1,$2,$3,$3,$4,'cash',$5,$6,$7,'sale') returning id, invoice_number`, [OWNER, number, total, paymentType, status, currency, rate]);
  const newDebt = async ({ total, invoice = null, isCash = false }) =>
    (await one(`insert into public.debts(user_id, customer_name, total_debt, total_paid, remaining_debt, status, is_cash_debt, invoice_id)
                values ($1,'Golden customer',$2,0,$2,'due',$3,$4) returning id`, [OWNER, total, isCash, invoice])).id;
  const debt = async (id) => one(`select total_paid::float8 paid, remaining_debt::float8 remaining, status from public.debts where id=$1`, [id]);
  const expected = async (shift) => Number((await one(`select expected_balance from public.cash_shifts where id=$1`, [shift])).expected_balance);
  const txSum = async (shift, type) =>
    Number((await one(`select coalesce(sum(amount),0) s from public.shift_transactions where shift_id=$1 and type=$2`, [shift, type])).s);
  const fails = async (promise) => { try { await promise; return null; } catch (e) { return String(e.message); } };
  return { db, errors, q, one, op, newShift, newInvoice, newDebt, debt, expected, txSum, fails };
}

export function kit() {
  const results = [];
  const check = (name, actual, expected, tol = 0.00005) => {
    const ok = typeof expected === 'number' ? Math.abs(Number(actual) - expected) <= tol : String(actual) === String(expected);
    results.push({ name, ok, actual, expected });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | expected ${expected} got ${actual}`}`);
  };
  const truthy = (name, value, detail = '') => check(name, Boolean(value), true) || (value ? null : detail && console.log('     ' + detail));
  return { results, check, truthy };
}
