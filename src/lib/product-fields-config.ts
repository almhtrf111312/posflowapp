// Product Fields Configuration - Dynamic fields based on store type and user preferences

import { emitEvent, EVENTS } from './events';

export interface ProductFieldsConfig {
  expiryDate: boolean;
  batchNumber: boolean;
  serialNumber: boolean;
  /** رقم IMEI للهواتف، منفصل عن الرقم التسلسلي */
  imei: boolean;
  warranty: boolean;
  wholesalePrice: boolean;
  sizeColor: boolean;
  minStockLevel: boolean;
  weight: boolean;
  fabricType: boolean;
  tableNumber: boolean;
  orderNotes: boolean;
  author: boolean;
  publisher: boolean;
}

export type StoreType = 'phones' | 'grocery' | 'pharmacy' | 'clothing' | 'restaurant' | 'repair' | 'bookstore' | 'bakery' | 'general' | 'custom';

// Default fields based on store type
export const getDefaultFieldsByStoreType = (storeType: StoreType): ProductFieldsConfig => {
  switch (storeType) {
    case 'phones':
      return {
        expiryDate: false, batchNumber: false, serialNumber: true, imei: true, warranty: true,
        wholesalePrice: true, sizeColor: false, minStockLevel: true,
        weight: false, fabricType: false, tableNumber: false, orderNotes: false, author: false, publisher: false,
      };
    case 'repair':
      return {
        expiryDate: false, batchNumber: false, serialNumber: false, imei: false, warranty: false,
        wholesalePrice: false, sizeColor: false, minStockLevel: false,
        weight: false, fabricType: false, tableNumber: false, orderNotes: false, author: false, publisher: false,
      };
    case 'grocery':
      return {
        expiryDate: true, batchNumber: false, serialNumber: false, imei: false, warranty: false,
        wholesalePrice: true, sizeColor: false, minStockLevel: true,
        weight: true, fabricType: false, tableNumber: false, orderNotes: false, author: false, publisher: false,
      };
    case 'pharmacy':
      return {
        expiryDate: true, batchNumber: true, serialNumber: false, imei: false, warranty: false,
        wholesalePrice: true, sizeColor: false, minStockLevel: true,
        weight: false, fabricType: false, tableNumber: false, orderNotes: false, author: false, publisher: false,
      };
    case 'clothing':
      return {
        expiryDate: false, batchNumber: false, serialNumber: false, imei: false, warranty: false,
        wholesalePrice: true, sizeColor: true, minStockLevel: true,
        weight: false, fabricType: true, tableNumber: false, orderNotes: false, author: false, publisher: false,
      };
    case 'bakery':
      return {
        expiryDate: true, batchNumber: false, serialNumber: false, imei: false, warranty: false,
        wholesalePrice: true, sizeColor: false, minStockLevel: false,
        weight: false, fabricType: false, tableNumber: false, orderNotes: false, author: false, publisher: false,
      };
    case 'restaurant':
      return {
        expiryDate: false, batchNumber: false, serialNumber: false, imei: false, warranty: false,
        wholesalePrice: false, sizeColor: false, minStockLevel: true,
        weight: false, fabricType: false, tableNumber: true, orderNotes: true, author: false, publisher: false,
      };
    case 'bookstore':
      return {
        expiryDate: false, batchNumber: false, serialNumber: true, imei: false, warranty: false,
        wholesalePrice: true, sizeColor: false, minStockLevel: true,
        weight: false, fabricType: false, tableNumber: false, orderNotes: false, author: true, publisher: true,
      };
    case 'general':
    case 'custom':
    default:
      return {
        expiryDate: false, batchNumber: false, serialNumber: false, imei: false, warranty: false,
        wholesalePrice: false, sizeColor: false, minStockLevel: false,
        weight: false, fabricType: false, tableNumber: false, orderNotes: false, author: false, publisher: false,
      };
  }
};

const PRODUCT_FIELDS_STORAGE_KEY = 'posflow_product_fields_v1';

// Load user-defined field configuration from localStorage (for instant access)
const currentStoreType = (): StoreType => {
  try {
    const raw = localStorage.getItem('posflow_settings_v1');
    if (raw) return (JSON.parse(raw).storeSettings?.type || 'general') as StoreType;
  } catch { /* ignore */ }
  return 'general';
};

export const loadProductFieldsConfig = (): ProductFieldsConfig | null => {
  try {
    const stored = localStorage.getItem(PRODUCT_FIELDS_STORAGE_KEY);
    if (stored) {
      // الحقول المضافة حديثاً (مثل IMEI) غير موجودة في الإعدادات المحفوظة سابقاً:
      // تأخذ القيمة الافتراضية لنوع المتجر بدل أن تبقى معطلة
      return { ...getDefaultFieldsByStoreType(currentStoreType()), ...JSON.parse(stored) };
    }
  } catch (error) {
    console.error('Failed to load product fields config:', error);
  }
  return null;
};

// Save user-defined field configuration (to both localStorage and cloud)
export const saveProductFieldsConfig = async (config: ProductFieldsConfig): Promise<boolean> => {
  try {
    // Save to localStorage for instant access
    localStorage.setItem(PRODUCT_FIELDS_STORAGE_KEY, JSON.stringify(config));

    // Emit event to notify components in the same tab
    emitEvent(EVENTS.PRODUCT_FIELDS_UPDATED, config);

    // Sync to cloud - merge with existing sync_settings instead of overwriting
    const { saveUnifiedStoreSettings } = await import('./store-settings-sync');
    const result = await saveUnifiedStoreSettings({ productFieldsConfig: config });
    return result.success;
  } catch (error) {
    console.error('Failed to save product fields config:', error);
    return false;
  }
};

