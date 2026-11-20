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

/** تسخين الكاش أثناء الاتصال: المنتجات المتتبَّعة + أرقامها المتوفرة */
let lastWarm = 0;
export async function warmSerialCache(force = false): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  if (!force && Date.now() - lastWarm < 10 * 60 * 1000) return;
  lastWarm = Date.now();
  try {
    const { data: prods, error } = await db.from('products').select('id').eq('track_serials', true).limit(500);
    if (error) return;
    const c = readCache();
    const p = pendingSold();
    for (const pr of prods || []) {
      c.tracked[pr.id] = true;
      const { data } = await db.from('product_serials').select('serial').eq('product_id', pr.id).eq('status', 'in_stock').order('serial').limit(500);
      c.inStock[pr.id] = (data || []).map((r: { serial: string }) => r.serial).filter((x: string) => !p.has(x));
    }
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
