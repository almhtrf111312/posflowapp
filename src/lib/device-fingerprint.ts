// Device Fingerprint Generator
// Creates a unique device identifier for device binding

const DEVICE_ID_KEY = 'hyperpos_device_id';
const BACKUP_DEVICE_ID_KEY = 'flowpos_persistent_hardware_id';

// Helper to save device ID to both primary and persistent backup storages
const persistDeviceId = (id: string): void => {
  try {
    localStorage.setItem(DEVICE_ID_KEY, id);
    localStorage.setItem(BACKUP_DEVICE_ID_KEY, id);
  } catch (e) {
    console.warn('[DeviceFingerprint] Failed to persist device ID to storage:', e);
  }
};

// Generate a cryptographically secure device ID using UUID v4
const generateSecureDeviceId = (): string => {
  // Use crypto.randomUUID() for 128-bit cryptographic randomness (impossible to enumerate)
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `DEV-${crypto.randomUUID()}`.toUpperCase();
  }
  // Fallback: generate UUID from crypto.getRandomValues
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Set version 4 bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const uuid = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  return `DEV-${uuid}`.toUpperCase();
};

// Get or generate device ID
export const getDeviceId = async (): Promise<string> => {
  try {
    // 1. فحص المعرف المحفوظ في التخزين الأساسي والاحتياطي
    let deviceId = localStorage.getItem(DEVICE_ID_KEY) || localStorage.getItem(BACKUP_DEVICE_ID_KEY);

    // التحقق مما إذا كان الجهاز يعمل في بيئة Capacitor على نظام Android أو بيئة أصلية
    let isCapacitorNative = false;
    try {
      const { Capacitor } = await import('@capacitor/core');
      isCapacitorNative = Capacitor.isNativePlatform();
    } catch {
      isCapacitorNative = typeof window !== 'undefined' &&
        !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
    }

    // 2. إذا كان الجهاز أندرويد حقيقي عبر Capacitor
    if (isCapacitorNative) {
      // إذا كان المعرف المحفوظ موجوداً بالفعل ويبدأ بـ CAP-، نتأكد من حفظه في المكانين ونعيده
      if (deviceId && deviceId.startsWith('CAP-')) {
        persistDeviceId(deviceId);
        return deviceId;
      }

      // استدعاء Device.getId() وانتظاره والتأكد من بادئة CAP-
      try {
        const { Device } = await import('@capacitor/device');
        if (Device && typeof Device.getId === 'function') {
          const info = await Device.getId();
          if (info?.identifier) {
            const rawId = info.identifier.trim();
            deviceId = rawId.startsWith('CAP-') ? rawId : `CAP-${rawId}`;
            persistDeviceId(deviceId);
            return deviceId;
          }
        }
      } catch (nativeErr) {
        console.warn('[DeviceFingerprint] Failed to fetch Capacitor Device.getId():', nativeErr);
      }
    }

    // 3. في بيئات الويب أو في حال كان هناك معرف محفوظ مسبقاً
    if (deviceId) {
      persistDeviceId(deviceId);
      return deviceId;
    }

    // توليد بصمة متصفح آمنة مشفرة وحفظها في التخزين الأساسي والاحتياطي
    deviceId = generateSecureDeviceId();
    persistDeviceId(deviceId);

    return deviceId;
  } catch (error) {
    console.error('Error getting device ID:', error);
    // Fallback to existing or new random ID
    let fallbackId = localStorage.getItem(BACKUP_DEVICE_ID_KEY) || localStorage.getItem(DEVICE_ID_KEY);
    if (!fallbackId) {
      const randBytes = new Uint8Array(8);
      crypto.getRandomValues(randBytes);
      fallbackId = `FB-${Date.now()}-${Array.from(randBytes).map(b => b.toString(36)).join('')}`.toUpperCase();
    }
    persistDeviceId(fallbackId);
    return fallbackId;
  }
};

// Clear stored device ID (for testing purposes only)
export const clearDeviceId = (): void => {
  try {
    localStorage.removeItem(DEVICE_ID_KEY);
    localStorage.removeItem(BACKUP_DEVICE_ID_KEY);
  } catch {
    // Ignore errors
  }
};

/**
 * معرّف الجهاز الموحّد للترخيص
 * كان التطبيق يستخدم معرّفين مختلفين لنفس الجهاز: HP…SK (التفعيل وفحص الترخيص) و DEV-/CAP- (تسجيل الدخول)،
 * فيُربط الترخيص بأحدهما ويُفحص بالآخر فيُحظر صاحب الحساب على جهازه نفسه.
 * القاعدة: إذا كان الترخيص مربوطاً مسبقاً بأحد معرّفي هذا الجهاز نستخدمه كما هو، وإلا نعتمد HP…SK.
 */
export const getCanonicalDeviceId = async (registeredDeviceId?: string | null): Promise<string> => {
  const { getDeviceKey } = await import('./secure-storage');
  const key = getDeviceKey();
  if (registeredDeviceId) {
    if (registeredDeviceId === key) return key;
    try {
      const legacy = await getDeviceId();
      if (registeredDeviceId === legacy) return legacy;
    } catch { /* ignore */ }
  }
  return key;
};
