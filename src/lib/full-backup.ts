/**
 * PosFlow — النسخ الاحتياطي الكامل والاستعادة الكاملة.
 * يأخذ كل جداول العمل (كل الأعمدة كما هي في قاعدة البيانات) مع صور المنتجات،
 * ويُستعاد كاملاً دون فقدان أي عمود. يُغني عن تصدير JSON القديم.
 */
import { supabase } from '@/integrations/supabase/client';
import { loadCategoriesLocally } from '@/lib/cloud/categories-cloud';

export const BACKUP_FORMAT = 'posflow-full-backup';
export const BACKUP_VERSION = 3;
export const BACKUP_EXT = 'posflowbak';
const IMAGE_BUCKET = 'product-images';

// جداول مرتبطة بالحساب مباشرة (user_id) — بترتيب الاستعادة (الآباء قبل الأبناء)
const OWNER_TABLES = [
  'categories', 'customers', 'suppliers', 'partners', 'warehouses', 'products', 'library_members',
  'store_settings', 'product_serials', 'book_loans', 'product_serial_events', 'invoices',
  'debts', 'debt_payments', 'debt_writeoffs', 'customer_credit_ledger', 'expenses', 'recurring_expenses',
  'profit_records', 'cash_shifts', 'shift_transactions', 'purchase_invoices', 'purchase_returns',
  'supplier_ledger_entries', 'partner_ledger_entries', 'stock_counts', 'stock_damages', 'stock_movements',
  'stock_transfers', 'maintenance_services', 'accounting_period_closures', 'invoice_sequences', 'activity_log',
] as const;

// جداول فرعية بلا user_id: تُجلب عبر الجدول الأب
const CHILD_TABLES: Array<{ table: string; parent: string; fk: string }> = [
  { table: 'invoice_items', parent: 'invoices', fk: 'invoice_id' },
  { table: 'warehouse_stock', parent: 'warehouses', fk: 'warehouse_id' },
  { table: 'purchase_invoice_items', parent: 'purchase_invoices', fk: 'invoice_id' },
  { table: 'purchase_return_items', parent: 'purchase_returns', fk: 'return_id' },
  { table: 'stock_count_items', parent: 'stock_counts', fk: 'count_id' },
  { table: 'stock_transfer_items', parent: 'stock_transfers', fk: 'transfer_id' },
];

// ترتيب الاستعادة النهائي (الابن مباشرة بعد أبيه)
const RESTORE_ORDER: string[] = (() => {
  const out: string[] = [];
  for (const t of OWNER_TABLES) {
    out.push(t);
    for (const c of CHILD_TABLES) if (c.parent === t) out.push(c.table);
  }
  return out;
})();

const NO_ID_TABLES = new Set(['invoice_sequences', 'store_settings']);

type Row = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as unknown as { from: (t: string) => any; storage: typeof supabase.storage };

export interface BackupImage { type: string; b64: string }
export interface FullBackup {
  format: typeof BACKUP_FORMAT;
  version: number;
  app: 'PosFlow';
  createdAt: string;
  ownerId: string;
  tables: Record<string, Row[]>;
  images: Record<string, BackupImage>;
  counts: Record<string, number>;
}

export interface RestoreReport {
  restored: Record<string, number>;
  failed: Array<{ table: string; message: string }>;
  imagesRestored: number;
}

const PAGE = 1000;

async function fetchAll(table: string, apply: (q: any) => any): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = apply(db.from(table).select('*'));
    if (!NO_ID_TABLES.has(table)) q = q.order('id', { ascending: true });
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data || []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function fetchByParent(table: string, fk: string, ids: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const rows = await fetchAll(table, (q) => q.in(fk, chunk));
    out.push(...rows);
  }
  return out;
}

const blobToB64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const b64ToBlob = (b64: string, type: string): Blob => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
};

const isStoragePath = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && !/^(https?:|data:|blob:)/.test(v);

