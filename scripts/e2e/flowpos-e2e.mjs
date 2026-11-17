#!/usr/bin/env node
/**
 * PosFlow — اختبار آلي فعلي عبر المتصفح (Playwright)
 *
 * يفتح التطبيق الحقيقي، ينشئ منتجات عبر فاتورة شراء، ينفّذ مبيعات نقدية وآجلة من نقطة البيع
 * (منها كرتونة + قطعة لنفس المنتج)، ثم يقارن ما حُفظ في قاعدة البيانات بدفتره الخارجي.
 *
 * التشغيل:
 *   npm run dev                         (في نافذة أخرى، يفتح http://localhost:8080)
 *   node scripts/e2e/flowpos-e2e.mjs
 *
 * خيارات (متغيرات بيئة):
 *   E2E_BASE_URL   عنوان التطبيق            (الافتراضي http://localhost:8080)
 *   E2E_SALES      عدد المبيعات النقدية      (الافتراضي 40)
 *   E2E_DEBT_SALES عدد المبيعات الآجلة       (الافتراضي 5)
 *   E2E_SEED       بذرة العشوائية            (الافتراضي 1)
 *   E2E_HEADLESS   1 للتشغيل بلا نافذة       (الافتراضي نافذة ظاهرة)
 *
 * تسجيل الدخول: السكربت لا يكتب بريداً ولا كلمة مرور. إن لم تكن مسجّلاً، سجّل الدخول يدوياً
 * في النافذة التي يفتحها (بحساب اختبار)، وهو يكمل لوحده. الجلسة تُحفظ في .e2e-profile.
 *
 * المخرجات في e2e-results/<وقت التشغيل>/ :
 *   report.md, ledger.csv, snapshots.csv, final-state.json, screenshots/, page-text/
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

// ───────────────────────── الإعدادات ─────────────────────────
const BASE_URL = (process.env.E2E_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const N_SALES = Number(process.env.E2E_SALES || 40);
const N_DEBT = Number(process.env.E2E_DEBT_SALES || 5);
const SEED = Number(process.env.E2E_SEED || 1);
const HEADLESS = process.env.E2E_HEADLESS === '1';

const RUN_ID = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 12); // yymmddHHMM
const PREFIX = `E2E${RUN_ID}`;
const OUT = path.resolve('e2e-results', new Date().toISOString().replace(/[:.]/g, '-'));
const SHOTS = path.join(OUT, 'screenshots');
const TEXTS = path.join(OUT, 'page-text');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(TEXTS, { recursive: true });

/** المنتجات: تُنشأ عبر فاتورة الشراء الأولى. factor > 1 يعني أن المنتج يُباع بالكرتونة أيضاً. */
const PRODUCTS = [
  { key: 'P1', name: `${PREFIX} حليب`, cost: 2.0, price: 3.0, factor: 12, bulkPrice: 33.0, buy: 400 },
  { key: 'P2', name: `${PREFIX} سكر`, cost: 1.0, price: 1.5, factor: 1, bulkPrice: 0, buy: 300 },
  { key: 'P3', name: `${PREFIX} أرز`, cost: 4.0, price: 6.0, factor: 1, bulkPrice: 0, buy: 200 },
  { key: 'P4', name: `${PREFIX} زيت`, cost: 7.5, price: 9.25, factor: 6, bulkPrice: 52.0, buy: 240 },
  { key: 'P5', name: `${PREFIX} علكة`, cost: 0.2, price: 0.35, factor: 1, bulkPrice: 0, buy: 500 },
];
/** فاتورة شراء ثانية لاختبار المتوسط المرجّح (WAC). */
const SECOND_PURCHASE = [{ key: 'P1', qty: 100, cost: 2.6 }, { key: 'P3', qty: 50, cost: 4.4 }];
const ROUTES = ['pos', 'dashboard', 'products', 'purchases', 'invoices', 'customers', 'debts', 'expenses', 'partners', 'cash-shifts', 'reports', 'settings'];