// Load product fields from cloud and sync to localStorage
export const syncProductFieldsFromCloud = async (): Promise<ProductFieldsConfig | null> => {
  try {
    const { pullStoreSettingsWithGuard } = await import('./store-settings-sync');
    const settings = await pullStoreSettingsWithGuard();
    const cloudConfig = settings.productFieldsConfig;

    if (cloudConfig) {
      // Sync to localStorage
      localStorage.setItem(PRODUCT_FIELDS_STORAGE_KEY, JSON.stringify(cloudConfig));
      emitEvent(EVENTS.PRODUCT_FIELDS_UPDATED, cloudConfig);
      console.log('[ProductFields] Synced from cloud to localStorage');
      return cloudConfig;
    }

    return null;
  } catch (error) {
    console.error('Failed to sync product fields from cloud:', error);
    return null;
  }
};

// Get effective field configuration (user override or store type default)
export const getEffectiveFieldsConfig = (): ProductFieldsConfig => {
  // First check user overrides
  const userConfig = loadProductFieldsConfig();
  if (userConfig) {
    return userConfig;
  }

  // Otherwise use store type defaults
  try {
    const settingsRaw = localStorage.getItem('posflow_settings_v1');
    if (settingsRaw) {
      const settings = JSON.parse(settingsRaw);
      const storeType = settings.storeSettings?.type || 'general';
      return getDefaultFieldsByStoreType(storeType);
    }
  } catch (error) {
    console.error('Failed to load store settings for fields config:', error);
  }

  return getDefaultFieldsByStoreType('general');
};

export interface ProductFieldLabelMeta {
  name: string;
  labelEn: string;
  description: string;
  descriptionEn: string;
}

// Field labels in Arabic & English
export const FIELD_LABELS: Record<keyof ProductFieldsConfig, ProductFieldLabelMeta> = {
  expiryDate: {
    name: 'تاريخ الصلاحية',
    labelEn: 'Expiry Date',
    description: 'للمنتجات الغذائية والأدوية',
    descriptionEn: 'For food products and medications',
  },
  batchNumber: {
    name: 'رقم التشغيلة',
    labelEn: 'Batch Number',
    description: 'رقم الدفعة أو التشغيلة للأدوية',
    descriptionEn: 'Lot or batch number for medications',
  },
  serialNumber: {
    name: 'الرقم التسلسلي',
    labelEn: 'Serial Number',
    description: 'الرقم التسلسلي (S/N) للجهاز أو ISBN للكتب',
    descriptionEn: 'Device serial number (S/N) or book ISBN',
  },
  imei: {
    name: 'رقم IMEI',
    labelEn: 'IMEI Number',
    description: 'الرقم الدولي للهاتف (15 خانة)، منفصل عن الرقم التسلسلي',
    descriptionEn: '15-digit international mobile equipment identity, separate from serial number',
  },
  warranty: {
    name: 'الضمان',
    labelEn: 'Warranty',
    description: 'مدة ضمان المنتج',
    descriptionEn: 'Product warranty period',
  },
  wholesalePrice: {
    name: 'سعر الجملة',
    labelEn: 'Wholesale Price',
    description: 'سعر خاص للبيع بالجملة',
    descriptionEn: 'Special pricing for wholesale sales',
  },
  sizeColor: {
    name: 'المقاس واللون',
    labelEn: 'Size & Color',
    description: 'للملابس والأزياء',
    descriptionEn: 'For clothing and apparel',
  },
  minStockLevel: {
    name: 'الحد الأدنى للمخزون',
    labelEn: 'Minimum Stock Level',
    description: 'تنبيه عند انخفاض الكمية',
    descriptionEn: 'Alert when stock quantity drops below threshold',
  },
  weight: {
    name: 'الوزن',
    labelEn: 'Weight',
    description: 'وزن المنتج بالكيلو أو الجرام',
    descriptionEn: 'Product weight in kilograms or grams',
  },
  fabricType: {
    name: 'نوع القماش',
    labelEn: 'Fabric Type',
    description: 'نوع قماش الملابس',
    descriptionEn: 'Apparel fabric material type',
  },
  tableNumber: {
    name: 'رقم الطاولة',
    labelEn: 'Table Number',
    description: 'رقم الطاولة في المطعم',
    descriptionEn: 'Restaurant table number',
  },
  orderNotes: {
    name: 'ملاحظات الطلب',
    labelEn: 'Order Notes',
    description: 'ملاحظات خاصة بالطلب',
    descriptionEn: 'Special notes for the order',
  },
  author: {
    name: 'اسم المؤلف',
    labelEn: 'Author Name',
    description: 'مؤلف الكتاب',
    descriptionEn: 'Book author',
  },
  publisher: {
    name: 'دار النشر',
    labelEn: 'Publisher',
    description: 'دار نشر الكتاب',
    descriptionEn: 'Book publishing house',
  },
};

/**
 * Returns localized label for a product field ('en' vs 'ar')
 */
export function getLocalizedFieldLabel(field: keyof ProductFieldsConfig, lang: string = 'ar'): string {
  const meta = FIELD_LABELS[field];
  return lang === 'en' ? meta.labelEn : meta.name;
}

/**
 * Returns localized description for a product field ('en' vs 'ar')
 */
export function getLocalizedFieldDescription(field: keyof ProductFieldsConfig, lang: string = 'ar'): string {
  const meta = FIELD_LABELS[field];
  return lang === 'en' ? meta.descriptionEn : meta.description;
}
