// مسح بيانات وضع التجربة المحلي وإعادة تعبئتها بالنماذج.
// خاص بوضع الضيف (بدون إيميل): كتالوج نموذجي مؤقت. حسابات الإيميل لا تُمسح بياناتها.
// لا يُمسح: الجلسة، الجهاز، الترخيص، سجل الحظر، اللغة، موافقة الخصوصية، وعلامة وضع التجربة نفسها.
import { Capacitor } from '@capacitor/core';
import { saveProducts } from '@/lib/products-store';
import { isGuestDemoMode } from '@/lib/demo-data';
import { saveCategories } from '@/lib/categories-store';
import { buildTrialCatalog, buildTrialCategories, applyTrialDisplayDefaults } from '@/lib/trial-sample-catalog';

const WINDOW_START_KEY = 'hp_trial_window_start';
const PRODUCTS_STORAGE_KEY = 'hyperpos_products_v1';
const PRODUCTS_CACHE_KEY = 'hyperpos_products_cache';
const CATEGORIES_CACHE_KEY = 'hyperpos_categories_cache';
const CATALOG_VERSION_KEY = 'hp_trial_catalog_version';
const CATALOG_VERSION = '2';

/** بادئات تُمسح من localStorage (بيانات الأعمال والكاش والطابور والتشخيص) */
const WIPE_PREFIXES = ['hyperpos_', 'flowpos_', 'fps_swr_', 'hp_sync_', 'hp_audit_', 'hp_offline_', 'hp_radar_'];

/** مفاتيح تبقى دائماً (داخل البادئات المحذوفة) */
const PRESERVE_EXACT = new Set<string>([
  'hyperpos_language',
  'hyperpos_theme',
  'hyperpos_theme_v1',
  'hyperpos_device_id',
  'hyperpos_stay_logged_in',
  'hyperpos_setup_complete',
  'hyperpos_settings_v1',
  'hyperpos_session_cache',
  'hyperpos_cached_profile',
  'hyperpos_last_user_id',
  'hyperpos_auto_login_attempted',
  'hyperpos_privacy_accepted',
  'hyperpos_privacy_version',
  'hyperpos_license_cache_v1',
  'hyperpos_user_role_cache',
  'hyperpos_toast_duration',
  'hyperpos_clear_version',
  'hyperpos_seen_broadcasts',
  'flowpos_persistent_hardware_id',
]);

/** بادئات تبقى: كاش الربط بالجهاز، وقفل التطبيق بالرمز، وطلب إعادة تعيين الرمز */
const PRESERVE_PREFIXES = [
  'hyperpos_device_binding_cache_v',
  'flowpos_app_lock_',
  'flowpos_pin_reset_required_',
];

/** يمسح مفاتيح التخزين المحلي للتجربة. يرجع عدد المفاتيح المحذوفة. */
export function wipeTrialLocalStorage(): number {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (!WIPE_PREFIXES.some((p) => key.startsWith(p))) continue;
      if (PRESERVE_EXACT.has(key) || PRESERVE_PREFIXES.some((p) => key.startsWith(p))) continue;
      keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
    return keys.length;
  } catch {
    return 0;
  }
}

/** يمسح قواعد البيانات المحلية: IndexedDB، وكاش الصور، وجداول SQLite على الأندرويد. */
export async function wipeTrialDatabases(): Promise<void> {
  try {
    const { clearProductsIDB } = await import('@/lib/indexeddb-cache');
    await clearProductsIDB();
  } catch (err) {
    console.warn('[TrialWipe] IndexedDB wipe failed:', err);
  }

  try {
    if (typeof indexedDB !== 'undefined') {
      indexedDB.deleteDatabase('flowpos_images_cache');
    }
  } catch (err) {
    console.warn('[TrialWipe] Image cache wipe failed:', err);
  }

  if (Capacitor.isNativePlatform()) {
    try {
      const { getNativeDB } = await import('@/lib/db/native-sqlite');
      const db = await getNativeDB();
      if (db) {
        const result = await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';");
        const tables = (result?.values || []) as Array<{ name: string }>;
        for (const { name } of tables) {
          await db.execute(`DELETE FROM "${name}";`);
        }
      }
    } catch (err) {
      console.warn('[TrialWipe] Native SQLite wipe failed:', err);
    }
  }

  try {
    const { NativeSWRCache } = await import('@/lib/cache/native-swr-cache');
    NativeSWRCache.clear();
  } catch (err) {
    console.warn('[TrialWipe] SWR cache wipe failed:', err);
  }
}