/** يبني نسخة كاملة من بيانات الحساب الحالي */
export async function buildFullBackup(onProgress?: (msg: string) => void): Promise<FullBackup> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('يجب تسجيل الدخول أولاً');
  const uid = user.id;

  const tables: Record<string, Row[]> = {};
  for (const t of OWNER_TABLES) {
    onProgress?.(t);
    try {
      tables[t] = await fetchAll(t, (q) => q.eq('user_id', uid));
    } catch (e) {
      // جدول غير متاح لهذا الحساب: نتركه فارغاً بدل إفشال النسخة كلها
      console.warn('[FullBackup] skip table', t, e);
      tables[t] = [];
    }
  }
  for (const c of CHILD_TABLES) {
    onProgress?.(c.table);
    const ids = (tables[c.parent] || []).map((r) => String(r.id)).filter(Boolean);
    try {
      tables[c.table] = ids.length ? await fetchByParent(c.table, c.fk, ids) : [];
    } catch (e) {
      console.warn('[FullBackup] skip table', c.table, e);
      tables[c.table] = [];
    }
  }

  // الصور
  const images: Record<string, BackupImage> = {};
  const paths = new Set<string>();
  for (const p of tables.products || []) if (isStoragePath(p.image_url)) paths.add(p.image_url as string);
  for (const s of tables.store_settings || []) if (isStoragePath(s.logo_url)) paths.add(s.logo_url as string);
  onProgress?.('images');
  for (const path of paths) {
    try {
      const { data, error } = await db.storage.from(IMAGE_BUCKET).download(path.replace(/^\/+/, ''));
      if (error || !data) continue;
      images[path] = { type: data.type || 'image/jpeg', b64: await blobToB64(data) };
    } catch { /* صورة مفقودة: نتجاوزها */ }
  }

  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(tables)) counts[k] = v.length;

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: 'PosFlow',
    createdAt: new Date().toISOString(),
    ownerId: uid,
    tables,
    images,
    counts,
  };
}

/** ترميز الملف (ضغط gzip إن توفر) */
export async function encodeBackup(b: FullBackup): Promise<Blob> {
  const json = JSON.stringify(b);
  const raw = new Blob([json], { type: 'application/json' });
  const CS = (globalThis as unknown as { CompressionStream?: new (f: string) => TransformStream }).CompressionStream;
  if (!CS) return raw;
  return new Response(raw.stream().pipeThrough(new CS('gzip')), { headers: { 'Content-Type': 'application/gzip' } }).blob();
}

/** قراءة الملف (gzip أو نص عادي) */
export async function decodeBackupFile(file: Blob): Promise<unknown> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  let text: string;
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const DS = (globalThis as unknown as { DecompressionStream?: new (f: string) => TransformStream }).DecompressionStream;
    if (!DS) throw new Error('هذا الجهاز لا يدعم فك ضغط النسخة');
    text = await new Response(file.stream().pipeThrough(new DS('gzip'))).text();
  } else {
    text = await file.text();
  }
  return JSON.parse(text);
}

