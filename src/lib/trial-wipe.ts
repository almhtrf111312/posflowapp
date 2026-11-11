// مسح بيانات وضع التجربة المحلي وإعادة تعبئتها بالنماذج.
// وضع التجربة لا يحتفظ بأي بيانات بين الجلسات: تُمسح عند الإقلاع (قبل الرسم)،
// وعند ذهاب التطبيق إلى الخلفية (وهي نقطة الخروج الوحيدة الموثوقة على أندرويد)،
// ثم تُضاف المنتجات النموذجية ليتمكن العميل من البيع التجريبي محلياً.
// لا يُمسح: الجلسة، الجهاز، الترخيص، سجل الحظر، اللغة، موافقة الخصوصية، وعلامة وضع التجربة نفسها.
import { Capacitor } from '@capacitor/core';
import { isLocalOnlyMode, LOCAL_MODE_EVENT } from '@/lib/subscription-lock';
import { saveProducts } from '@/lib/products-store';
import { saveCategories } from '@/lib/categories-store';
import { buildTrialCatalog, buildTrialCategories, applyTrialDisplayDefaults } from '@/lib/trial-sample-catalog';

const PENDING_WIPE_KEY = 'hp_trial_wipe_pending';
const PRODUCTS_STORAGE_KEY = 'hyperpos_products_v1';
const PRODUCTS_CACHE_KEY = 'hyperpos_products_cache';

/** بادئات تُمسح من localStorage (بيانات الأعمال والكاش والطابور والتشخيص) */
const WIPE_PREFIXES = ['hyperpos_', 'flowpos_', 'fps_swr_', 'hp_sync_', 'hp_audit_', 'hp_offline_', 'hp_radar_'];

/** مفاتيح تبقى دائماً (داخل البادئات المحذوفة) */
const PRESERVE_EXACT = new Set<string>([
  'hyperpos_language',
  'hyperpos_theme',
  'hyperpos_theme_v1',
  'hyperpos_device_id',
  'hyperpos_stay_logged_in',
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

/** هل يلزم إعادة تعبئة الكتالوج؟ (المخزن فارغ، أو ما زال فيه نماذج الإصدار القديم) */
function trialCatalogNeeded(): boolean {
  try {
    const raw = localStorage.getItem(PRODUCTS_STORAGE_KEY);
    const current = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(current) || current.length === 0) return true;
    return current.every((p) => typeof p?.id === 'string' && p.id.startsWith('prod_'));
  } catch {
    return true;
  }
}

/** الجزء المتزامن من التعبئة: يكتب المنتجات والتصنيفات إلى localStorage قبل رسم الواجهة */
function seedTrialLocalStorage(): void {
  const catalog = buildTrialCatalog();
  saveProducts(catalog);
  try {
    localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify({ products: catalog, timestamp: Date.now() }));
  } catch {
    /* noop */
  }
  saveCategories(buildTrialCategories());
}

/** الجزء غير المتزامن: IndexedDB أو SQLite حسب المنصة */
async function seedTrialDatabase(): Promise<void> {
  try {
    const { saveProductsToIDB } = await import('@/lib/indexeddb-cache');
    await saveProductsToIDB(buildTrialCatalog());
  } catch (err) {
    console.warn('[TrialWipe] Sample products DB save failed:', err);
  }
}

/** يضيف المنتجات النموذجية إذا كان المخزن فارغاً، فلا يكرّرها ولا يمسح ما أضافه العميل خلال الجلسة. */
export async function seedTrialSampleProducts(): Promise<void> {
  if (!isLocalOnlyMode() || !trialCatalogNeeded()) return;
  seedTrialLocalStorage();
  await seedTrialDatabase();
}

/** يُستدعى عند الإقلاع: إن كان وضع التجربة مفعّلاً تُمسح البيانات ثم تُعاد تعبئتها قبل رسم الواجهة. */
export async function wipeTrialDataOnBoot(): Promise<void> {
  if (!isLocalOnlyMode()) return;
  wipeTrialLocalStorage();
  applyTrialDisplayDefaults();
  seedTrialLocalStorage();
  await wipeTrialDatabases();
  await seedTrialDatabase();
}

/**
 * - عند تفعيل وضع التجربة (بعد بدء الفترة): تُضبط الواجهة وتُضاف النماذج، ويُعاد التحميل إن تغيّر الشكل.
 * - على أندرويد في وضع التجربة: عند ذهاب التطبيق إلى الخلفية تُمسح البيانات فوراً،
 *   وعند العودة تُعاد تحميل الواجهة إن كان المسح قد حدث.
 */
export function initTrialLifecycle(): void {
  window.addEventListener(LOCAL_MODE_EVENT, () => {
    if (!isLocalOnlyMode()) return;
    const displayChanged = applyTrialDisplayDefaults();
    void seedTrialSampleProducts().finally(() => {
      // الثيم يُقرأ عند الإقلاع، فإن تغيّر نعيد التحميل ليظهر اللون البرتقالي
      if (displayChanged) window.location.reload();
    });
  });

  if (!Capacitor.isNativePlatform()) return;

  import('@capacitor/app')
    .then(({ App }) => {
      App.addListener('pause', () => {
        if (!isLocalOnlyMode()) return;
        try { localStorage.setItem(PENDING_WIPE_KEY, '1'); } catch { /* noop */ }
        wipeTrialLocalStorage();
        void wipeTrialDatabases();
      });

      App.addListener('resume', () => {
        let pending = false;
        try { pending = localStorage.getItem(PENDING_WIPE_KEY) === '1'; } catch { /* noop */ }
        if (!pending) return;
        try { localStorage.removeItem(PENDING_WIPE_KEY); } catch { /* noop */ }
        window.location.reload();
      });
    })
    .catch((err) => console.warn('[TrialWipe] Lifecycle listener failed:', err));
}