/** الجزء المتزامن من التعبئة: يكتب المنتجات والتصنيفات إلى المفاتيح التي تقرأ منها نقطة البيع */
function seedTrialLocalStorage(): void {
  const catalog = buildTrialCatalog();
  const categories = buildTrialCategories();
  saveProducts(catalog);
  saveCategories(categories);
  try {
    localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify({ products: catalog, timestamp: Date.now() }));
    localStorage.setItem(CATEGORIES_CACHE_KEY, JSON.stringify(categories));
    localStorage.setItem(CATALOG_VERSION_KEY, CATALOG_VERSION);
  } catch {
    /* noop */
  }
}

/** الجزء غير المتزامن: يفرّغ مخزن المنتجات (SQLite لا يحذف القديم عند الحفظ) ثم يكتب الكتالوج */
async function seedTrialDatabase(): Promise<void> {
  try {
    const { clearProductsIDB, saveProductsToIDB } = await import('@/lib/indexeddb-cache');
    await clearProductsIDB();
    await saveProductsToIDB(buildTrialCatalog());
  } catch (err) {
    console.warn('[TrialWipe] Sample products DB save failed:', err);
  }
}

const SAMPLE_PURGED_KEY = 'hp_sample_catalog_purged_v1';
const SAMPLE_ID_PREFIX = '5a0e7c10-7e51-4c2a-9b1d-';

/**
 * حساب بإيميل (تجربة 30 يوماً): بياناته تبقى على الجهاز ولا تُمسح لا يومياً ولا عند الاشتراك،
 * وتُرفع كلها عند التفعيل عبر طابور المزامنة (CloudSyncProvider ← المزامنة الأولى).
 * مرة واحدة فقط: إزالة المنتجات/التصنيفات النموذجية التي زُرعت سابقاً حتى لا تُرفع كأنها بيانات حقيقية.
 */
async function purgeLegacySampleCatalog(): Promise<void> {
  try {
    // يُعاد الفحص كلما زُرع كتالوج الضيف (علامة الإصدار موجودة): تسجيل الدخول بعد جلسة ديمو لا يترك منتجات افتراضية
    if (localStorage.getItem(SAMPLE_PURGED_KEY) === '1' && !localStorage.getItem(CATALOG_VERSION_KEY)) return;
    const isSample = (x: { id?: unknown }) => String(x?.id || '').startsWith(SAMPLE_ID_PREFIX);

    const { loadProducts } = await import('@/lib/products-store');
    const products = loadProducts();
    const real = products.filter((p) => !isSample(p));
    if (real.length !== products.length) saveProducts(real);

    const { loadCategories } = await import('@/lib/categories-store');
    const cats = loadCategories();
    const realCats = cats.filter((c) => !isSample(c));
    if (realCats.length !== cats.length) saveCategories(realCats);

    try {
      const { loadProductsFromIDB, clearProductsIDB, saveProductsToIDB } = await import('@/lib/indexeddb-cache');
      const cached = await loadProductsFromIDB<{ id?: unknown }>();
      if (cached?.products?.some(isSample)) {
        await clearProductsIDB();
        await saveProductsToIDB(cached.products.filter((p) => !isSample(p)));
      }
    } catch { /* noop */ }

    for (const k of [WINDOW_START_KEY, CATALOG_VERSION_KEY]) localStorage.removeItem(k);
    localStorage.setItem(SAMPLE_PURGED_KEY, '1');
  } catch (err) {
    console.warn('[TrialWipe] Sample purge failed:', err);
  }
}

/** يُستدعى عند الإقلاع قبل الرسم. */
export async function wipeTrialDataOnBoot(): Promise<void> {
  // وضع الضيف (بدون إيميل): جلسة بدأت بالكتالوج القديم تُحدَّث إلى الكتالوج الجديد (المعرّفات القديمة ترفضها نقطة البيع)
  if (isGuestDemoMode()) {
    if (localStorage.getItem(CATALOG_VERSION_KEY) !== CATALOG_VERSION) {
      applyTrialDisplayDefaults();
      seedTrialLocalStorage();
      await seedTrialDatabase();
    }
    return;
  }
  await purgeLegacySampleCatalog();
}

/** لم يعد هناك مسح يومي ولا مسح عند الاشتراك لحسابات الإيميل: المزامنة الأولى تتولاها CloudSyncProvider. */
export function initTrialLifecycle(): void {
  /* intentionally empty */
}