// ───────────────────────── أدوات عامة ─────────────────────────
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seed = SEED;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** يحوّل نصاً فيه رقم (أرقام عربية أو لاتينية، فواصل آلاف) إلى رقم. */
function parseNumber(text) {
  if (!text) return NaN;
  const latin = String(text)
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/٫/g, '.').replace(/[٬,](?=\d{3}\b)/g, '');
  const m = latin.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

const csvCell = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const writeCsv = (file, header, rows) => fs.writeFileSync(path.join(OUT, file), '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n');

// ───────────────────────── السجلات ─────────────────────────
const ledger = [];      // كل عملية نفّذها السكربت
const snapshots = [];   // قراءات للمقارنة
const checks = [];      // نتائج التحقق
const failures = [];    // أخطاء التنفيذ
let shotSeq = 0;

/** الدفتر الخارجي: الحالة المتوقعة التي يحسبها السكربت بنفسه. */
const expected = {
  stock: Object.fromEntries(PRODUCTS.map((p) => [p.key, 0])),
  cost: Object.fromEntries(PRODUCTS.map((p) => [p.key, p.cost])),
  cashSalesTotal: 0, debtSalesTotal: 0, downPayments: 0, invoiceCount: 0,
};

function addCheck(name, expectedValue, actualValue, tolerance = 0.011) {
  const e = Number(expectedValue), a = Number(actualValue);
  const numeric = Number.isFinite(e) && Number.isFinite(a);
  const pass = numeric ? Math.abs(e - a) <= tolerance : String(expectedValue) === String(actualValue);
  checks.push({ name, expected: expectedValue, actual: actualValue, pass });
  log(pass ? '  ✓' : '  ✗', name, '| متوقع', expectedValue, '| فعلي', actualValue);
  return pass;
}

// ───────────────────────── المتصفح ─────────────────────────
const context = await chromium.launchPersistentContext(path.resolve('.e2e-profile'), {
  headless: HEADLESS,
  viewport: { width: 1366, height: 820 }, // عرض سطح المكتب: السلة ظاهرة دائماً بجانب المنتجات
  locale: 'ar',
});
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(15000);

// التقاط عنوان Supabase ومفتاح الجلسة من طلبات التطبيق نفسه (للقراءة من قاعدة البيانات لاحقاً)
const api = { url: '', apikey: '', auth: '' };
page.on('request', (req) => {
  const url = req.url();
  const m = url.match(/^(https:\/\/[a-z0-9]+\.supabase\.co)\/(rest|auth)\/v1\//);
  if (!m) return;
  const h = req.headers();
  if (h.apikey) { api.url = m[1]; api.apikey = h.apikey; }
  if (h.authorization && h.authorization.startsWith('Bearer ') && h.authorization.slice(7) !== h.apikey) api.auth = h.authorization;
});
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300)); });
page.on('pageerror', (err) => consoleErrors.push('PAGEERROR ' + String(err).slice(0, 300)));

async function shot(label) {
  shotSeq += 1;
  const file = `${String(shotSeq).padStart(3, '0')}_${label.replace(/[^\w؀-ۿ-]+/g, '_').slice(0, 60)}.png`;
  try { await page.screenshot({ path: path.join(SHOTS, file), fullPage: false }); } catch { /* ignore */ }
  return file;
}

async function goto(route) {
  await page.goto(`${BASE_URL}/#/${route}`);
  await page.waitForLoadState('domcontentloaded');
  await sleep(1200);
}

/** ينفّذ خطوة ويسجّل فشلها بصورة دون إيقاف الاختبار كله. */
async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    const file = await shot(`FAIL_${name}`);
    const message = String(error && error.message ? error.message : error).split('\n')[0].slice(0, 300);
    failures.push({ step: name, message, screenshot: file });
    log('  ✗ فشلت الخطوة:', name, '—', message);
    // إغلاق أي نافذة مفتوحة حتى لا تعطّل الخطوة التالية
    try { await page.keyboard.press('Escape'); await sleep(300); await page.keyboard.press('Escape'); } catch { /* ignore */ }
    return null;
  }
}

