// مسح بيانات وضع التجربة المحلي.
// وضع التجربة لا يحتفظ بأي بيانات بين الجلسات: تُمسح عند الإقلاع (قبل الرسم)،
// وعند ذهاب التطبيق إلى الخلفية (وهي نقطة الخروج الوحيدة الموثوقة على أندرويد).
// لا يُمسح: الجلسة، الجهاز، الترخيص، سجل الحظر، إعدادات اللغة والمظهر، وعلامة وضع التجربة نفسها.
import { Capacitor } from '@capacitor/core';
import { isLocalOnlyMode, LOCAL_MODE_EVENT } from '@/lib/subscription-lock';
import { demoProducts } from '@/lib/demo-data';
import { saveProducts } from '@/lib/products-store';

const PENDING_WIPE_KEY = 'hp_trial_wipe_pending';

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

const PRODUCTS_STORAGE_KEY = 'hyperpos_products_v1';

/**
 * منتجات نموذجية لوضع التجربة حتى يتمكن العميل من إجراء بيع تجريبي.
 * تُضاف فقط إذا كان المخزن فارغاً، فلا تُكرَّر ولا تمسح ما أضافه العميل خلال الجلسة.
 */
export async function seedTrialSampleProducts(): Promise<void> {
  if (!isLocalOnlyMode()) return;
  try {
    const raw = localStorage.getItem(PRODUCTS_STORAGE_KEY);
    const current = raw ? JSON.parse(raw) : [];
    if (Array.isArray(current) && current.length > 0) return;
  } catch {
    /* بيانات تالفة: نعيد التعبئة بالنماذج */
  }

  saveProducts(demoProducts);
  try {
    const { saveProductsToIDB } = await import('@/lib/indexeddb-cache');
    await saveProductsToIDB(demoProducts);
  } catch (err) {
    console.warn('[TrialWipe] Sample products IDB save failed:', err);
  }
}

/** يُستدعى عند الإقلاع: إن كان وضع التجربة مفعّلاً تُمسح البيانات قبل رسم الواجهة، ثم تُضاف النماذج. */
export async function wipeTrialDataOnBoot(): Promise<void> {
  if (!isLocalOnlyMode()) return;
  wipeTrialLocalStorage();
  await wipeTrialDatabases();
  await seedTrialSampleProducts();
}

/**
 * على أندرويد في وضع التجربة: عند ذهاب التطبيق إلى الخلفية تُمسح البيانات فوراً،
 * وعند العودة تُعاد تحميل الواجهة إن كان المسح قد حدث.
 */
export function initTrialLifecycle(): void {
  // عند تفعيل وضع التجربة (بعد بدء الفترة التجريبية) تُضاف المنتجات النموذجية فوراً
  window.addEventListener(LOCAL_MODE_EVENT, () => { void seedTrialSampleProducts(); });

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
