#!/usr/bin/env node
/**
 * PosFlow — اختبار الضغط الشامل (≈1000 عملية متداخلة) — وضع صارم
 *
 * ماذا يفعل:
 *  - يتصل بنفس المتصفح المفتوح (Chrome/Chromium) عبر CDP ويكمل بنفس جلسة تسجيل الدخول.
 *  - يشغّل مئات السيناريوهات المتداخلة بترتيب عشوائي ثابت بالبذرة: بيع نقدي/آجل، كرتونة+قطعة، خصم ثابت/نسبة/زائد،
 *    بيع بزيادة وبنقص، ضريبة (تفعيل/إلغاء/شاملة/غير شاملة) تتغير أثناء الاختبار، عملات (TRY/EUR/USD) بأسعار صرف مختلفة،
 *    مرتجع كامل وجزئي ومكرر، تسديد ديون (جزئي/كامل/زائد/صفر)، شطب وإلغاء دين، محاولات حذف فواتير غير مدفوعة،
 *    مصاريف، شريك (إيداع/سحب)، ورديات بعجز وفائض، شراء سريع (جديد/موجود/نقدي/آجل/مكرر/مرفوض/ملغى)، ومبيعات من الواجهة.
 *  - يحسب الحالة المتوقعة بدفتر خارجي مستقل ويقارنها بقاعدة البيانات كل 40 عملية ثم مطابقة نهائية شاملة.
 *
 * الصرامة (لا يفوت اختبار):
 *  - كل حالة في REQUIRED لها حدّ أدنى للتنفيذ. لا يوجد مسار "تخطّي" في الكود؛ أي استثناء يُسجَّل فشلاً.
 *  - في النهاية: حالة لم تبلغ حدّها الأدنى، أو عدد عمليات أقل من المطلوب، أو أي إعداد لم يكتمل = التشغيل غير مكتمل (خروج 3).
 *  - أي فحص فاشل = خروج 2. نجاح كامل = خروج 0. تعذّر الإعداد/الاتصال = خروج 4.
 *
 * التشغيل على نفس المتصفح (مهم):
 *   المتصفح الذي يعمل عليه الاختبار الحالي يجب أن يكون مفتوحاً بمنفذ تصحيح:
 *     chrome --remote-debugging-port=9222 --user-data-dir=<نفس مجلد الملف الشخصي>
 *   (متصفح Playwright الذي أطلقه سكربت آخر لا يمكن الاتصال به بعد إطلاقه؛ أطلقه من البداية بهذا المنفذ.)
 *   ثم:  node scripts/e2e/flowpos-stress.mjs
 *   إن لم يوجد متصفح على المنفذ، يفتح السكربت نافذة جديدة ويطلب منك تسجيل الدخول مرة واحدة.
 *
 * متغيرات البيئة:
 *   E2E_CDP_URL      (http://127.0.0.1:9222)      E2E_BASE_URL   (http://localhost:8080)
 *   E2E_OPS          عدد العمليات المطلوب (1000)  E2E_SEED      (7)
 *   E2E_UI_SALES     حدّ أدنى لمبيعات الواجهة النقدية (20)
 *   E2E_ALLOW_ANY_STORE=1  للسماح بمتجر اسمه لا يحتوي "E2E" أو "اختبار" (غير مستحسن)
 *
 * حماية: يرفض العمل إن لم يكن اسم المتجر متجر اختبار. كل بيانات التشغيل تبدأ بالبادئة PREFIX ولا تُحذف.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ───────────────────────── الإعدادات ─────────────────────────
const CDP_URL = process.env.E2E_CDP_URL || 'http://127.0.0.1:9222';
const BASE_URL = (process.env.E2E_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const TARGET_OPS = Number(process.env.E2E_OPS || 1000);
const SEED = Number(process.env.E2E_SEED || 7);
const UI_MIN = Number(process.env.E2E_UI_SALES || 20);
const CHECKPOINT_EVERY = 40;

const RUN_ID = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 12);
const PREFIX = `E2S${RUN_ID}`;
const OUT = path.resolve('e2e-results', `stress-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SHOTS = path.join(OUT, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round8 = (n) => Math.round((n + Number.EPSILON) * 1e8) / 1e8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seed = SEED;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const uid = (tag) => `${PREFIX}-${tag}-${crypto.randomBytes(4).toString('hex')}`;
const csvCell = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function parseNumber(text) {
  if (!text) return NaN;
  const latin = String(text).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/٫/g, '.').replace(/[٬,](?=\d{3}\b)/g, '');
  const m = latin.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

// ───────────────────────── السيناريوهات المطلوبة (الحد الأدنى لكل واحدة) ─────────────────────────
const REQUIRED = {
  S_CASH_PLAIN: 25, S_CASH_MIXED: 20, S_CASH_CARTON: 10, S_DEBT_NODP: 12, S_DEBT_DP: 12, S_DEBT_DP_OVER: 4,
  S_DISC_FIXED: 15, S_DISC_PCT: 15, S_DISC_OVER: 4, S_PRICE_UP: 15, S_PRICE_DOWN: 15,
  S_TAX_EXCL: 15, S_TAX_INCL: 15, S_TAX_OFF: 8, S_TAX_LEGACY: 5, SET_TAX_TOGGLE: 20,
  S_CUR_TRY: 10, S_CUR_EUR: 10, S_CUR_NORATE_REJECT: 4, S_OVERSELL: 4, S_REPLAY: 8,
  S_REJ_PAYTYPE: 3, S_REJ_NEGDISC: 3, S_REJ_EMPTY: 3, S_REJ_UNKNOWN: 3, S_REJ_NEGPRICE: 3,
  R_FULL_CASH: 8, R_FULL_DEBT: 6, R_DOUBLE: 5, R_PARTIAL: 6,
  DEBT_PAY_PARTIAL: 8, DEBT_PAY_FULL: 6, DEBT_PAY_OVER_REJECT: 4, DEBT_PAY_ZERO_REJECT: 3, DEBT_WRITEOFF: 3, DEBT_CANCEL: 3,
  DEL_UNPAID_ATTEMPT: 6, DEL_PAID_ATTEMPT: 4,
  EXP_ADD_DELETE: 8, EXP_REJECT_ZERO: 3, PARTNER_DEP_WD: 6, SHIFT_CYCLE: 10,
  QP_NEW_CREDIT: 6, QP_EXISTING_CREDIT: 10, QP_CASH_SHIFT: 6, QP_REPLAY: 4, QP_REJ_QTY0: 2, QP_REJ_NEGCOST: 2,
  QP_REJ_CASH_NOSHIFT: 3, QP_REJ_METHOD: 2, QP_CANCEL: 5,
  UI_CASH_SALE: UI_MIN, UI_DEBT_SALE: 5, UI_TOUR: 2,
};
/** أوزان التعبئة بعد بلوغ الحدود الدنيا (المبيعات أكثر لأنها الأخطر مالياً). */
const FILL_WEIGHTS = {
  S_CASH_PLAIN: 6, S_CASH_MIXED: 5, S_CASH_CARTON: 3, S_DEBT_NODP: 3, S_DEBT_DP: 3, S_DISC_FIXED: 4, S_DISC_PCT: 4,
  S_PRICE_UP: 3, S_PRICE_DOWN: 3, S_TAX_EXCL: 3, S_TAX_INCL: 3, S_CUR_TRY: 3, S_CUR_EUR: 3, SET_TAX_TOGGLE: 3,
  R_FULL_CASH: 2, R_FULL_DEBT: 1, DEBT_PAY_PARTIAL: 2, QP_EXISTING_CREDIT: 2, EXP_ADD_DELETE: 1, S_REPLAY: 1,
};

// ───────────────────────── السجلات ─────────────────────────
const ledger = [];
const checks = [];
const failures = [];
const consoleErrors = [];
const cov = Object.fromEntries(Object.keys(REQUIRED).map((k) => [k, { runs: 0, checks: 0, fails: 0 }]));
let opCount = 0;
let currentScenario = 'SETUP';
let shotSeq = 0;

function recordOp(kind, ref, detail, result = 'تم') {
  opCount += 1;
  ledger.push([opCount, new Date().toISOString(), currentScenario, kind, ref, detail, result]);
}
function check(name, expected, actual, tol = 0.011) {
  const e = Number(expected), a = Number(actual);
  const numeric = typeof expected !== 'boolean' && typeof actual !== 'boolean' && Number.isFinite(e) && Number.isFinite(a) && expected !== '' && actual !== '';
  const pass = numeric ? Math.abs(e - a) <= tol : String(expected) === String(actual);
  checks.push({ scenario: currentScenario, name, expected, actual, pass });
  if (cov[currentScenario]) { cov[currentScenario].checks += 1; if (!pass) cov[currentScenario].fails += 1; }
  if (!pass) log('  ✗', currentScenario, '|', name, '| متوقع', expected, '| فعلي', actual);
  return pass;
}
function fail(name, message) {
  failures.push({ scenario: currentScenario, name, message: String(message).slice(0, 400) });
  if (cov[currentScenario]) cov[currentScenario].fails += 1;
  log('  ✗', currentScenario, '|', name, '—', String(message).slice(0, 200));
}