/** قراءة من قاعدة البيانات بجلسة المستخدم نفسها (تخضع لنفس صلاحيات RLS). */
async function db(pathAndQuery, init = {}) {
  if (!api.url || !api.auth) throw new Error('لم تُلتقط جلسة Supabase بعد');
  const res = await fetch(`${api.url}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: { apikey: api.apikey, Authorization: api.auth, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DB ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const fetchProducts = async () => {
  const rows = await db(`products?select=id,name,quantity,cost_price,sale_price,conversion_factor,bulk_sale_price&name=like.${encodeURIComponent(PREFIX)}*`);
  return Object.fromEntries(PRODUCTS.map((p) => [p.key, rows.find((r) => r.name === p.name) || null]));
};

async function snapshot(checkpoint) {
  const products = await fetchProducts();
  for (const p of PRODUCTS) {
    const row = products[p.key];
    snapshots.push([snapshots.length + 1, new Date().toISOString(), checkpoint, 'products(db)', `${p.key}.quantity`, row ? row.quantity : 'غير موجود', expected.stock[p.key]]);
    snapshots.push([snapshots.length + 1, new Date().toISOString(), checkpoint, 'products(db)', `${p.key}.cost_price`, row ? row.cost_price : 'غير موجود', round2(expected.cost[p.key] * 10000) / 10000]);
  }
  return products;
}

async function tour(tag) {
  log(`جولة الصفحات (${tag})`);
  for (const route of ROUTES) {
    await step(`tour_${tag}_${route}`, async () => {
      const started = Date.now();
      await goto(route);
      await sleep(1500);
      const file = await shot(`${tag}_${route}`);
      const text = await page.locator('body').innerText();
      fs.writeFileSync(path.join(TEXTS, `${tag}_${route}.txt`), text);
      snapshots.push([snapshots.length + 1, new Date().toISOString(), tag, route, 'load_ms', Date.now() - started, '']);
      snapshots.push([snapshots.length + 1, new Date().toISOString(), tag, route, 'screenshot', file, '']);
    });
  }
}

// ───────────────────────── الدخول ─────────────────────────
log('فتح التطبيق:', BASE_URL);
await goto('pos');
const posReady = page.locator('[data-tour="product-grid"]');
if (!(await posReady.isVisible().catch(() => false))) {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(' سجّل الدخول بحساب الاختبار في نافذة المتصفح، وأكمل معالج الإعداد إن ظهر.');
  console.log(' السكربت ينتظر حتى تظهر نقطة البيع (15 دقيقة كحد أقصى)...');
  console.log('════════════════════════════════════════════════════════════\n');
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await posReady.isVisible().catch(() => false)) break;
    await sleep(2000);
    if (!page.url().includes('/pos') && !page.url().includes('/login') && !page.url().includes('/signup')) {
      await goto('pos').catch(() => {});
    }
  }
  if (!(await posReady.isVisible().catch(() => false))) {
    console.error('لم تظهر نقطة البيع. أوقفت الاختبار.');
    await context.close();
    process.exit(1);
  }
}
await sleep(2500);
if (!api.auth) { await page.reload(); await sleep(4000); }
if (!api.auth) {
  console.error('لم أستطع التقاط جلسة الدخول من طلبات التطبيق. أوقفت الاختبار.');
  await context.close();
  process.exit(1);
}
log('الجلسة جاهزة. بادئة هذا التشغيل:', PREFIX);
const startedAt = new Date().toISOString();

await tour('before');

// ───────────────────────── المشتريات ─────────────────────────
async function createPurchase(number, items) {
  await goto('purchases');
  await page.getByTestId('purchase-new').click();
  await page.getByTestId('pi-number').fill(number);
  await page.getByTestId('pi-supplier').fill(`${PREFIX} مورد`);
  // آجل، حتى لا يتأثر الصندوق (إن وُجد الخيار)
  await page.locator('label[for="invoice-pay-credit"]').click({ timeout: 2000 }).catch(() => {});
  await page.getByTestId('pi-create').click();

  for (const item of items) {
    const nameInput = page.getByTestId('pii-name');
    if (!(await nameInput.isVisible().catch(() => false))) await page.getByTestId('pi-add-item').click();
    await nameInput.fill(item.name);
    await sleep(400);
    await page.getByTestId('pii-qty').fill(String(item.qty));
    await page.getByTestId('pii-cost').fill(String(item.cost));
    if (item.price !== undefined) await page.getByTestId('pii-sale').fill(String(item.price));
    await page.getByTestId('pii-submit').click();
    await page.getByTestId('pii-name').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    await sleep(500);
  }
  await shot(`purchase_${number}_items`);
  await page.getByTestId('pi-go-finalize').click();
  await sleep(500);
  await page.getByTestId('pi-finalize').click();
  await page.getByTestId('pi-finalize').waitFor({ state: 'hidden', timeout: 30000 });
  await sleep(1500);
  await shot(`purchase_${number}_done`);
}

log('فاتورة الشراء الأولى (تنشئ المنتجات)');
const pi1Ok = await step('purchase_1', async () => {
  await createPurchase(`${PREFIX}-PI1`, PRODUCTS.map((p) => ({ name: p.name, qty: p.buy, cost: p.cost, price: p.price })));
  for (const p of PRODUCTS) expected.stock[p.key] += p.buy;
  ledger.push([ledger.length + 1, new Date().toISOString(), 'purchase', `${PREFIX}-PI1`, '', PRODUCTS.map((p) => `${p.key}×${p.buy}@${p.cost}`).join(' | '), round2(PRODUCTS.reduce((s, p) => s + p.buy * p.cost, 0)), '', 'تم']);
  return true;
});

let productsNow = pi1Ok ? await step('read_products_1', () => snapshot('after_PI1')) : null;
if (!productsNow || PRODUCTS.some((p) => !productsNow[p.key])) {
  failures.push({ step: 'setup', message: 'لم تُنشأ كل المنتجات عبر فاتورة الشراء؛ تعذّر إكمال المبيعات', screenshot: '' });
} else {
  for (const p of PRODUCTS) {
    addCheck(`بعد الشراء الأول: كمية ${p.key}`, expected.stock[p.key], productsNow[p.key].quantity);
    addCheck(`بعد الشراء الأول: تكلفة ${p.key}`, expected.cost[p.key], productsNow[p.key].cost_price, 0.0001);
  }

  // إعداد البيع بالكرتونة مباشرة في قاعدة البيانات (نموذج الشراء لا يحفظ إعدادات الوحدة للمنتج الجديد)
  await step('unit_settings', async () => {
    for (const p of PRODUCTS.filter((x) => x.factor > 1)) {
      await db(`products?id=eq.${productsNow[p.key].id}`, { method: 'PATCH', body: JSON.stringify({ conversion_factor: p.factor, bulk_sale_price: p.bulkPrice, bulk_unit: 'كرتونة', small_unit: 'قطعة', track_by_unit: 'piece' }) });
    }
    await page.reload();
    await sleep(5000);
  });

  // إعادة اعتماد نفس الفاتورة يجب ألا تضيف مخزوناً: نتحقق بعد الشراء الثاني من الكميات فقط
  log('فاتورة الشراء الثانية (المتوسط المرجّح)');
  await step('purchase_2', async () => {
    await createPurchase(`${PREFIX}-PI2`, SECOND_PURCHASE.map((i) => ({ name: PRODUCTS.find((p) => p.key === i.key).name, qty: i.qty, cost: i.cost })));
    for (const i of SECOND_PURCHASE) {
      const before = expected.stock[i.key];
      expected.cost[i.key] = before > 0 ? (before * expected.cost[i.key] + i.qty * i.cost) / (before + i.qty) : i.cost;
      expected.stock[i.key] += i.qty;
    }
    ledger.push([ledger.length + 1, new Date().toISOString(), 'purchase', `${PREFIX}-PI2`, '', SECOND_PURCHASE.map((i) => `${i.key}×${i.qty}@${i.cost}`).join(' | '), round2(SECOND_PURCHASE.reduce((s, i) => s + i.qty * i.cost, 0)), '', 'تم']);
  });
  productsNow = await step('read_products_2', () => snapshot('after_PI2')) || productsNow;
  for (const i of SECOND_PURCHASE) {
    addCheck(`بعد الشراء الثاني: كمية ${i.key}`, expected.stock[i.key], productsNow[i.key]?.quantity);
    addCheck(`بعد الشراء الثاني: تكلفة ${i.key} (WAC)`, round2(expected.cost[i.key] * 10000) / 10000, productsNow[i.key]?.cost_price, 0.0002);
  }

  // ───────────────────────── نقطة البيع ─────────────────────────
  const grid = page.locator('[data-tour="product-grid"]');
  const searchInput = page.locator('[data-tour="search-bar"] input').first();

  async function addToCart(product, { cartons = 0, pieces = 0 }) {
    await searchInput.fill(product.name);
    await sleep(700);
    const card = grid.getByText(product.name, { exact: false }).first();
    if (cartons > 0) {
      // الكرتونة أولاً: أضف قطعة، حوّل السطر إلى كرتونة، ثم زد العدد
      await card.click();
      await sleep(300);
      await page.getByTestId('cart-toggle-unit').last().click();
      await sleep(300);
      for (let i = 1; i < cartons; i++) { await page.getByTestId('cart-qty-plus').last().click(); await sleep(150); }
    }
    for (let i = 0; i < pieces; i++) { await card.click(); await sleep(200); }
    await searchInput.fill('');
    await sleep(300);
  }

  function planSale(index) {
    // توزيع ثابت يضمن تغطية الحالات المهمة، والباقي عشوائي بالبذرة
    const lines = [];
    const bulkProducts = PRODUCTS.filter((p) => p.factor > 1);
    if (index % 5 === 0) {
      const p = bulkProducts[index % bulkProducts.length];
      lines.push({ p, cartons: rint(1, 2), pieces: rint(1, 3) }); // كرتونة + قطعة لنفس المنتج
    } else if (index % 5 === 1) {
      lines.push({ p: pick(bulkProducts), cartons: 1, pieces: 0 }); // كرتونة فقط
    }
    const others = PRODUCTS.filter((p) => !lines.some((l) => l.p.key === p.key));
    const count = rint(1, 3);
    for (let i = 0; i < count && others.length; i++) {
      const p = others.splice(Math.floor(rnd() * others.length), 1)[0];
      lines.push({ p, cartons: 0, pieces: rint(1, 4) });
    }
    const subtotal = round2(lines.reduce((s, l) => s + l.cartons * l.p.bulkPrice + l.pieces * l.p.price, 0));
    const discount = index % 7 === 3 ? Math.min(1, Math.floor(subtotal)) : 0; // خصم ثابت 1.00
    return { lines, subtotal, discount, total: round2(subtotal - discount) };
  }

  const describe = (plan) => plan.lines.map((l) => `${l.p.key}:${l.cartons ? l.cartons + 'ك' : ''}${l.cartons && l.pieces ? '+' : ''}${l.pieces ? l.pieces + 'ق' : ''}`).join(' | ');
  const piecesOf = (l) => l.cartons * l.p.factor + l.pieces;

  async function sell(index, kind, customer) {
    const plan = planSale(index);
    await goto('pos');
    for (const line of plan.lines) await addToCart(line.p, line);
    if (plan.discount > 0) await page.getByTestId('cart-discount-fixed').fill(String(plan.discount));
    await sleep(400);
    const shownText = await page.getByTestId('cart-total').innerText();
    const shown = parseNumber(shownText);
    let downPayment = 0;

    if (kind === 'cash') {
      await page.locator('[data-tour="cash-btn"]').first().click();
      await page.getByTestId('cash-confirm').click();
      await page.getByTestId('cash-confirm').waitFor({ state: 'hidden', timeout: 30000 });
    } else {
      await page.getByTestId('cart-customer').fill(customer);
      await sleep(300);
      await page.keyboard.press('Escape').catch(() => {});
      if (index % 2 === 0) {
        downPayment = Math.min(2, Math.floor(plan.total));
        if (downPayment > 0) await page.getByTestId('cart-received').fill(String(downPayment));
      }
      await page.locator('[data-tour="debt-btn"]').first().click();
      const phone = page.locator('#cart-new-customer-phone');
      if (await phone.isVisible({ timeout: 1500 }).catch(() => false)) await phone.fill(`05${String(10000000 + rint(0, 89999999))}`);
      await page.getByTestId('debt-confirm').click();
      await page.getByTestId('debt-confirm').waitFor({ state: 'hidden', timeout: 30000 });
    }
    await sleep(900);

    // نجحت العملية: حدّث الدفتر الخارجي
    for (const line of plan.lines) expected.stock[line.p.key] -= piecesOf(line);
    expected.invoiceCount += 1;
    if (kind === 'cash') expected.cashSalesTotal = round2(expected.cashSalesTotal + plan.total);
    else { expected.debtSalesTotal = round2(expected.debtSalesTotal + plan.total); expected.downPayments = round2(expected.downPayments + downPayment); }
    ledger.push([ledger.length + 1, new Date().toISOString(), kind === 'cash' ? 'cash_sale' : 'debt_sale', '', customer || '', describe(plan), plan.total, shown, Math.abs(shown - plan.total) <= 0.011 ? 'تم' : 'فرق في الإجمالي المعروض']);
    if (Math.abs(shown - plan.total) > 0.011) addCheck(`إجمالي السلة للعملية ${ledger.length}`, plan.total, shown);
  }

  log(`مبيعات نقدية: ${N_SALES}`);
  for (let i = 0; i < N_SALES; i++) {
    await step(`cash_sale_${i + 1}`, () => sell(i, 'cash'));
    if ((i + 1) % 10 === 0) {
      log(`  نقطة فحص بعد ${i + 1} عملية بيع`);
      await shot(`pos_after_${i + 1}_sales`);
      const rows = await step(`checkpoint_${i + 1}`, async () => { await sleep(4000); return snapshot(`after_${i + 1}_sales`); });
      if (rows) for (const p of PRODUCTS) addCheck(`بعد ${i + 1} بيع: كمية ${p.key}`, expected.stock[p.key], rows[p.key]?.quantity);
    }
  }

  log(`مبيعات آجلة: ${N_DEBT}`);
  for (let i = 0; i < N_DEBT; i++) {
    await step(`debt_sale_${i + 1}`, () => sell(1000 + i, 'debt', `${PREFIX} عميل ${(i % 3) + 1}`));
  }

  // ───────────────────────── التحقق النهائي من قاعدة البيانات ─────────────────────────
  log('انتظار اكتمال المزامنة ثم التحقق');
  let invoices = [];
  await step('final_db_check', async () => {
    const deadline = Date.now() + 90 * 1000;
    while (Date.now() < deadline) {
      invoices = await db(`invoices?select=*&created_at=gte.${encodeURIComponent(startedAt)}&order=created_at.asc`);
      if (invoices.length >= expected.invoiceCount) break;
      await sleep(4000);
    }
    const rows = await snapshot('final');
    for (const p of PRODUCTS) {
      addCheck(`نهائي: كمية ${p.key}`, expected.stock[p.key], rows[p.key]?.quantity);
      addCheck(`نهائي: تكلفة ${p.key}`, round2(expected.cost[p.key] * 10000) / 10000, rows[p.key]?.cost_price, 0.0002);
    }
    const sum = (list) => round2(list.reduce((s, r) => s + Number(r.total || 0), 0));
    const isDebt = (r) => /debt|credit|آجل|دين/i.test(String(r.payment_type || ''));
    addCheck('نهائي: عدد الفواتير المحفوظة', expected.invoiceCount, invoices.length, 0);
    addCheck('نهائي: مجموع المبيعات النقدية', expected.cashSalesTotal, sum(invoices.filter((r) => !isDebt(r))));
    addCheck('نهائي: مجموع المبيعات الآجلة', expected.debtSalesTotal, sum(invoices.filter(isDebt)));
    const numbers = invoices.map((r) => r.invoice_number);
    addCheck('نهائي: لا توجد أرقام فواتير مكررة', numbers.length, new Set(numbers).size, 0);
    const ops = invoices.map((r) => r.operation_id).filter(Boolean);
    addCheck('نهائي: لا توجد عمليات مكررة (operation_id)', ops.length, new Set(ops).size, 0);

    fs.writeFileSync(path.join(OUT, 'final-state.json'), JSON.stringify({
      run: { prefix: PREFIX, baseUrl: BASE_URL, startedAt, finishedAt: new Date().toISOString(), seed: SEED },
      expected,
      products: Object.fromEntries(PRODUCTS.map((p) => [p.key, rows[p.key]])),
      invoices: invoices.map((r) => ({ invoice_number: r.invoice_number, total: r.total, payment_type: r.payment_type, status: r.status, debt_paid: r.debt_paid, debt_remaining: r.debt_remaining, operation_id: r.operation_id, created_at: r.created_at })),
    }, null, 2));
  });
}

await tour('after');

// ───────────────────────── الملفات ─────────────────────────
writeCsv('ledger.csv', ['seq', 'time', 'operation_type', 'reference', 'customer', 'items', 'total_expected', 'total_shown', 'result'], ledger);
writeCsv('snapshots.csv', ['seq', 'time', 'checkpoint', 'page', 'field', 'value_actual', 'value_expected'], snapshots);

const passed = checks.filter((c) => c.pass).length;
const failed = checks.filter((c) => !c.pass);
const report = [
  `# تقرير الاختبار الآلي — PosFlow`,
  ``,
  `- **النتيجة:** ${failed.length === 0 && failures.length === 0 ? 'كل الفحوص نجحت' : `${failed.length} فحص فاشل، ${failures.length} خطوة لم تكتمل`}`,
  `- العنوان: ${BASE_URL}`,
  `- بادئة البيانات: \`${PREFIX}\` (كل ما أنشأه هذا التشغيل يبدأ بها)`,
  `- البداية: ${startedAt} — النهاية: ${new Date().toISOString()}`,
  `- العمليات المنفّذة: ${ledger.length} (مبيعات نقدية مطلوبة ${N_SALES}، آجلة ${N_DEBT})`,
  `- الفحوص: ${passed} ناجح من ${checks.length}`,
  ``,
  `## الفحوص الفاشلة`,
  failed.length ? '| الفحص | المتوقع | الفعلي |\n|---|---|---|\n' + failed.map((c) => `| ${c.name} | ${c.expected} | ${c.actual} |`).join('\n') : 'لا يوجد.',
  ``,
  `## خطوات لم تكتمل`,
  failures.length ? '| الخطوة | الرسالة | الصورة |\n|---|---|---|\n' + failures.map((f) => `| ${f.step} | ${f.message.replace(/\|/g, '/')} | ${f.screenshot} |`).join('\n') : 'لا يوجد.',
  ``,
  `## كل الفحوص`,
  '| الفحص | المتوقع | الفعلي | النتيجة |\n|---|---|---|---|\n' + checks.map((c) => `| ${c.name} | ${c.expected} | ${c.actual} | ${c.pass ? 'نجح' : 'فشل'} |`).join('\n'),
  ``,
  `## أخطاء ظهرت في console المتصفح (${consoleErrors.length})`,
  consoleErrors.length ? [...new Set(consoleErrors)].slice(0, 40).map((e) => `- ${e.replace(/\n/g, ' ')}`).join('\n') : 'لا يوجد.',
  ``,
  `## حدود هذا الاختبار`,
  `- أرقام "الفعلي" للمخزون والفواتير مقروءة من قاعدة البيانات بجلسة المستخدم. إجمالي السلة مقروء من الشاشة. صور كل الصفحات ونصوصها في المجلدين screenshots و page-text.`,
  `- إعدادات الكرتونة للمنتجات ضُبطت مباشرة في قاعدة البيانات، لا من الواجهة.`,
  `- لا يغطي: المرتجعات، تسديد الديون، المصاريف، الشركاء، إقفال الوردية، والعمل بدون إنترنت.`,
  ``,
].join('\n');
fs.writeFileSync(path.join(OUT, 'report.md'), report);

log('انتهى. النتائج في:', OUT);
log(`الفحوص: ${passed}/${checks.length} — خطوات لم تكتمل: ${failures.length}`);
await context.close();
process.exit(failed.length || failures.length ? 2 : 0);
