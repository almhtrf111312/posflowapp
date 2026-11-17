// كتالوج وضع التجربة: منتجات وتصنيفات نموذجية متنوعة، وشكل العرض الافتراضي (برتقالي + بطاقات مضغوطة).
// البيانات محلية فقط وتُعاد تعبئتها عند كل إقلاع بعد مسح بيانات التجربة.
import { getPlatformStoragePrefix } from '@/lib/app-font-config';
import { getStatus, type Product } from '@/lib/products-store';
import type { Category } from '@/lib/categories-store';

const POS_VIEW_MODE_KEY = 'pos_view_mode';
const LEGACY_THEME_KEY = 'posflow_theme_v1';
const TRIAL_THEME = JSON.stringify({ mode: 'light', color: 'orange', blur: false, transparency: 0, style: 'standard' });

/** نقطة البيع تتحقق من أن معرّف كل صنف UUID صالح (validateCartProducts)، لذلك تُولَّد المعرّفات بصيغة UUID v4 ثابتة */
export const trialUuid = (n: number): string => `5a0e7c10-7e51-4c2a-9b1d-${n.toString(16).padStart(12, '0')}`;

const TRIAL_CATEGORY_NAMES = [
  'هواتف ذكية',
  'إكسسوارات',
  'أجهزة كمبيوتر',
  'ملابس',
  'غذائيات',
  'أدوات منزلية',
];

// [الاسم، التصنيف، سعر التكلفة، سعر البيع، الكمية، حد التنبيه] — الأسعار بالدولار كما في النظام
const TRIAL_SEEDS: Array<[string, string, number, number, number, number]> = [
  ['آيفون 15 برو ماكس', 'هواتف ذكية', 950, 1100, 8, 3],
  ['سامسونج جالكسي S24 ألترا', 'هواتف ذكية', 820, 980, 12, 3],
  ['شاومي Redmi Note 13', 'هواتف ذكية', 160, 215, 15, 4],
  ['هواوي Nova 12', 'هواتف ذكية', 210, 265, 6, 3],
  ['شاحن سريع 65W', 'إكسسوارات', 18, 30, 45, 10],
  ['سماعات AirPods Pro 2', 'إكسسوارات', 190, 240, 25, 5],
  ['كفر حماية مغناطيسي', 'إكسسوارات', 6, 15, 80, 15],
  ['بنك طاقة 20000mAh', 'إكسسوارات', 32, 48, 30, 6],
  ['كابل شحن Type-C مضفر', 'إكسسوارات', 4, 12, 100, 20],
  ['شاشة حماية زجاجية نانو', 'إكسسوارات', 2, 8, 120, 20],
  ['سماعة رأس بلوتوث سوني', 'إكسسوارات', 140, 195, 10, 3],
  ['ساعة Apple Watch Ultra', 'إكسسوارات', 650, 780, 6, 2],
  ['لاب توب MacBook Air M3', 'أجهزة كمبيوتر', 1000, 1150, 5, 2],
  ['آيباد برو 12.9 إنش', 'أجهزة كمبيوتر', 800, 920, 7, 2],
  ['ماوس لاسلكي', 'أجهزة كمبيوتر', 10, 18, 40, 8],
  ['تيشيرت قطن رجالي', 'ملابس', 3, 8, 60, 10],
  ['قميص رسمي أبيض', 'ملابس', 7, 15, 40, 8],
  ['فستان صيفي نسائي', 'ملابس', 9, 18, 30, 6],
  ['بنطلون جينز', 'ملابس', 11, 22, 35, 6],
  ['جاكيت شتوي', 'ملابس', 18, 35, 15, 4],
  ['حذاء رياضي', 'ملابس', 25, 45, 20, 5],
  ['رز بسمتي 5 كغ', 'غذائيات', 6, 9, 50, 10],
  ['سكر أبيض 1 كغ', 'غذائيات', 1, 1.5, 100, 20],
  ['عدس أحمر 1 كغ', 'غذائيات', 1.2, 2, 80, 15],
  ['طماطم 1 كغ', 'غذائيات', 0.6, 1.2, 60, 10],
  ['بطاطا 1 كغ', 'غذائيات', 0.5, 1, 70, 10],
  ['بصل 1 كغ', 'غذائيات', 0.4, 0.8, 70, 10],
  ['زيت دوار الشمس 1.5 لتر', 'غذائيات', 3, 4, 40, 8],
  ['حليب طويل الأجل 1 لتر', 'غذائيات', 0.9, 1.3, 90, 15],
  ['بيض (30 حبة)', 'غذائيات', 3.5, 5, 30, 6],
  ['مكرونة سباغيتي 500 غرام', 'غذائيات', 0.7, 1.2, 60, 10],
  ['تفاح 1 كغ', 'غذائيات', 1.5, 2.5, 40, 8],
  ['مكنسة كهربائية', 'أدوات منزلية', 60, 85, 10, 3],
  ['خلاط كهربائي', 'أدوات منزلية', 28, 45, 12, 3],
  ['مكواة بخار', 'أدوات منزلية', 18, 30, 15, 4],
  ['منظف أرضيات 1 لتر', 'أدوات منزلية', 1.8, 3, 40, 8],
];

export function buildTrialCategories(): Category[] {
  const now = new Date().toISOString();
  return TRIAL_CATEGORY_NAMES.map((name, i) => ({ id: trialUuid(100 + i + 1), name, createdAt: now }));
}

export function buildTrialCatalog(): Product[] {
  return TRIAL_SEEDS.map(([name, category, costPrice, salePrice, quantity, minStockLevel], i) => ({
    id: trialUuid(i + 1),
    name,
    barcode: String(620000000000 + i + 1),
    category,
    costPrice,
    salePrice,
    quantity,
    minStockLevel,
    status: getStatus(quantity, minStockLevel),
  }));
}

/** يضبط شكل الواجهة للتجربة: اللون البرتقالي وعرض البطاقات المضغوط. يرجع true إذا تغيّر شيء. */
export function applyTrialDisplayDefaults(): boolean {
  let changed = false;
  try {
    for (const key of [`flowpos_theme_${getPlatformStoragePrefix()}`, LEGACY_THEME_KEY]) {
      if (localStorage.getItem(key) !== TRIAL_THEME) {
        localStorage.setItem(key, TRIAL_THEME);
        changed = true;
      }
    }
    if (localStorage.getItem(POS_VIEW_MODE_KEY) !== 'dense') {
      localStorage.setItem(POS_VIEW_MODE_KEY, 'dense');
      changed = true;
    }
  } catch {
    /* التخزين غير متاح: نتجاهل */
  }
  return changed;
}