// ───────────────────────── المتصفح: الاتصال بنفس المتصفح ─────────────────────────
let browser = null, context, page, attached = false;
try {
  browser = await chromium.connectOverCDP(CDP_URL);
  context = browser.contexts()[0];
  const pages = context.pages();
  page = pages.find((p) => /#\/|localhost|pages.dev|flowpos/i.test(p.url())) || pages[0] || await context.newPage();
  attached = true;
  log('متصل بنفس المتصفح المفتوح عبر', CDP_URL, '— الصفحة:', page.url());
} catch (e) {
  log('لا يوجد متصفح على', CDP_URL, '— سأفتح نافذة جديدة (سجّل الدخول مرة واحدة).');
  context = await chromium.launchPersistentContext(path.resolve('.e2e-profile'), { headless: false, viewport: { width: 1366, height: 820 }, locale: 'ar', args: ['--remote-debugging-port=9222'] });
  page = context.pages()[0] || await context.newPage();
}
page.setDefaultTimeout(15000);

const api = { url: '', apikey: '', auth: '' };
context.on('request', (req) => {
  const m = req.url().match(/^(https:\/\/[a-z0-9]+\.supabase\.co)\/(rest|auth)\/v1\//);
  if (!m) return;
  const h = req.headers();
  if (h.apikey) { api.url = m[1]; api.apikey = h.apikey; }
  if (h.authorization && h.authorization.startsWith('Bearer ') && h.authorization.slice(7) !== h.apikey) api.auth = h.authorization;
});
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300)); });
page.on('pageerror', (err) => consoleErrors.push('PAGEERROR ' + String(err).slice(0, 300)));

async function shot(label) {
  shotSeq += 1;
  const file = `${String(shotSeq).padStart(3, '0')}_${label.replace(/[^\w؀-ۿ-]+/g, '_').slice(0, 50)}.png`;
  try { await page.screenshot({ path: path.join(SHOTS, file) }); } catch { /* ignore */ }
  return file;
}
async function goto(route) {
  await page.goto(`${BASE_URL}/#/${route}`);
  await page.waitForLoadState('domcontentloaded');
  await sleep(1200);
}
async function captureSession(force = false) {
  if (force) api.auth = '';
  for (let i = 0; i < 3 && !api.auth; i++) {
    await page.reload().catch(() => {});
    for (let t = 0; t < 15 && !api.auth; t++) await sleep(1000);
  }
  return !!api.auth;
}