export const backupFileName = (d = new Date()): string =>
  `PosFlow-Backup-${d.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${BACKUP_EXT}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNew = (v: unknown): string => (typeof v === 'string' && UUID_RE.test(v) ? v : crypto.randomUUID());

/**
 * تحويل ملف النظام القديم (HyperPOS / FlowPOS Pro) إلى صفوف قاعدة بيانات PosFlow.
 * يُستخدم مرة لنقل البيانات القديمة؛ لا يمس أرصدة المخزون ولا يعيد توزيع الأرباح.
 */
export function convertLegacyExport(src: { data?: Record<string, unknown> }, uid: string): FullBackup {
  const d = (src.data || {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const arr = (k: string): any[] => (Array.isArray(d[k]) ? d[k] : []); // eslint-disable-line @typescript-eslint/no-explicit-any
  const num = (v: unknown, def = 0) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || def);
  const tables: Record<string, Row[]> = {};

  tables.warehouses = arr('hyperpos_warehouses_v1').map((w) => ({
    id: uuidOrNew(w.id), user_id: uid, name: w.name || 'المستودع الرئيسي', type: w.type || 'main',
    assigned_cashier_id: null, address: w.address ?? null, phone: w.phone ?? null,
    is_default: !!w.is_default, is_active: w.is_active !== false,
    created_at: w.created_at, updated_at: w.updated_at,
  }));

  tables.products = arr('hyperpos_products_v1').map((p) => ({
    id: uuidOrNew(p.id), user_id: uid, name: p.name || 'منتج', barcode: p.barcode || null,
    category: p.category || null, description: p.description ?? null,
    image_url: p.image || p.imageUrl || null,
    cost_price: num(p.costPrice), sale_price: num(p.salePrice ?? p.price), quantity: num(p.quantity ?? p.stock),
    min_stock_level: Math.round(num(p.minStockLevel, 5)), unit: p.unit ?? null,
    expiry_date: p.expiryDate || null, supplier: p.supplier ?? null, location: p.location ?? null, notes: p.notes ?? null,
    custom_fields: p.customFields || {}, archived: !!p.archived,
    created_at: p.createdAt, updated_at: p.updatedAt,
    bulk_unit: p.bulkUnit ?? null, small_unit: p.smallUnit ?? null,
    conversion_factor: Math.round(num(p.conversionFactor, 1)) || 1,
    bulk_cost_price: num(p.bulkCostPrice), bulk_sale_price: num(p.bulkSalePrice),
    track_by_unit: p.trackByUnit || 'piece', purchase_history: p.purchaseHistory || [],
    barcode2: p.barcode2 ?? null, barcode3: p.barcode3 ?? null, variant_label: p.variantLabel ?? null,
    labor_cost: num(p.laborCost), serial_number: p.serialNumber || null,
    warranty_months: p.warrantyMonths != null ? Math.round(num(p.warrantyMonths)) : null,
    wholesale_price: p.wholesalePrice != null ? num(p.wholesalePrice) : null,
    batch_number: p.batchNumber || null, weight: p.weight || null, size: p.size || null, color: p.color || null,
    fabric_type: p.fabricType || null, author: p.author || null, publisher: p.publisher || null,
    table_number: p.tableNumber || null, order_notes: p.orderNotes || null,
  }));
  const productIds = new Set(tables.products.map((p) => String(p.id)));

  const invoices: Row[] = [];
  const items: Row[] = [];
  let seq = 0;
  for (const inv of arr('hyperpos_invoices_v1')) {
    const id = uuidOrNew(inv.dbId || null);
    const created = inv.createdAt ? new Date(inv.createdAt) : new Date();
    invoices.push({
      id, user_id: uid, invoice_number: String(inv.id), invoice_type: inv.type || 'sale',
      date: created.toISOString().slice(0, 10), time: created.toISOString().slice(11, 19),
      cashier_id: null, cashier_name: inv.cashierName ?? null,
      customer_name: inv.customerName ?? null, customer_phone: inv.customerPhone ?? null,
      subtotal: num(inv.subtotal), discount: num(inv.discount), discount_percentage: num(inv.discountPercentage),
      tax_rate: num(inv.taxRate), tax_amount: num(inv.taxAmount), total: num(inv.total), profit: num(inv.profit),
      currency: inv.currency || 'USD', exchange_rate: num(inv.exchangeRate, 1) || 1,
      payment_type: inv.paymentType || 'cash', status: inv.status || 'paid',
      debt_paid: num(inv.debtPaid), debt_remaining: num(inv.debtRemaining), notes: inv.notes ?? null,
      created_at: inv.createdAt, updated_at: inv.updatedAt || inv.createdAt,
      invoice_sequence: ++seq,
      currency_code: inv.currencyCode || inv.currency || null, currency_symbol: inv.currencySymbol ?? null,
      total_in_currency: inv.totalInCurrency != null ? num(inv.totalInCurrency) : null,
    });
    for (const it of inv.items || []) {
      const pid = typeof it.id === 'string' && productIds.has(it.id) ? it.id : null;
      items.push({
        id: crypto.randomUUID(), invoice_id: id, product_id: pid, product_name: it.name || 'منتج',
        quantity: num(it.quantity, 1), unit_price: num(it.price), cost_price: num(it.costPrice),
        profit: num(it.profit), unit: it.unit ?? null,
      });
    }
  }
  tables.invoices = invoices;
  tables.invoice_items = items;

  tables.expenses = arr('hyperpos_expenses_v1').map((e) => ({
    id: uuidOrNew(e.id), user_id: uid, expense_type: e.type || 'other', amount: num(e.amount),
    description: e.customType || e.typeLabel || null, date: e.date || null, notes: e.notes ?? null,
    distributions: e.distributions || [], created_at: e.createdAt, cashier_id: null,
    is_reversed: !!e.is_reversed, original_currency: e.originalCurrency || 'USD',
    original_amount: e.originalAmount != null ? num(e.originalAmount) : num(e.amount),
    exchange_rate: num(e.exchangeRate, 1) || 1,
  }));

  tables.recurring_expenses = arr('hyperpos_recurring_expenses_v1').map((r) => ({
    id: uuidOrNew(r.id), user_id: uid, expense_type: r.type || 'other', amount: num(r.amount),
    description: r.description ?? null, interval: r.interval || 'monthly', next_due_date: r.nextDueDate || null,
    is_active: r.isActive !== false, created_at: r.createdAt, auto_pay: !!r.autoPay,
    interval_days: r.intervalDays != null ? Math.round(num(r.intervalDays)) : null,
    last_paid_date: r.lastPaidDate || null, name: (r.name || '').trim() || null, notes: r.notes ?? null,
  }));

  tables.partners = arr('hyperpos_partners_v1').map((p) => ({
    id: uuidOrNew(p.id), user_id: uid, name: p.name || 'شريك', phone: p.phone ?? null, email: p.email ?? null,
    initial_capital: num(p.initialCapital), current_capital: num(p.currentCapital),
    share_percentage: num(p.sharePercentage), expense_share_percentage: num(p.expenseSharePercentage),
    access_all: p.accessAll !== false, category_shares: p.categoryShares || [],
    total_profit_earned: num(p.totalProfitEarned), total_withdrawn: num(p.totalWithdrawn),
    current_balance: num(p.currentBalance), pending_profit: num(p.pendingProfit), confirmed_profit: num(p.confirmedProfit),
    pending_profit_details: p.pendingProfitDetails || [], profit_history: p.profitHistory || [],
    expense_history: p.expenseHistory || [], capital_history: p.capitalHistory || [],
    withdrawal_history: p.capitalWithdrawals || p.withdrawalHistory || [],
    joined_date: p.joinedDate || null,
  }));

  const wh = new Set(tables.warehouses.map((w) => String(w.id)));
  tables.warehouse_stock = arr('hyperpos_warehouse_stock_v1')
    .filter((s) => wh.has(s.warehouse_id) && productIds.has(s.product_id))
    .map((s) => ({
      id: uuidOrNew(s.id), warehouse_id: s.warehouse_id, product_id: s.product_id,
      quantity: num(s.quantity), quantity_bulk: Math.round(num(s.quantity_bulk)), last_updated: s.last_updated,
    }));

  // Categories come from the category list itself (so an empty category is kept), plus any category a product uses
  const listed = (loadCategoriesLocally() || []).map((c) => String(c.name || '').trim());
  const usedByProducts = tables.products.map((p) => String(p.category || '').trim());
  const cats = Array.from(new Set([...listed, ...usedByProducts].filter(Boolean)));
  tables.categories = cats.map((name) => ({ id: crypto.randomUUID(), user_id: uid, name }));

  // إزالة المفاتيح ذات القيم غير المعرّفة (undefined) كي لا تتحول إلى null وتكسر القيم الافتراضية
  for (const rows of Object.values(tables)) for (const r of rows) for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];

  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(tables)) counts[k] = v.length;
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, app: 'PosFlow', createdAt: new Date().toISOString(), ownerId: uid, tables, images: {}, counts };
}

/** يتحقق من الملف المقروء ويحوّله إلى FullBackup (يدعم الملف القديم تلقائياً) */
export async function parseBackup(raw: unknown): Promise<FullBackup> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('يجب تسجيل الدخول أولاً');
  const obj = raw as Record<string, unknown>;
  if (obj && obj.format === BACKUP_FORMAT && obj.tables) return obj as unknown as FullBackup;
  if (obj && obj.data && typeof obj.data === 'object' && Object.keys(obj.data as object).some((k) => k.startsWith('hyperpos_') || k.startsWith('posflow_'))) {
    // الملف القديم: مفاتيح hyperpos_ ؛ نقبل posflow_ بنفس الصيغة
    const norm: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj.data as Record<string, unknown>)) norm[k.replace(/^posflow_/, 'hyperpos_')] = v;
    return convertLegacyExport({ data: norm }, user.id);
  }
  throw new Error('ملف غير معروف: ليس نسخة PosFlow ولا ملف النظام القديم');
}

/** استعادة كاملة: ترحيل المعرفات إلى الحساب الحالي ثم رفع الجداول بالترتيب */
export async function restoreFullBackup(b: FullBackup, onProgress?: (msg: string) => void): Promise<RestoreReport> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('يجب تسجيل الدخول أولاً');
  const uid = user.id;
  const oldUid = b.ownerId;
  const report: RestoreReport = { restored: {}, failed: [], imagesRestored: 0 };

  // الصور أولاً ثم إعادة كتابة المسارات
  const pathMap = new Map<string, string>();
  onProgress?.('images');
  for (const [path, img] of Object.entries(b.images || {})) {
    const base = path.split('/').pop() || `${Date.now()}.jpg`;
    const newPath = `${uid}/products/${base}`;
    try {
      const { error } = await db.storage.from(IMAGE_BUCKET).upload(newPath, b64ToBlob(img.b64, img.type), { contentType: img.type, upsert: true });
      if (!error) { pathMap.set(path, newPath); report.imagesRestored++; }
    } catch { /* نتابع */ }
  }

  for (const table of RESTORE_ORDER) {
    const rows = b.tables?.[table];
    if (!rows || rows.length === 0) continue;
    onProgress?.(table);
    const prepared = rows.map((r) => {
      const o: Row = { ...r };
      if ('user_id' in o || OWNER_TABLES.includes(table as never)) o.user_id = uid;
      if (oldUid && oldUid !== uid) {
        for (const k of Object.keys(o)) if (o[k] === oldUid) o[k] = uid;
      }
      if (typeof o.image_url === 'string' && pathMap.has(o.image_url)) o.image_url = pathMap.get(o.image_url)!;
      if (typeof o.logo_url === 'string' && pathMap.has(o.logo_url)) o.logo_url = pathMap.get(o.logo_url)!;
      return o;
    });
    let ok = 0;
    let lastErr = '';
    for (let i = 0; i < prepared.length; i += 200) {
      const chunk = prepared.slice(i, i + 200);
      const onConflict = table === 'store_settings' ? 'user_id' : undefined;
      const { error } = await db.from(table).upsert(chunk, onConflict ? { onConflict } : undefined);
      if (!error) { ok += chunk.length; continue; }
      // إن فشلت الدفعة نجرب صفاً صفاً لعزل الصف المعطوب
      for (const row of chunk) {
        const { error: e2 } = await db.from(table).upsert(row, onConflict ? { onConflict } : undefined);
        if (!e2) ok++; else lastErr = e2.message;
      }
    }
    report.restored[table] = ok;
    if (ok < prepared.length) report.failed.push({ table, message: `${prepared.length - ok} من ${prepared.length} لم تُستعد${lastErr ? ` — ${lastErr}` : ''}` });
  }
  return report;
}
