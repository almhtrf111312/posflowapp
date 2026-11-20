import { supabase } from '@/integrations/supabase/client';

// اختيارات الأرقام التسلسلية للسلة الحالية (في الذاكرة فقط؛ الخادم هو المرجع عند الحفظ)
const selected = new Map<string, string[]>();

export const getSelectedSerials = (productId: string): string[] | undefined => selected.get(productId);
export const setSelectedSerials = (productId: string, serials: string[]) => { selected.set(productId, serials); };
export const clearSelectedSerials = (productIds: string[]) => { productIds.forEach(id => selected.delete(id)); };

const db = supabase as any;

// ===== كاش محلي للعمل بدون اتصال =====
const CACHE_KEY = 'posflow_serial_cache_v1';
const PENDING_KEY = 'posflow_serial_pending_sold_v1';
type SerialCache = { tracked: Record<string, boolean>; inStock: Record<string, string[]>; at: number };

const readJson = <T,>(k: string, d: T): T => {
  try { const r = localStorage.getItem(k); return r ? (JSON.parse(r) as T) : d; } catch { return d; }
};
const writeJson = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
const readCache = (): SerialCache => readJson<SerialCache>(CACHE_KEY, { tracked: {}, inStock: {}, at: 0 });
const pendingSold = (): Set<string> => new Set(readJson<string[]>(PENDING_KEY, []));

/** عند حفظ بيع (حتى لو في الطابور): إخفاء الأرقام المباعة محلياً فوراً */
export const markSerialsSoldLocally = (serials: string[]) => {
  if (!serials.length) return;
  const p = pendingSold(); serials.forEach(x => p.add(x)); writeJson(PENDING_KEY, [...p]);
  const c = readCache();
  for (const k of Object.keys(c.inStock)) c.inStock[k] = c.inStock[k].filter(x => !p.has(x));
  writeJson(CACHE_KEY, c);
};
/** بعد نجاح مزامنة البيع على الخادم */
export const confirmSerialsSynced = (serials: string[]) => {
  if (!serials.length) return;
  const p = pendingSold(); serials.forEach(x => p.delete(x)); writeJson(PENDING_KEY, [...p]);
};

/** بحث محلي عن رقم تسلسلي/IMEI متوفر -> معرّف المنتج (يعمل بدون اتصال) */
export const findSerialLocal = (code: string): string | undefined => {
  const q = (code || '').trim().toLowerCase();
  if (q.length < 5) return undefined;
  const c = readCache(); const p = pendingSold();
  for (const [pid, list] of Object.entries(c.inStock)) {
    if (list.some(x => x.toLowerCase() === q && !p.has(x))) return pid;
  }
  return undefined;
};

/** تسخين الكاش أثناء الاتصال: المنتجات المتتبَّعة + أرقامها المتوفرة */
let lastWarm = 0;
export async function warmSerialCache(force = false): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  if (!force && Date.now() - lastWarm < 10 * 60 * 1000) return;
  lastWarm = Date.now();
  try {
    const { data: prods, error } = await db.from('products').select('id').eq('track_serials', true).limit(1000);
    if (error) return;
    const c = readCache();
    const p = pendingSold();
    const grouped: Record<string, string[]> = {};
    for (const pr of prods || []) { c.tracked[pr.id] = true; grouped[pr.id] = []; }
    // استعلام مجمّع واحد (صفحات 1000) بدل استعلام لكل منتج
    for (let from = 0; from < 20000; from += 1000) {
      const { data, error: e2 } = await db.from('product_serials').select('product_id, serial').eq('status', 'in_stock').order('product_id').range(from, from + 999);
      if (e2) return;
      for (const r of (data || []) as { product_id: string; serial: string }[]) {
        if (grouped[r.product_id] && !p.has(r.serial) && grouped[r.product_id].length < 500) grouped[r.product_id].push(r.serial);
      }
      if (!data || data.length < 1000) break;
    }
    for (const pid of Object.keys(grouped)) c.inStock[pid] = grouped[pid].sort();
    c.at = Date.now();
    writeJson(CACHE_KEY, c);
  } catch { /* ignore */ }
}

export async function loadTrackedProducts(ids: string[]): Promise<Record<string, boolean>> {
  if (ids.length === 0) return {};
  const cache = readCache();
  const fromCache = () => { const o: Record<string, boolean> = {}; ids.forEach(i => { if (cache.tracked[i]) o[i] = true; }); return o; };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return fromCache();
  try {
    const { data, error } = await db.from('products').select('id, track_serials').in('id', ids);
    if (error) return fromCache();
    const out: Record<string, boolean> = {};
    for (const r of data || []) { out[r.id] = !!r.track_serials; cache.tracked[r.id] = !!r.track_serials; }
    writeJson(CACHE_KEY, cache);
    return out;
  } catch { return fromCache(); }
}

export async function loadInStockSerials(productId: string): Promise<string[]> {
  const cache = readCache();
  const p = pendingSold();
  const fromCache = () => (cache.inStock[productId] || []).filter(x => !p.has(x));
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return fromCache();
  try {
    const { data, error } = await db
      .from('product_serials').select('serial').eq('product_id', productId).eq('status', 'in_stock').order('serial').limit(500);
    if (error) return fromCache();
    const list = (data || []).map((r: { serial: string }) => r.serial);
    cache.inStock[productId] = list; writeJson(CACHE_KEY, cache);
    return list.filter((x: string) => !p.has(x));
  } catch { return fromCache(); }
}

export async function lookupSerialCloud(serial: string): Promise<any[]> {
  const { data, error } = await db.rpc('lookup_serial', { _serial: serial });
  if (error) throw error;
  return data || [];
}