// ───────────────────────── طبقة قاعدة البيانات (بجلسة المستخدم نفسها) ─────────────────────────
async function rest(method, pathq, body, headers = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${api.url}/rest/v1/${pathq}`, {
        method,
        headers: { apikey: api.apikey, Authorization: api.auth, 'Content-Type': 'application/json', Prefer: 'return=representation', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (res.status === 401 && attempt < 4) { await captureSession(true); continue; }
      if (res.status >= 500 && attempt < 4) { await sleep(800 * attempt); continue; }
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { ok: res.ok, status: res.status, data, error: res.ok ? null : (data && (data.message || data.error)) || text.slice(0, 200) };
    } catch (e) {
      if (attempt === 4) return { ok: false, status: 0, data: null, error: `network: ${e.message}` };
      await sleep(800 * attempt);
    }
  }
}
const rpc = (name, args) => rest('POST', `rpc/${name}`, args);
const rows = (r) => (Array.isArray(r.data) ? r.data : r.data ? [r.data] : []);
const jwtSub = () => { try { return JSON.parse(Buffer.from(api.auth.split('.')[1], 'base64url').toString()).sub; } catch { return null; } };

// ───────────────────────── الدفتر الخارجي ─────────────────────────
const model = {
  store: { enabled: false, rate: 0 },
  products: {},         // key -> {id,name,stock,cost,price,factor,bulkPrice}
  saleInvoices: 0, saleTotal: 0,
  debts: new Map(),     // invoiceId -> {customer, remaining}
  shiftsOpened: 0, shiftsClosed: 0,
};
let ownerId = null, originalStore = null, partnerId = null, userId = null;
const POOL = [];        // مفاتيح المنتجات المستخدمة في المبيعات العشوائية
let OVER_KEY = null;    // منتج صغير المخزون لاختبار البيع الزائد

const effRate = () => (model.store.enabled ? Math.min(Math.max(model.store.rate, 0), 100) : 0);

/** نسخة مطابقة لحساب الخادم (process_pos_sale_atomic). */
function calcSale({ sub, discount, mode, total, payType, dp }) {
  const s = round8(sub);
  const disc = round8(Math.min(Math.max(discount, 0), s));
  const r = effRate();
  const inclusive = r > 0 && (['inclusive', 'gross'].includes(String(mode || '').toLowerCase()) || (!mode && total !== null && Math.abs(total - (s - discount)) <= 0.0001));
  let tax, tot;
  if (inclusive) { tax = round8(((s - disc) * r) / (100 + r)); tot = round8(s - disc); }
  else { tax = round8(((s - disc) * r) / 100); tot = round8(s - disc + tax); }
  const dpv = payType === 'debt' ? Math.min(round8(dp || 0), tot) : 0;
  const remaining = payType === 'debt' ? round8(tot - dpv) : 0;
  return { sub: s, disc, tax, tot, dp: dpv, remaining, inclusive };
}

async function fetchProduct(key) {
  const p = model.products[key];
  const r = await rest('GET', `products?select=id,name,quantity,cost_price,sale_price&id=eq.${p.id}`);
  return rows(r)[0] || null;
}
async function assertProducts(keys, label) {
  for (const key of keys) {
    const db = await fetchProduct(key);
    const p = model.products[key];
    if (!db) { fail(`${label}: المنتج ${key} غير موجود`, 'missing'); continue; }
    check(`${label}: كمية ${key}`, p.stock, db.quantity, 0.0011);
    check(`${label}: تكلفة ${key}`, p.cost, db.cost_price, 0.0002);
  }
}
async function resyncProducts(keys) {
  for (const key of keys) { const db = await fetchProduct(key); if (db) { model.products[key].stock = Number(db.quantity); model.products[key].cost = Number(db.cost_price); } }
}

// ───────────────────────── الشراء السريع ─────────────────────────
async function quickPurchase({ key = null, name, qty, cost, method = 'credit', shiftId = null, sale = null, opId = crypto.randomUUID(), expectReject = false, label = 'qp', extra = {} }) {
  const existing = key ? model.products[key] : null;
  const payload = {
    operationId: opId, productName: existing ? existing.name : name, quantity: qty, costPrice: cost, paymentMethod: method,
    shiftId, salePrice: sale ?? undefined, productId: existing ? existing.id : undefined, ...extra,
  };
  const r = await rpc('process_quick_purchase_atomic', { _operation_id: opId, _purchase: payload });
  recordOp('quick_purchase', opId, `${label}: ${payload.productName} ×${qty}@${cost} ${method}`, r.ok ? 'تم' : `رُفض: ${r.error}`);
  if (expectReject) {
    check(`${label}: يجب الرفض`, true, !r.ok);
    return { r, opId };
  }
  if (!r.ok || !r.data?.success) { fail(`${label}: فشل الشراء`, r.error || JSON.stringify(r.data)); return { r, opId }; }
  check(`${label}: already_processed=false`, false, !!r.data.already_processed);
  let k = key;
  if (existing) {
    const pos = Math.max(existing.stock, 0);
    existing.cost = pos === 0 ? cost : cost === 0 ? existing.cost : round8((pos * existing.cost + qty * cost) / (pos + qty));
    existing.stock += qty;
    if (sale && sale > 0) existing.price = sale;
  } else {
    const found = await rest('GET', `products?select=id,name,quantity,cost_price,sale_price&name=eq.${encodeURIComponent(name)}`);
    const row = rows(found)[0];
    if (!row) { fail(`${label}: المنتج الجديد لم يُنشأ`, name); return { r, opId }; }
    k = `N${Object.keys(model.products).length + 1}`;
    model.products[k] = { id: row.id, name, stock: qty, cost, price: sale && sale > 0 ? sale : cost, factor: 1, bulkPrice: 0 };
  }
  const db = await fetchProduct(k);
  check(`${label}: كمية بعد الشراء`, model.products[k].stock, db?.quantity, 0.0011);
  check(`${label}: تكلفة بعد الشراء (WAC)`, model.products[k].cost, db?.cost_price, 0.0002);
  if (sale && sale > 0) check(`${label}: سعر البيع`, sale, db?.sale_price);
  return { r, opId, key: k };
}

// ───────────────────────── مبيعات نقطة البيع (RPC) ─────────────────────────
async function ensureStock(key, need) {
  const p = model.products[key];
  if (p.stock >= need + 50) return;
  await quickPurchase({ key, qty: 2000, cost: p.cost || 1, label: 'topup' });
}

/** سطور عشوائية: lines = [{key,cartons,pieces,mult}] */
function randomLines({ mixed = false, carton = false, mult = 1, single = false } = {}) {
  const bulky = POOL.filter((k) => model.products[k].factor > 1);
  const lines = [];
  const used = new Set();
  const add = (key, cartons, pieces, m) => { used.add(key); lines.push({ key, cartons, pieces, mult: m }); };
  if (mixed) add(pick(bulky), rint(1, 2), rint(1, 3), mult);
  else if (carton) add(pick(bulky), rint(1, 2), 0, mult);
  const others = POOL.filter((k) => !used.has(k));
  const n = single ? (lines.length ? 0 : 1) : rint(lines.length ? 0 : 1, 3);
  for (let i = 0; i < n && others.length; i++) add(others.splice(Math.floor(rnd() * others.length), 1)[0], 0, rint(1, 5), mult);
  return lines;
}
const need = (l) => l.cartons * model.products[l.key].factor + l.pieces;

function buildItems(lines, rate) {
  const items = [];
  let sub = 0;
  for (const l of lines) {
    const p = model.products[l.key];
    if (l.cartons > 0) {
      const amt = round8(l.cartons * p.bulkPrice * l.mult);
      items.push({ product_id: p.id, product_name: p.name, quantity: l.cartons, unit: 'bulk', conversion_factor: p.factor, unit_price: round8(p.bulkPrice * l.mult), amount_usd: amt, amount_original: round8(amt * (rate || 1)) });
      sub += amt;
    }
    if (l.pieces > 0) {
      const amt = round8(l.pieces * p.price * l.mult);
      items.push({ product_id: p.id, product_name: p.name, quantity: l.pieces, unit: 'piece', conversion_factor: 1, unit_price: round8(p.price * l.mult), amount_usd: amt, amount_original: round8(amt * (rate || 1)) });
      sub += amt;
    }
  }
  return { items, sub: round8(sub) };
}

/**
 * ينفّذ بيعاً ويتحقق منه. يعيد { ok, plan, row, opId, lines }.
 * overrides: discount (قيمة)، discountPct، mode ('exclusive'|'inclusive'|''|null)، currency، rate، dp، customer، payType، opId، mult
 */
async function sale(lines, o = {}) {
  const payType = o.payType || 'cash';
  const currency = o.currency || 'USD';
  const rate = currency === 'USD' ? 1 : o.rate ?? null;
  if (!o.allowShortage) for (const l of lines) await ensureStock(l.key, need(l));
  const { items, sub } = buildItems(lines, rate);
  let discount = o.discount ?? 0;
  if (o.discountPct) discount = round8((sub * o.discountPct) / 100);
  const mode = o.mode === undefined ? (rnd() < 0.5 ? 'exclusive' : 'inclusive') : o.mode;
  const opId = o.opId || uid('s');
  const customer = payType === 'debt' ? (o.customer || `${PREFIX} عميل ${rint(1, 6)}`) : null;
  const exp = calcSale({ sub, discount, mode, total: o.clientTotal ?? null, payType, dp: o.dp || 0 });
  const args = {
    _operation_id: opId, _payment_type: payType, _customer_name: customer, _customer_phone: customer ? `05${rint(10000000, 99999999)}` : null,
    _subtotal: sub, _discount: discount, _discount_percentage: o.discountPct || 0, _tax_rate: effRate(), _tax_amount: exp.tax,
    _total: o.clientTotal ?? exp.tot, _profit: 0, _currency: currency, _warehouse_id: null, _items: items, _down_payment: o.dp || 0,
    _exchange_rate: rate, _tax_mode: mode,
    ...(o.argsOverride || {}),
  };
  const r = await rpc('process_pos_sale_atomic', args);
  const desc = lines.map((l) => `${l.key}:${l.cartons ? l.cartons + 'ك' : ''}${l.pieces ? l.pieces + 'ق' : ''}`).join('|');
  recordOp('sale', opId, `${payType} ${currency} ${desc} disc=${discount} tax=${effRate()}${exp.inclusive ? '(شامل)' : ''}`, r.ok ? 'تم' : `رُفض: ${r.error}`);
  if (o.expectReject) { check(`${o.label || 'بيع'}: يجب الرفض`, true, !r.ok); return { ok: false, r, opId, lines }; }
  const row = rows(r)[0];
  if (!r.ok || !row?.success) { fail(`${o.label || 'بيع'}: فشل`, r.error || JSON.stringify(r.data)); return { ok: false, r, opId, lines }; }
  check('إجمالي الفرعي', exp.sub, row.subtotal);
  check('الخصم', exp.disc, row.discount);
  check('الضريبة', exp.tax, row.tax_amount);
  check('الإجمالي', exp.tot, row.total);
  check('المتبقي (دين)', exp.remaining, row.debt_remaining);
  check('already_processed=false', false, !!row.already_processed);
  const shortage = !!row.stock_shortage;
  if (!o.allowShortage) check('لا نقص مخزون', false, shortage);
  for (const l of lines) model.products[l.key].stock -= need(l);
  model.saleInvoices += 1;
  model.saleTotal = round8(model.saleTotal + exp.tot);
  if (payType === 'debt' && exp.remaining > 0) model.debts.set(row.invoice_id, { customer, remaining: exp.remaining, number: row.invoice_number });
  if (o.verifyDb !== false && (o.verifyDb || chance(0.35) || currency !== 'USD')) {
    const inv = rows(await rest('GET', `invoices?select=currency,exchange_rate,payment_type,tax_rate,total,subtotal,discount,debt_remaining,operation_id&operation_id=eq.${opId}`));
    check('الفاتورة محفوظة مرة واحدة', 1, inv.length, 0);
    if (inv[0]) {
      check('عملة الفاتورة', currency, inv[0].currency);
      check('سعر الصرف المحفوظ', currency === 'USD' ? 1 : rate, inv[0].exchange_rate, 0.0001);
      check('نوع الدفع المحفوظ', payType, inv[0].payment_type);
      check('نسبة الضريبة المحفوظة', effRate(), inv[0].tax_rate, 0.0001);
      check('إجمالي الفاتورة المحفوظ', exp.tot, inv[0].total);
    }
  }
  return { ok: true, plan: exp, row, opId, lines, args };
}

// ───────────────────────── إعدادات المتجر (ضريبة) ─────────────────────────
async function setTax(enabled, rate) {
  const r = await rest('PATCH', `stores?user_id=eq.${ownerId}`, { tax_enabled: enabled, tax_rate: rate });
  recordOp('settings', 'tax', `tax_enabled=${enabled} rate=${rate}`, r.ok ? 'تم' : `رُفض: ${r.error}`);
  if (!r.ok || !rows(r).length) { fail('تغيير إعداد الضريبة', r.error || 'لم يُحدَّث أي صف'); return false; }
  model.store = { enabled, rate };
  return true;
}

// ───────────────────────── الورديات ─────────────────────────
async function openShift(opening) {
  const r = await rest('POST', 'cash_shifts', { user_id: ownerId, cashier_id: userId, cashier_name: 'E2E', opening_balance: opening, expected_balance: opening, opened_at: new Date().toISOString() });
  recordOp('shift_open', '', `opening=${opening}`, r.ok ? 'تم' : `رُفض: ${r.error}`);
  const row = rows(r)[0];
  if (!r.ok || !row) { fail('فتح وردية', r.error); return null; }
  model.shiftsOpened += 1;
  return { id: row.id, opening, drawer: opening };
}
async function closeShift(shift, variance, reason) {
  const actual = round2(shift.drawer + variance);
  const r = await rpc('close_cash_shift_atomic', { _shift_id: shift.id, _actual_balance: actual, _variance_reason: reason });
  recordOp('shift_close', shift.id, `expected=${shift.drawer} actual=${actual}`, r.ok ? 'تم' : `رُفض: ${r.error}`);
  if (!r.ok) { fail('إقفال وردية', r.error); return; }
  model.shiftsClosed += 1;
  const db = rows(await rest('GET', `cash_shifts?select=expected_balance,actual_balance,variance,reconciliation_status,closed_at&id=eq.${shift.id}`))[0];
  check('الرصيد المتوقع عند الإقفال', round2(shift.drawer), db?.expected_balance);
  check('الفارق', round2(variance), db?.variance);
  check('الحالة بعد الإقفال', Math.abs(variance) >= 0.01 && !reason ? 'unmatched' : 'matched', db?.reconciliation_status);
  check('الوردية مقفلة', true, !!db?.closed_at);
  const again = await rpc('close_cash_shift_atomic', { _shift_id: shift.id, _actual_balance: actual, _variance_reason: reason });
  check('إقفال مكرر لا يغيّر شيئاً', true, !!(again.ok && again.data?.already_closed));
}

// ───────────────────────── مساعدات الديون ─────────────────────────
async function makeDebt({ dp = 0, minTotal = 3 } = {}) {
  const lines = randomLines({ single: true });
  const res = await sale(lines, { payType: 'debt', dp, mode: 'exclusive', discount: 0, verifyDb: false, customer: `${PREFIX} عميل ${rint(1, 6)}` });
  if (!res.ok || res.plan.remaining < minTotal) return null;
  const debtRows = rows(await rest('GET', `debts?select=id,remaining_debt,status,customer_name&invoice_id=eq.${encodeURIComponent(res.row.invoice_number)}`));
  if (!debtRows[0]) { fail('الدين لم يُنشأ مع الفاتورة الآجلة', res.row.invoice_number); return null; }
  check('قيمة الدين المحفوظة', res.plan.remaining, debtRows[0].remaining_debt);
  return { ...res, debtId: debtRows[0].id };
}

// ───────────────────────── واجهة المستخدم (متصفح) ─────────────────────────
const grid = () => page.locator('[data-tour="product-grid"]');
const searchInput = () => page.locator('[data-tour="search-bar"] input').first();
async function uiAdd(p, { cartons = 0, pieces = 0 }) {
  await searchInput().fill(p.name);
  await sleep(700);
  const card = grid().getByText(p.name, { exact: false }).first();
  if (cartons > 0) {
    await card.click(); await sleep(300);
    await page.getByTestId('cart-toggle-unit').last().click(); await sleep(300);
    for (let i = 1; i < cartons; i++) { await page.getByTestId('cart-qty-plus').last().click(); await sleep(150); }
  }
  for (let i = 0; i < pieces; i++) { await card.click(); await sleep(200); }
  await searchInput().fill(''); await sleep(300);
}
async function dismissPopups() {
  for (const name of [/^(إغلاق|لاحقاً|تخطي|Skip|Close|Later|Not now)$/i]) {
    const b = page.getByRole('button', { name }).first();
    if (await b.isVisible({ timeout: 300 }).catch(() => false)) await b.click().catch(() => {});
  }
  await page.keyboard.press('Escape').catch(() => {});
}
async function uiSale(kind) {
  await goto('pos');
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(1200);
  await dismissPopups();
  const lines = randomLines({ mixed: chance(0.3), single: false }).slice(0, 3);
  const discount = chance(0.4) ? 1 : 0;
  let shown, exp, customer = null;
  try {
  for (const l of lines) { await ensureStock(l.key, need(l)); await uiAdd(model.products[l.key], l); }
  if (discount) await page.getByTestId('cart-discount-fixed').fill(String(discount));
  await sleep(500);
  shown = parseNumber(await page.getByTestId('cart-total').innerText());
  const { sub } = buildItems(lines, 1);
  exp = calcSale({ sub, discount, mode: 'exclusive', total: null, payType: kind === 'cash' ? 'cash' : 'debt', dp: 0 });
  check('إجمالي السلة المعروض في الواجهة', exp.tot, shown);
  if (kind === 'cash') {
    await page.locator('[data-tour="cash-btn"]').first().click();
    await page.getByTestId('cash-confirm').click();
    await page.getByTestId('cash-confirm').waitFor({ state: 'hidden', timeout: 30000 });
  } else {
    customer = `${PREFIX} واجهة ${rint(1, 3)}`;
    await page.getByTestId('cart-customer').fill(customer); await sleep(300);
    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('[data-tour="debt-btn"]').first().click();
    const phone = page.locator('#cart-new-customer-phone');
    if (await phone.isVisible({ timeout: 1500 }).catch(() => false)) await phone.fill(`05${rint(10000000, 99999999)}`);
    await page.getByTestId('debt-confirm').click();
    await page.getByTestId('debt-confirm').waitFor({ state: 'hidden', timeout: 30000 });
  }
  await sleep(900);
  } catch (e) {
    // قد يكون البيع نُفّذ على السيرفر قبل الخطأ: نزامن المخزون من الخادم بدل ترك النموذج منحرفاً
    await resyncProducts(lines.map((l) => l.key)).catch(() => {});
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    throw e;
  }
  recordOp('ui_sale', '', `${kind} ${lines.map((l) => l.key).join('|')} shown=${shown}`);
  for (const l of lines) model.products[l.key].stock -= need(l);
  model.saleInvoices += 1; model.uiSales = (model.uiSales || 0) + 1; model.saleTotal = round8(model.saleTotal + exp.tot);
  await shot(`ui_${kind}`);
}
const ROUTES = ['pos', 'dashboard', 'products', 'purchases', 'invoices', 'customers', 'debts', 'expenses', 'partners', 'cash-shifts', 'reports', 'settings'];
async function uiTour() {
  for (const route of ROUTES) {
    const started = Date.now();
    const before = consoleErrors.length;
    await goto(route);
    await sleep(1200);
    const text = await page.locator('body').innerText();
    recordOp('ui_route', route, `${Date.now() - started}ms`);
    check(`الصفحة ${route} فُتحت وفيها محتوى`, true, text.trim().length > 40);
    check(`الصفحة ${route} بلا أخطاء console جديدة`, 0, consoleErrors.length - before, 0);
    await shot(`tour_${route}`);
  }
}

// ───────────────────────── تعريف السيناريوهات ─────────────────────────
const SC = {
  // ——— مبيعات ———
  S_CASH_PLAIN: async () => { await sale(randomLines(), { mode: 'exclusive' }); },
  S_CASH_MIXED: async () => { await sale(randomLines({ mixed: true }), {}); },
  S_CASH_CARTON: async () => { await sale(randomLines({ carton: true }), {}); },
  S_DEBT_NODP: async () => { await sale(randomLines(), { payType: 'debt', dp: 0 }); },
  S_DEBT_DP: async () => { const l = randomLines(); const r = await sale(l, { payType: 'debt', dp: 2 }); if (r.ok) check('المقدّم محسوب', Math.min(2, r.plan.tot), r.plan.dp); },
  S_DEBT_DP_OVER: async () => { await sale(randomLines({ single: true }), { payType: 'debt', dp: 100000 }); },
  S_DISC_FIXED: async () => { await sale(randomLines(), { discount: rint(1, 3) }); },
  S_DISC_PCT: async () => { await sale(randomLines(), { discountPct: pick([5, 10, 12.5, 25, 50]) }); },
  S_DISC_OVER: async () => { await sale(randomLines({ single: true }), { discount: 1e6 }); },
  S_PRICE_UP: async () => { await sale(randomLines({ mult: 1 }).map((l) => ({ ...l, mult: pick([1.1, 1.25, 1.5, 2]) })), {}); },
  S_PRICE_DOWN: async () => { await sale(randomLines({ mult: 1 }).map((l) => ({ ...l, mult: pick([0.9, 0.5, 0.25, 0]) })), {}); },
  // ——— ضرائب ———
  SET_TAX_TOGGLE: async () => {
    const on = chance(0.7);
    const rate = pick([5, 10, 15, 8.5, 0.5, 100, 20]);
    if (await setTax(on, rate)) { const lines = randomLines({ single: true }); await sale(lines, { mode: 'exclusive', verifyDb: true }); }
  },
  S_TAX_EXCL: async () => { await setTax(true, pick([5, 10, 15])); await sale(randomLines(), { mode: 'exclusive', discount: chance(0.4) ? 1 : 0, verifyDb: true }); },
  S_TAX_INCL: async () => { await setTax(true, pick([5, 10, 15])); await sale(randomLines(), { mode: 'inclusive', discount: chance(0.4) ? 1 : 0, verifyDb: true }); },
  S_TAX_OFF: async () => { await setTax(false, 10); await sale(randomLines(), { mode: pick(['exclusive', 'inclusive']), verifyDb: true }); },
  S_TAX_LEGACY: async () => {
    await setTax(true, 10);
    const lines = randomLines({ single: true });
    const { sub } = buildItems(lines, 1);
    await sale(lines, { mode: '', clientTotal: round8(sub), verifyDb: true }); // بلا وضع + إجمالي = المجموع ⇒ الخادم يستنتج "شامل"
  },
  // ——— عملات ———
  S_CUR_TRY: async () => { await sale(randomLines(), { currency: 'TRY', rate: pick([30, 40, 41.5, 55.25]), mode: 'exclusive' }); },
  S_CUR_EUR: async () => { await sale(randomLines(), { currency: 'EUR', rate: pick([0.85, 0.92, 1.05]), payType: chance(0.3) ? 'debt' : 'cash', dp: 1 }); },
  S_CUR_NORATE_REJECT: async () => { await sale(randomLines({ single: true }), { currency: 'TRY', rate: null, expectReject: true, label: 'عملة بلا سعر صرف', argsOverride: { _exchange_rate: null } }); },
  // ——— حالات الرفض والمكرر ———
  S_OVERSELL: async () => {
    const p = model.products[OVER_KEY];
    const lines = [{ key: OVER_KEY, cartons: 0, pieces: Math.max(p.stock, 0) + 5, mult: 1 }];
    const before = p.stock;
    const r = await sale(lines, { allowShortage: true, verifyDb: false });
    if (r.ok) { check('البيع الزائد يرفع علامة النقص', true, !!r.row.stock_shortage); const db = await fetchProduct(OVER_KEY); model.products[OVER_KEY].stock = Number(db.quantity); recordOp('observed', OVER_KEY, `مخزون بعد البيع الزائد: ${before} → ${db.quantity}`); }
  },
  S_REPLAY: async () => {
    const r = await sale(randomLines({ single: true }), { verifyDb: false });
    if (!r.ok) return;
    const again = await rpc('process_pos_sale_atomic', r.args);
    recordOp('sale_replay', r.opId, 'إعادة إرسال بنفس operation_id');
    const row = rows(again)[0];
    check('الإعادة تُعاد كـ already_processed', true, !!row?.already_processed);
    check('نفس رقم الفاتورة', r.row.invoice_number, row?.invoice_number);
    const cnt = rows(await rest('GET', `invoices?select=id&operation_id=eq.${r.opId}`)).length;
    check('فاتورة واحدة فقط بعد التكرار', 1, cnt, 0);
    await assertProducts(r.lines.map((l) => l.key), 'مخزون بعد التكرار');
  },
  S_REJ_PAYTYPE: async () => { const l = randomLines({ single: true }); await sale(l, { expectReject: true, label: 'نوع دفع غير صالح', argsOverride: { _payment_type: 'bitcoin' } }); await assertProducts(l.map((x) => x.key), 'بعد رفض نوع الدفع'); },
  S_REJ_NEGDISC: async () => { const l = randomLines({ single: true }); await sale(l, { expectReject: true, label: 'خصم سالب', argsOverride: { _discount: -5 } }); await assertProducts(l.map((x) => x.key), 'بعد رفض الخصم السالب'); },
  S_REJ_EMPTY: async () => { await sale(randomLines({ single: true }), { expectReject: true, label: 'سلة فارغة', argsOverride: { _items: [] } }); },
  S_REJ_UNKNOWN: async () => {
    const l = randomLines({ single: true });
    const items = buildItems(l, 1).items.map((it) => ({ ...it, product_id: crypto.randomUUID() }));
    await sale(l, { expectReject: true, label: 'منتج غير موجود', argsOverride: { _items: items } });
    await assertProducts(l.map((x) => x.key), 'بعد رفض منتج غير موجود');
  },
  S_REJ_NEGPRICE: async () => {
    const l = randomLines({ single: true });
    const items = buildItems(l, 1).items.map((it) => ({ ...it, amount_usd: -3 }));
    await sale(l, { expectReject: true, label: 'سعر سالب', argsOverride: { _items: items } });
    await assertProducts(l.map((x) => x.key), 'بعد رفض السعر السالب');
  },
  // ——— مرتجعات ———
  R_FULL_CASH: async () => {
    const r = await sale(randomLines({ mixed: chance(0.4) }), { payType: 'cash', verifyDb: false });
    if (!r.ok) return;
    const ref = await rpc('refund_invoice_atomic', { _invoice_number: r.row.invoice_number, _source: 'online' });
    recordOp('refund', r.row.invoice_number, 'مرتجع كامل نقدي', ref.ok ? 'تم' : `رُفض: ${ref.error}`);
    const row = rows(ref)[0];
    if (!ref.ok || !row?.success) { fail('المرتجع الكامل', ref.error); return; }
    for (const l of r.lines) model.products[l.key].stock += need(l);
    model.saleTotal = round8(model.saleTotal); // الفاتورة تبقى موجودة بحالة refunded
    await assertProducts(r.lines.map((l) => l.key), 'بعد المرتجع الكامل');
  },
  R_FULL_DEBT: async () => {
    const d = await makeDebt({ dp: 1 });
    if (!d) return;
    const ref = await rpc('refund_invoice_atomic', { _invoice_number: d.row.invoice_number, _source: 'online' });
    recordOp('refund', d.row.invoice_number, 'مرتجع كامل لفاتورة آجلة', ref.ok ? 'تم' : `رُفض: ${ref.error}`);
    const row = rows(ref)[0];
    if (!ref.ok || !row?.success) { fail('مرتجع آجل', ref.error); return; }
    for (const l of d.lines) model.products[l.key].stock += need(l);
    check('الدين المحذوف = المتبقي', d.plan.remaining, row.deleted_debt_amount);
    model.debts.delete(d.row.invoice_id);
    await assertProducts(d.lines.map((l) => l.key), 'بعد المرتجع الآجل');
  },
  R_DOUBLE: async () => {
    const r = await sale(randomLines({ single: true }), { verifyDb: false });
    if (!r.ok) return;
    const a = await rpc('refund_invoice_atomic', { _invoice_number: r.row.invoice_number, _source: 'online' });
    recordOp('refund', r.row.invoice_number, 'مرتجع أول', a.ok ? 'تم' : `رُفض: ${a.error}`);
    if (!a.ok) { fail('المرتجع الأول', a.error); return; }
    for (const l of r.lines) model.products[l.key].stock += need(l);
    const b = await rpc('refund_invoice_atomic', { _invoice_number: r.row.invoice_number, _source: 'online' });
    recordOp('refund', r.row.invoice_number, 'مرتجع ثانٍ (يجب ألا يغيّر المخزون)', b.ok ? 'مقبول' : `رُفض: ${b.error}`);
    check('المرتجع الثاني مرفوض أو يُعلَن already_refunded', true, !b.ok || !!rows(b)[0]?.already_refunded);
    await assertProducts(r.lines.map((l) => l.key), 'بعد المرتجع المكرر');
  },
  R_PARTIAL: async () => {
    const key = pick(POOL), q = rint(5, 9);
    const r = await sale([{ key, cartons: 0, pieces: q, mult: 1 }], { payType: 'cash', mode: 'exclusive', verifyDb: false });
    if (!r.ok) return;
    const k = rint(1, q - 2), p = model.products[key];
    const a = await rpc('refund_invoice_partial_atomic', { _invoice_number: r.row.invoice_number, _items: [{ product_id: p.id, product_name: p.name, quantity: k }], _operation_id: uid('rp') });
    recordOp('refund_partial', r.row.invoice_number, `جزئي ${k}/${q}`, a.ok ? 'تم' : `رُفض: ${a.error}`);
    if (!a.ok) { fail('المرتجع الجزئي', a.error); return; }
    p.stock += k;
    await assertProducts([key], 'بعد المرتجع الجزئي');
    const b = await rpc('refund_invoice_partial_atomic', { _invoice_number: r.row.invoice_number, _items: [{ product_id: p.id, product_name: p.name, quantity: q - k }], _operation_id: uid('rp') });
    recordOp('refund_partial', r.row.invoice_number, `المتبقي ${q - k}`, b.ok ? 'تم' : `رُفض: ${b.error}`);
    if (!b.ok) { fail('إكمال المرتجع الجزئي', b.error); return; }
    p.stock += q - k;
    const c = await rpc('refund_invoice_partial_atomic', { _invoice_number: r.row.invoice_number, _items: [{ product_id: p.id, product_name: p.name, quantity: 1 }], _operation_id: uid('rp') });
    recordOp('refund_partial', r.row.invoice_number, 'مرتجع زائد عن المباع', c.ok ? 'مقبول!' : `رُفض: ${c.error}`);
    check('مرتجع زائد عن المباع مرفوض', true, !c.ok);
    await assertProducts([key], 'بعد المرتجع الجزئي الكامل');
  },
  // ——— الديون ———
  DEBT_PAY_PARTIAL: async () => {
    const d = await makeDebt({ minTotal: 2 });
    if (!d) return;
    const amt = Math.max(0.01, round2(d.plan.remaining * pick([0.25, 0.5])));
    const r = await rpc('record_debt_payment_atomic', { _debt_id: d.debtId, _amount: amt, _operation_id: uid('dp'), _shift_id: null });
    recordOp('debt_payment', d.debtId, `دفعة ${amt}`, r.ok ? 'تم' : `رُفض: ${r.error}`);
    if (!r.ok) { fail('تسديد جزئي', r.error); return; }
    const rem = round2(d.plan.remaining - amt);
    model.debts.get(d.row.invoice_id).remaining = rem;
    const db = rows(await rest('GET', `debts?select=remaining_debt,total_paid,status&id=eq.${d.debtId}`))[0];
    check('المتبقي بعد الدفعة', rem, db?.remaining_debt);
  },
  DEBT_PAY_FULL: async () => {
    const d = await makeDebt({ minTotal: 2 });
    if (!d) return;
    const r = await rpc('record_debt_payment_atomic', { _debt_id: d.debtId, _amount: round2(d.plan.remaining), _operation_id: uid('dp'), _shift_id: null });
    recordOp('debt_payment', d.debtId, `سداد كامل ${round2(d.plan.remaining)}`, r.ok ? 'تم' : `رُفض: ${r.error}`);
    if (!r.ok) { fail('سداد كامل', r.error); return; }
    model.debts.delete(d.row.invoice_id);
    const db = rows(await rest('GET', `debts?select=remaining_debt,status&id=eq.${d.debtId}`))[0];
    check('المتبقي = 0 بعد السداد الكامل', 0, db?.remaining_debt);
    check('الدين مسدد', 'paid', db?.status);
  },
  DEBT_PAY_OVER_REJECT: async () => {
    const d = await makeDebt({ minTotal: 2 });
    if (!d) return;
    const r = await rpc('record_debt_payment_atomic', { _debt_id: d.debtId, _amount: round2(d.plan.remaining + 0.5), _operation_id: uid('dp'), _shift_id: null });
    recordOp('debt_payment', d.debtId, 'دفعة أكبر من المتبقي', r.ok ? 'مقبول!' : `رُفض: ${r.error}`);
    check('دفعة أكبر من المتبقي مرفوضة', true, !r.ok);
    const db = rows(await rest('GET', `debts?select=remaining_debt&id=eq.${d.debtId}`))[0];
    check('المتبقي لم يتغيّر', d.plan.remaining, db?.remaining_debt);
  },
  DEBT_PAY_ZERO_REJECT: async () => {
    const d = await makeDebt({ minTotal: 2 });
    if (!d) return;
    const r = await rpc('record_debt_payment_atomic', { _debt_id: d.debtId, _amount: pick([0, -1]), _operation_id: uid('dp'), _shift_id: null });
    recordOp('debt_payment', d.debtId, 'دفعة صفر/سالبة', r.ok ? 'مقبول!' : `رُفض: ${r.error}`);
    check('دفعة صفر أو سالبة مرفوضة', true, !r.ok);
  },
  DEBT_WRITEOFF: async () => {
    const d = await makeDebt({ minTotal: 2 });
    if (!d) return;
    const r = await rpc('writeoff_debt_atomic', { _debt_id: d.debtId, _reason: 'E2E شطب', _operation_id: uid('wo') });
    recordOp('debt_writeoff', d.debtId, 'شطب دين', r.ok ? 'تم' : `رُفض: ${r.error}`);
    if (!r.ok) { fail('شطب الدين', r.error); return; }
    model.debts.delete(d.row.invoice_id);
    const db = rows(await rest('GET', `debts?select=status,remaining_debt&id=eq.${d.debtId}`))[0];
    check('حالة الدين بعد الشطب', 'written_off', db?.status);
  },
  DEBT_CANCEL: async () => {
    const d = await makeDebt({ minTotal: 2 });
    if (!d) return;
    const r = await rpc('cancel_debt_atomic', { _debt_id: d.debtId, _reason: 'E2E إلغاء' });
    recordOp('debt_cancel', d.debtId, 'إلغاء دين', r.ok ? 'تم' : `رُفض: ${r.error}`);
    if (!r.ok) { fail('إلغاء الدين', r.error); return; }
    model.debts.delete(d.row.invoice_id);
    const db = rows(await rest('GET', `debts?select=status&id=eq.${d.debtId}`))[0];
    check('حالة الدين بعد الإلغاء', 'cancelled', db?.status);
    const again = await rpc('cancel_debt_atomic', { _debt_id: d.debtId, _reason: 'E2E إلغاء مكرر' });
    recordOp('debt_cancel', d.debtId, 'إلغاء مكرر', again.ok ? 'مقبول' : `رُفض: ${again.error}`);
  },
  // ——— محاولات الحذف ———
  DEL_UNPAID_ATTEMPT: async () => {
    const d = await makeDebt({ minTotal: 2 });
    if (!d) return;
    const del = await rest('DELETE', `invoices?id=eq.${d.row.invoice_id}`);
    const deleted = del.ok && rows(del).length > 0;
    recordOp('delete_invoice', d.row.invoice_number, 'محاولة حذف فاتورة آجلة غير مدفوعة', deleted ? 'حُذفت!' : 'مرفوضة');
    check('حذف فاتورة غير مدفوعة مباشرة من الجدول ممنوع', false, deleted);
    const still = rows(await rest('GET', `invoices?select=id&id=eq.${d.row.invoice_id}`)).length;
    check('الفاتورة ما زالت موجودة', 1, still, 0);
    const dbt = rows(await rest('GET', `debts?select=remaining_debt&id=eq.${d.debtId}`))[0];
    check('الدين لم يتأثر بمحاولة الحذف', d.plan.remaining, dbt?.remaining_debt);
    await assertProducts(d.lines.map((l) => l.key), 'المخزون بعد محاولة حذف فاتورة آجلة');
    if (deleted) { await resyncProducts(d.lines.map((l) => l.key)); model.debts.delete(d.row.invoice_id); }
  },
  DEL_PAID_ATTEMPT: async () => {
    const r = await sale(randomLines({ single: true }), { verifyDb: false });
    if (!r.ok) return;
    const del = await rest('DELETE', `invoices?id=eq.${r.row.invoice_id}`);
    const deleted = del.ok && rows(del).length > 0;
    recordOp('delete_invoice', r.row.invoice_number, 'محاولة حذف فاتورة مدفوعة', deleted ? 'حُذفت!' : 'مرفوضة');
    check('حذف فاتورة مدفوعة مباشرة من الجدول ممنوع', false, deleted);
    await assertProducts(r.lines.map((l) => l.key), 'المخزون بعد محاولة حذف فاتورة مدفوعة');
  },
  // ——— مصاريف وشريك ———
  EXP_ADD_DELETE: async () => {
    const amount = round2(rint(100, 9000) / 100), desc = uid('exp');
    const a = await rpc('add_expense_atomic', { _operation_id: uid('ex'), _expense_type: 'other', _amount: amount, _description: desc, _date: new Date().toISOString().slice(0, 10), _notes: 'E2E' });
    recordOp('expense_add', desc, `${amount}`, a.ok ? 'تم' : `رُفض: ${a.error}`);
    if (!a.ok) { fail('إضافة مصروف', a.error); return; }
    const row = rows(await rest('GET', `expenses?select=id,amount&description=eq.${encodeURIComponent(desc)}`))[0];
    check('المصروف محفوظ بالمبلغ الصحيح', amount, row?.amount);
    if (!row) return;
    const d = await rpc('delete_expense_atomic', { _expense_id: row.id, _reason: 'E2E حذف' });
    recordOp('expense_delete', row.id, '', d.ok ? 'تم' : `رُفض: ${d.error}`);
    check('حذف المصروف نجح', true, d.ok);
    const afterDel = rows(await rest('GET', `expenses?select=id,is_reversed&id=eq.${row.id}`))[0];
    check('المصروف معلَّم كمحذوف (حذف ناعم is_reversed)', true, !afterDel || afterDel.is_reversed === true);
  },
  EXP_REJECT_ZERO: async () => {
    const r = await rpc('add_expense_atomic', { _operation_id: uid('ex'), _expense_type: 'other', _amount: pick([0, -4]), _description: uid('exp0'), _date: new Date().toISOString().slice(0, 10), _notes: 'E2E' });
    recordOp('expense_add', '', 'مبلغ صفر/سالب', r.ok ? 'مقبول!' : `رُفض: ${r.error}`);
    check('مصروف صفر أو سالب مرفوض', true, !r.ok);
  },
  PARTNER_DEP_WD: async () => {
    if (!partnerId) { fail('لا يوجد شريك', 'فشل إنشاء الشريك في الإعداد'); return; }
    const cap = () => rest('GET', `partners?select=current_capital&id=eq.${partnerId}`).then((r) => Number(rows(r)[0]?.current_capital));
    const before = await cap();
    const amt = round2(rint(500, 4000) / 100);
    const dep = await rpc('partner_deposit_atomic', { _partner_id: partnerId, _amount_usd: amt, _deposit_target: 'capital', _notes: 'E2E' });
    recordOp('partner_deposit', partnerId, `${amt}`, dep.ok ? 'تم' : `رُفض: ${dep.error}`);
    if (!dep.ok) { fail('إيداع الشريك', dep.error); return; }
    check('رأس مال الشريك بعد الإيداع', round2(before + amt), await cap());
    const wd = await rpc('partner_withdrawal_atomic', { _partner_id: partnerId, _amount: round2(amt / 2), _withdrawal_type: 'capital', _notes: 'E2E' });
    recordOp('partner_withdrawal', partnerId, `${round2(amt / 2)}`, wd.ok ? 'تم' : `رُفض: ${wd.error}`);
    if (!wd.ok) { fail('سحب الشريك', wd.error); return; }
    check('رأس مال الشريك بعد السحب', round2(before + amt - round2(amt / 2)), await cap());
    const big = await rpc('partner_withdrawal_atomic', { _partner_id: partnerId, _amount: 1e9, _withdrawal_type: 'capital', _notes: 'E2E تجاوز' });
    recordOp('partner_withdrawal', partnerId, 'سحب أكبر من الرصيد', big.ok ? 'مقبول!' : `رُفض: ${big.error}`);
    check('سحب أكبر من رأس المال مرفوض', true, !big.ok);
  },
  // ——— الورديات ———
  SHIFT_CYCLE: async () => {
    const shift = await openShift(pick([0, 50, 100, 250.5]));
    if (!shift) return;
    const nOps = rint(2, 5);
    for (let i = 0; i < nOps; i++) {
      const kind = pick(['debt_pay', 'dep', 'wd', 'qp_cash']);
      if (kind === 'debt_pay') {
        const d = await makeDebt({ minTotal: 2 });
        if (!d) continue;
        const amt = Math.max(0.01, round2(d.plan.remaining * 0.5));
        const r = await rpc('record_debt_payment_atomic', { _debt_id: d.debtId, _amount: amt, _operation_id: uid('dp'), _shift_id: shift.id });
        recordOp('debt_payment', d.debtId, `في وردية: ${amt}`, r.ok ? 'تم' : `رُفض: ${r.error}`);
        if (r.ok) { shift.drawer = round2(shift.drawer + amt); model.debts.get(d.row.invoice_id).remaining = round2(d.plan.remaining - amt); } else fail('تسديد داخل وردية', r.error);
      } else if (kind === 'dep' && partnerId) {
        const amt = round2(rint(300, 2000) / 100);
        const r = await rpc('partner_deposit_atomic', { _partner_id: partnerId, _amount_usd: amt, _deposit_target: 'capital', _notes: 'E2E', _shift_id: shift.id });
        recordOp('partner_deposit', partnerId, `في وردية: ${amt}`, r.ok ? 'تم' : `رُفض: ${r.error}`);
        if (r.ok) shift.drawer = round2(shift.drawer + amt); else fail('إيداع شريك داخل وردية', r.error);
      } else if (kind === 'wd' && partnerId && shift.drawer > 5) {
        const amt = round2(Math.min(shift.drawer / 3, 20));
        const r = await rpc('partner_withdrawal_atomic', { _partner_id: partnerId, _amount: amt, _withdrawal_type: 'capital', _notes: 'E2E', _shift_id: shift.id });
        recordOp('partner_withdrawal', partnerId, `في وردية: ${amt}`, r.ok ? 'تم' : `رُفض: ${r.error}`);
        if (r.ok) shift.drawer = round2(shift.drawer - amt); else fail('سحب شريك داخل وردية', r.error);
      } else if (kind === 'qp_cash') {
        const key = pick(POOL), qty = rint(1, 20), cost = round2(rint(50, 400) / 100);
        const total = round8(qty * cost);
        const q = await quickPurchase({ key, qty, cost, method: 'cash', shiftId: shift.id, label: 'شراء نقدي داخل وردية' });
        if (q.r.ok && q.r.data?.success) shift.drawer = round2(shift.drawer - total);
      }
    }
    const variance = pick([0, 0, 3, -5, -0.5, 12.25]);
    await closeShift(shift, variance, variance !== 0 && chance(0.7) ? 'E2E فرق' : variance === 0 ? null : '');
  },
  // ——— الشراء السريع ———
  QP_NEW_CREDIT: async () => { const n = `${PREFIX} جديد ${rint(1000, 9999)}`; await quickPurchase({ name: n, qty: rint(5, 80), cost: round2(rint(50, 900) / 100), sale: round2(rint(100, 1500) / 100), label: 'منتج جديد آجل' }); },
  QP_EXISTING_CREDIT: async () => { const key = pick(POOL); await quickPurchase({ key, qty: rint(1, 120), cost: round2(rint(20, 1200) / 100), sale: chance(0.5) ? round2(rint(200, 1500) / 100) : undefined, label: 'منتج موجود آجل (WAC)' }); },
  QP_CASH_SHIFT: async () => {
    const shift = await openShift(300);
    if (!shift) return;
    const key = pick(POOL), qty = rint(1, 30), cost = round2(rint(50, 500) / 100);
    const q = await quickPurchase({ key, qty, cost, method: 'cash', shiftId: shift.id, label: 'شراء نقدي' });
    if (q.r.ok && q.r.data?.success) { shift.drawer = round2(shift.drawer - round8(qty * cost)); check('cash_amount في الرد', round8(qty * cost), q.r.data.cash_amount); }
    await closeShift(shift, 0, null);
  },
  QP_REPLAY: async () => {
    const key = pick(POOL), opId = crypto.randomUUID();
    const q = await quickPurchase({ key, qty: rint(2, 40), cost: round2(rint(50, 500) / 100), opId, label: 'شراء قبل التكرار' });
    if (!q.r.ok) return;
    const again = await rpc('process_quick_purchase_atomic', { _operation_id: opId, _purchase: { operationId: opId, productName: model.products[key].name, quantity: 5, costPrice: 1, paymentMethod: 'credit', productId: model.products[key].id } });
    recordOp('quick_purchase_replay', opId, 'إعادة إرسال بنفس operation_id');
    check('الإعادة already_processed', true, !!again.data?.already_processed);
    await assertProducts([key], 'المخزون بعد تكرار الشراء السريع');
  },
  QP_REJ_QTY0: async () => { const key = pick(POOL); await quickPurchase({ key, qty: 0, cost: 1, expectReject: true, label: 'كمية صفر' }); await assertProducts([key], 'بعد رفض كمية صفر'); },
  QP_REJ_NEGCOST: async () => { const key = pick(POOL); await quickPurchase({ key, qty: 3, cost: -2, expectReject: true, label: 'تكلفة سالبة' }); await assertProducts([key], 'بعد رفض التكلفة السالبة'); },
  QP_REJ_CASH_NOSHIFT: async () => { const key = pick(POOL); await quickPurchase({ key, qty: 3, cost: 2, method: 'cash', shiftId: crypto.randomUUID(), expectReject: true, label: 'نقدي بوردية غير موجودة' }); await assertProducts([key], 'بعد رفض النقدي بلا وردية'); },
  QP_REJ_METHOD: async () => { const key = pick(POOL); await quickPurchase({ key, qty: 3, cost: 2, method: 'barter', expectReject: true, label: 'طريقة دفع غير صالحة' }); await assertProducts([key], 'بعد رفض طريقة الدفع'); },
  QP_CANCEL: async () => {
    const key = pick(POOL), p = model.products[key];
    const beforeCost = p.cost, beforeStock = p.stock, qty = rint(2, 30);
    const q = await quickPurchase({ key, qty, cost: round2(rint(100, 900) / 100), label: 'شراء قبل الإلغاء' });
    if (!q.r.ok || !q.r.data?.success) return;
    const c = await rpc('cancel_purchase_invoice_atomic', { _invoice_id: q.opId, _reason: 'E2E إلغاء' });
    recordOp('purchase_cancel', q.opId, '', c.ok ? 'تم' : `رُفض: ${c.error}`);
    if (!c.ok) { fail('إلغاء فاتورة الشراء', c.error); return; }
    p.stock = beforeStock; p.cost = beforeCost;
    await assertProducts([key], 'بعد إلغاء الشراء (يعود المخزون والتكلفة)');
  },
  // ——— الواجهة ———
  UI_CASH_SALE: async () => { await uiSale('cash'); },
  UI_DEBT_SALE: async () => { await uiSale('debt'); },
  UI_TOUR: async () => { await uiTour(); },
};

// ───────────────────────── الإعداد ─────────────────────────
async function setup() {
  currentScenario = 'SETUP';
  if (!(await captureSession())) throw new Error('تعذّر التقاط جلسة الدخول. سجّل الدخول في المتصفح ثم أعد التشغيل.');
  userId = jwtSub();
  const st = rows(await rest('GET', 'stores?select=user_id,name,tax_enabled,tax_rate,primary_currency,exchange_rates&limit=1'))[0];
  if (!st) throw new Error('لا يوجد متجر لهذا الحساب (أكمل معالج الإعداد أولاً).');
  ownerId = st.user_id; originalStore = st;
  const okName = /E2E|اختبار|test/i.test(st.name || '');
  if (!okName && process.env.E2E_ALLOW_ANY_STORE !== '1') throw new Error(`اسم المتجر "${st.name}" لا يبدو متجر اختبار. أوقفت التشغيل لحماية البيانات (E2E_ALLOW_ANY_STORE=1 للتجاوز).`);
  log('المتجر:', st.name, '| البادئة:', PREFIX);

  if (!(await setTax(false, 0))) throw new Error('تعذّر ضبط الضريبة في الإعداد');

  // منتجات الاختبار عبر الشراء السريع (يختبر الدالة الجديدة أيضاً)
  const spec = [
    ['P1', 'حليب', 2.0, 3.0, 12, 33.0], ['P2', 'سكر', 1.0, 1.5, 1, 0], ['P3', 'أرز', 4.0, 6.0, 1, 0],
    ['P4', 'زيت', 7.5, 9.25, 6, 52.0], ['P5', 'علكة', 0.2, 0.35, 1, 0], ['P6', 'شاي', 3.3, 4.75, 24, 100.0],
  ];
  for (const [key, nm, cost, price, factor, bulkPrice] of spec) {
    const name = `${PREFIX} ${nm}`;
    const opId = crypto.randomUUID();
    const r = await rpc('process_quick_purchase_atomic', { _operation_id: opId, _purchase: { operationId: opId, productName: name, quantity: 3000, costPrice: cost, paymentMethod: 'credit', salePrice: price } });
    if (!r.ok) throw new Error(`فشل إنشاء المنتج ${key} عبر الشراء السريع: ${r.error}`);
    const row = rows(await rest('GET', `products?select=id,quantity,cost_price&name=eq.${encodeURIComponent(name)}`))[0];
    if (!row) throw new Error(`المنتج ${key} لم يُنشأ`);
    model.products[key] = { id: row.id, name, stock: Number(row.quantity), cost: Number(row.cost_price), price, factor, bulkPrice };
    if (factor > 1) await rest('PATCH', `products?id=eq.${row.id}`, { conversion_factor: factor, bulk_sale_price: bulkPrice, bulk_unit: 'كرتونة', small_unit: 'قطعة', track_by_unit: 'piece' });
    POOL.push(key);
  }
  // منتج البيع الزائد (مخزون صغير)
  const oName = `${PREFIX} نادر`, oOp = crypto.randomUUID();
  await rpc('process_quick_purchase_atomic', { _operation_id: oOp, _purchase: { operationId: oOp, productName: oName, quantity: 3, costPrice: 5, paymentMethod: 'credit', salePrice: 8 } });
  const orow = rows(await rest('GET', `products?select=id,quantity,cost_price&name=eq.${encodeURIComponent(oName)}`))[0];
  if (!orow) throw new Error('منتج البيع الزائد لم يُنشأ');
  OVER_KEY = 'OVER';
  model.products[OVER_KEY] = { id: orow.id, name: oName, stock: Number(orow.quantity), cost: Number(orow.cost_price), price: 8, factor: 1, bulkPrice: 0 };

  // شريك للاختبارات المالية
  const pr = await rest('POST', 'partners', { user_id: ownerId, name: `${PREFIX} شريك`, share_percentage: 40, initial_capital: 1000, current_capital: 1000 });
  partnerId = rows(pr)[0]?.id || null;
  if (!partnerId) log('تحذير: تعذّر إنشاء الشريك — سيفشل سيناريو الشريك (مسجّل كفشل):', pr.error);

  await assertProducts(Object.keys(model.products), 'بعد الإعداد');
}

// ───────────────────────── الجدولة الصارمة ─────────────────────────
function buildPlan() {
  const plan = [];
  for (const [id, min] of Object.entries(REQUIRED)) for (let i = 0; i < min; i++) plan.push(id);
  for (let i = plan.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [plan[i], plan[j]] = [plan[j], plan[i]]; }
  return plan;
}
const fillPick = () => { const ids = Object.keys(FILL_WEIGHTS); const total = ids.reduce((s, k) => s + FILL_WEIGHTS[k], 0); let x = rnd() * total; for (const k of ids) { x -= FILL_WEIGHTS[k]; if (x <= 0) return k; } return ids[0]; };

async function runScenario(id) {
  currentScenario = id;
  cov[id].runs += 1;
  try { await SC[id](); }
  catch (e) { fail('استثناء غير متوقع', e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e); try { await page.keyboard.press('Escape'); } catch { /* ignore */ } }
}

async function checkpoint(tag) {
  currentScenario = 'CHECKPOINT';
  cov.CHECKPOINT = cov.CHECKPOINT || { runs: 0, checks: 0, fails: 0 };
  cov.CHECKPOINT.runs += 1;
  const keys = Object.keys(model.products);
  for (const key of keys) {
    const db = await fetchProduct(key);
    const p = model.products[key];
    const okQ = check(`نقطة فحص ${tag}: كمية ${key}`, p.stock, db?.quantity, 0.0011);
    const okC = check(`نقطة فحص ${tag}: تكلفة ${key}`, p.cost, db?.cost_price, 0.0002);
    if ((!okQ || !okC) && db) { p.stock = Number(db.quantity); p.cost = Number(db.cost_price); } // إعادة مزامنة حتى لا يتكرر نفس الخلل
  }
}

async function finalReconcile() {
  currentScenario = 'FINAL';
  cov.FINAL = { runs: 1, checks: 0, fails: 0 };
  await checkpoint('نهائي');
  currentScenario = 'FINAL';
  const inv = rows(await rest('GET', `invoices?select=id,invoice_number,total,debt_remaining,status,operation_id,payment_type&operation_id=like.${PREFIX}-s-*&limit=5000`));
  check('عدد فواتير البيع (RPC) المحفوظة', model.saleInvoices - (model.uiSales || 0), inv.length, 0);
  const numbers = inv.map((r) => r.invoice_number);
  check('لا أرقام فواتير مكررة', numbers.length, new Set(numbers).size, 0);
  const ops = inv.map((r) => r.operation_id);
  check('لا عمليات مكررة', ops.length, new Set(ops).size, 0);
  // الديون المفتوحة: مجموع المتبقي في القاعدة لعملاء هذا التشغيل = مجموع دفتر الديون الخارجي
  const modelOpen = round2([...model.debts.values()].reduce((s, d) => s + d.remaining, 0));
  const dbDebts = rows(await rest('GET', `debts?select=remaining_debt,status,customer_name&customer_name=like.${encodeURIComponent(`${PREFIX} عميل`)}*&limit=5000`));
  const dbOpen = round2(dbDebts.filter((d) => !['cancelled', 'written_off', 'paid'].includes(d.status)).reduce((s, d) => s + Number(d.remaining_debt || 0), 0));
  check('مجموع الديون المفتوحة (قاعدة البيانات = الدفتر الخارجي)', modelOpen, dbOpen, 0.05);
  const open = rows(await rest('GET', `cash_shifts?select=id&closed_at=is.null&cashier_name=eq.E2E`));
  check('كل ورديات الاختبار مقفلة', 0, open.length, 0);
  check('عدد الورديات المقفلة = المفتوحة', model.shiftsOpened, model.shiftsClosed, 0);
}

// ───────────────────────── التشغيل ─────────────────────────
let exitCode = 0;
try {
  await setup();
  const plan = buildPlan();
  log(`البدء: ${plan.length} سيناريو مطلوب كحدّ أدنى، والهدف ${TARGET_OPS} عملية.`);
  let sinceCheckpoint = 0, n = 0;
  while (plan.length || opCount < TARGET_OPS) {
    const id = plan.length ? plan.shift() : fillPick();
    const before = opCount;
    await runScenario(id);
    n += 1; sinceCheckpoint += opCount - before;
    if (sinceCheckpoint >= CHECKPOINT_EVERY) { sinceCheckpoint = 0; await checkpoint(`#${opCount}`); log(`  … ${opCount} عملية، ${checks.filter((c) => !c.pass).length + failures.length} فشل`); }
    if (n > 20000) throw new Error('حلقة غير منتهية؟ توقفت بعد 20000 سيناريو.');
  }
  await finalReconcile();
} catch (e) {
  log('خطأ فادح:', e.message);
  failures.push({ scenario: currentScenario, name: 'SETUP/RUN', message: e.message });
  exitCode = 4;
} finally {
  try { if (ownerId && originalStore) await rest('PATCH', `stores?user_id=eq.${ownerId}`, { tax_enabled: originalStore.tax_enabled, tax_rate: originalStore.tax_rate }); } catch { /* ignore */ }
}

