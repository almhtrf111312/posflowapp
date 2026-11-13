// مسح بيانات وضع التجربة المحلي وإعادة تعبئتها بالنماذج.
// بيانات التجربة تبقى على الجهاز 24 ساعة من بدايتها ثم تُمسح كلها (دون رفع شيء للسحابة)،
// وتُفحص المدة عند الإقلاع وعند العودة إلى التطبيق. بعد المسح تُضاف المنتجات النموذجية من جديد.
// لا يُمسح: الجلسة، الجهاز، الترخيص، سجل الحظر، اللغة، موافقة الخصوصية، وعلامة وضع التجربة نفسها.
import { Capacitor } from '@capacitor/core';
import { isLocalOnlyMode, isCloudWriteBlocked, LOCAL_MODE_EVENT } from '@/lib/subscription-lock';
import { saveProducts } from '@/lib/products-store';
import { isGuestDemoMode } from '@/lib/demo-data';
import { saveCategories } from '@/lib/categories-store';
import { buildTrialCatalog, buildTrialCategories, applyTrialDisplayDefaults } from '@/lib/trial-sample-catalog';

const WINDOW_START_KEY = 'hp_trial_window_start';
const TRIAL_DATA_WINDOW_MS = 24 * 60 * 60 * 1000;
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

function readWindowStart(): number | null {
  try {
    const value = Number(localStorage.getItem(WINDOW_START_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeWindowStart(now: number): void {
  try {
    localStorage.setItem(WINDOW_START_KEY, String(now));
  } catch {
    /* noop */
  }
}

/** انتهت نافذة الـ24 ساعة؟ (ساعة مرتدّة إلى الخلف تُعامل كمنتهية حتى لا تُطال المدة) */
function isTrialWindowExpired(now: number = Date.now()): boolean {
  const start = readWindowStart();
  if (start === null) return false;
  const age = now - start;
  return age >= TRIAL_DATA_WINDOW_MS || age < 0;
}

/**
 * تحضير جلسة التجربة. يرجع true إذا كُتبت بيانات جديدة (ويلزم إعادة تحميل إن حدث ذلك بعد رسم الواجهة).
 * - بداية نافذة جديدة (أول مرة أو بعد انتهاء 24 ساعة): مسح كامل ثم الشكل الافتراضي، بدون منتجات تجريبية.
 * - داخل النافذة: لا يُلمس شيء.
 */
async function prepareTrialSession(): Promise<boolean> {
  const now = Date.now();
  if (readWindowStart() === null || isTrialWindowExpired(now)) {
    wipeTrialLocalStorage();
    writeWindowStart(now);
    applyTrialDisplayDefaults();
    // المنتجات التجريبية لوضع الضيف (بدون إيميل) فقط؛ المتجر الحقيقي يبدأ فارغاً
    await wipeTrialDatabases();
    return true;
  }

  return false;
}

/** يُستدعى عند الإقلاع قبل الرسم: في وضع التجربة تُفحص النافذة وتُحضَّر الجلسة. */
export async function wipeTrialDataOnBoot(): Promise<void> {
  // وضع الضيف: جلسة بدأت بالكتالوج القديم تُحدَّث إلى الكتالوج الجديد (المعرّفات القديمة ترفضها نقطة البيع)
  if (isGuestDemoMode()) {
    if (localStorage.getItem(CATALOG_VERSION_KEY) !== CATALOG_VERSION) {
      applyTrialDisplayDefaults();
      seedTrialLocalStorage();
      await seedTrialDatabase();
    }
    return;
  }
  if (!isLocalOnlyMode()) return;
  await prepareTrialSession();
}

/** عند تفعيل اشتراك مدفوع: تُحذف بيانات التجربة (نماذج ومبيعات تجريبية) حتى لا تُرفع إلى الحساب الحقيقي */
function discardTrialDataAfterActivation(): void {
  if (readWindowStart() === null) return;
  wipeTrialLocalStorage();
  try {
    localStorage.removeItem(WINDOW_START_KEY);
    localStorage.removeItem(CATALOG_VERSION_KEY);
    localStorage.removeItem('pos_view_mode');
  } catch {
    /* noop */
  }
  void wipeTrialDatabases().finally(() => window.location.reload());
}

/**
 * - عند دخول وضع التجربة: تُحضَّر الجلسة، ويُعاد التحميل إن كُتبت بيانات جديدة لتظهر فوراً.
 * - عند الخروج منه باشتراك مدفوع فعّال: تُحذف بيانات التجربة ويُعاد التحميل.
 * - على أندرويد: عند العودة إلى التطبيق يُعاد التحميل إن انتهت نافذة الـ24 ساعة.
 */
export function initTrialLifecycle(): void {
  window.addEventListener(LOCAL_MODE_EVENT, () => {
    // التأجيل يضمن أن علامة حجب الكتابة السحابية تحدّثت (تُضبط في نفس دورة الترخيص)
    setTimeout(() => {
      if (isLocalOnlyMode()) {
        void prepareTrialSession().then((changed) => {
          if (changed) window.location.reload();
        });
      } else if (!isCloudWriteBlocked()) {
        discardTrialDataAfterActivation();
      }
    }, 0);
  });

  if (!Capacitor.isNativePlatform()) return;

  import('@capacitor/app')
    .then(({ App }) => {
      App.addListener('resume', () => {
        if (isLocalOnlyMode() && isTrialWindowExpired()) window.location.reload();
      });
    })
    .catch((err) => console.warn('[TrialWipe] Lifecycle listener failed:', err));
}