// ───────────────────────── البوابة الصارمة + التقرير ─────────────────────────
const missing = Object.entries(REQUIRED).filter(([id, min]) => cov[id].runs < min).map(([id, min]) => `${id} (${cov[id].runs}/${min})`);
const failedChecks = checks.filter((c) => !c.pass);
const incomplete = missing.length > 0 || opCount < TARGET_OPS || exitCode === 4;
const verdict = exitCode === 4 ? 'لم يكتمل: تعذّر الإعداد/الاتصال' : incomplete ? 'غير مكتمل' : (failedChecks.length || failures.length) ? 'فشل' : 'نجح كل شيء';
if (exitCode !== 4) exitCode = incomplete ? 3 : (failedChecks.length || failures.length) ? 2 : 0;

fs.writeFileSync(path.join(OUT, 'ledger.csv'), '﻿' + [['seq', 'time', 'scenario', 'kind', 'ref', 'detail', 'result'], ...ledger].map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'checks.json'), JSON.stringify({ checks, failures, coverage: cov }, null, 2));
const report = [
  `# تقرير اختبار الضغط — PosFlow`, ``,
  `- **الحكم:** ${verdict}`, `- البادئة: \`${PREFIX}\` | المتجر: ${originalStore?.name ?? '-'} | الاتصال: ${attached ? 'نفس المتصفح المفتوح (CDP)' : 'نافذة جديدة'}`,
  `- العمليات المنفذة: ${opCount} (المطلوب ${TARGET_OPS}) | الفحوص: ${checks.length - failedChecks.length}/${checks.length} ناجح | أخطاء تنفيذ: ${failures.length}`,
  `- البذرة: ${SEED} (نفس البذرة = نفس تسلسل العمليات)`, ``,
  `## بوابة التغطية (لا يُقبل تخطي أي حالة)`,
  missing.length ? `**حالات لم تبلغ حدّها الأدنى:** ${missing.join('، ')}` : 'كل الحالات المطلوبة نُفِّذت بحدّها الأدنى أو أكثر.', ``,
  '| الحالة | الحد الأدنى | نُفذت | فحوص | إخفاقات |', '|---|---|---|---|---|',
  ...Object.entries(REQUIRED).map(([id, min]) => `| ${id} | ${min} | ${cov[id].runs} | ${cov[id].checks} | ${cov[id].fails} |`), ``,
  `## الفحوص الفاشلة (${failedChecks.length})`,
  failedChecks.length ? '| الحالة | الفحص | المتوقع | الفعلي |\n|---|---|---|---|\n' + failedChecks.slice(0, 300).map((c) => `| ${c.scenario} | ${c.name} | ${c.expected} | ${c.actual} |`).join('\n') : 'لا يوجد.', ``,
  `## أخطاء التنفيذ (${failures.length})`,
  failures.length ? '| الحالة | الخطوة | الرسالة |\n|---|---|---|\n' + failures.slice(0, 200).map((f) => `| ${f.scenario} | ${f.name} | ${String(f.message).replace(/\|/g, '/')} |`).join('\n') : 'لا يوجد.', ``,
  `## أخطاء console في المتصفح (${consoleErrors.length})`,
  consoleErrors.length ? [...new Set(consoleErrors)].slice(0, 40).map((e) => `- ${e.replace(/\n/g, ' ')}`).join('\n') : 'لا يوجد.', ``,
  `## حدود وافتراضات`,
  `- معظم العمليات تُرسل مباشرة إلى دوال الخادم (RPC) بجلسة المستخدم نفسها، أي تختبر منطق الخادم والأرقام؛ مبيعات الواجهة (UI_*) تختبر شاشة السلة والإجمالي المعروض.`,
  `- افتراضات قد تحتاج تأكيداً عند فشلها: نوع سحب الشريك \`capital\`، وقيم حالة الدين (\`paid\`/\`cancelled\`/\`written_off\`)، وحذف المصروف يُزيل الصف.`,
  `- لا يغطي: العمل دون اتصال، حساب كاشير (صلاحيات)، الطباعة، والمستودعات.`,
  `- بيانات التشغيل تبقى في المتجر وتبدأ بـ \`${PREFIX}\`. أُعيد إعداد الضريبة إلى قيمته الأصلية.`, ``,
].join('\n');
fs.writeFileSync(path.join(OUT, 'report.md'), report);
log(`الحكم: ${verdict} | عمليات ${opCount} | فحوص فاشلة ${failedChecks.length} | أخطاء ${failures.length} | حالات ناقصة ${missing.length}`);
log('النتائج في:', OUT);
try { if (!attached) await context.close(); } catch { /* ignore */ } // المتصفح المتصل به يبقى مفتوحاً
process.exit(exitCode);
