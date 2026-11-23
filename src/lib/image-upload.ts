import { supabase } from '@/integrations/supabase/client';

let cachedWebPSupport: boolean | null = null;

/**
 * فحص دعم المتصفح/WebView لترميز صور WebP عبر Canvas مع تخزين النتيجة مؤقتاً
 */
export function supportsWebPEncoding(): boolean {
  if (cachedWebPSupport !== null) return cachedWebPSupport;
  try {
    if (typeof document === 'undefined') {
      cachedWebPSupport = false;
      return false;
    }
    const testCanvas = document.createElement('canvas');
    testCanvas.width = 1;
    testCanvas.height = 1;
    cachedWebPSupport = testCanvas.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    cachedWebPSupport = false;
  }
  return cachedWebPSupport;
}

/**
 * إرجاع صيغة الضغط المفضلة: image/webp عند الدعم، وإلا الرجوع التلقائي إلى image/jpeg
 */
export function getPreferredImageMimeType(): 'image/webp' | 'image/jpeg' {
  return supportsWebPEncoding() ? 'image/webp' : 'image/jpeg';
}

/**
 * ضغط الصورة تلقائياً مع تفضيل صيغة WebP (جودة 0.82) والرجوع التلقائي إلى JPEG عند عدم الدعم
 */
export async function compressImage(
  base64Image: string,
  maxSizeKB: number = 30,
  maxWidth: number = 400,
  maxHeight: number = 400,
  initialQuality: number = 0.82
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();

    img.onload = () => {
      let width = img.width;
      let height = img.height;

      if (width > height) {
        if (width > maxWidth) {
          height = (height * maxWidth) / width;
          width = maxWidth;
        }
      } else {
        if (height > maxHeight) {
          width = (width * maxHeight) / height;
          height = maxHeight;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width);
      canvas.height = Math.round(height);

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        // fallback: return original if canvas not available
        resolve(base64Image);
        return;
      }

      ctx.drawImage(img, 0, 0, Math.round(width), Math.round(height));

      const getImageSizeKB = (b64: string) => {
        const data = b64.includes(',') ? b64.split(',')[1] : b64;
        return (data.length * 0.75) / 1024;
      };

      let mimeType: 'image/webp' | 'image/jpeg' = getPreferredImageMimeType();
      let quality = initialQuality;
      let compressedBase64 = canvas.toDataURL(mimeType, quality);

      // تحقق أمان إضافي: في حال أعاد المتصفح صيغة غير WebP نرجع فوراً إلى JPEG
      if (mimeType === 'image/webp' && !compressedBase64.startsWith('data:image/webp')) {
        mimeType = 'image/jpeg';
        compressedBase64 = canvas.toDataURL(mimeType, quality);
      }

      while (getImageSizeKB(compressedBase64) > maxSizeKB && quality > 0.1) {
        quality = Math.max(0.1, Number((quality - 0.05).toFixed(2)));
        compressedBase64 = canvas.toDataURL(mimeType, quality);
        if (quality <= 0.1) break;
      }

      console.log(`[Image Compression] (${mimeType}) ${getImageSizeKB(base64Image).toFixed(1)}KB → ${getImageSizeKB(compressedBase64).toFixed(1)}KB (q=${(quality * 100).toFixed(0)}%)`);
      resolve(compressedBase64);
    };

    img.onerror = () => {
      // If image fails to load, return original as-is
      console.warn('[Image Compression] Failed to load image, returning original');
      resolve(base64Image);
    };

    img.src = base64Image;
  });
}

/**
 * ضغط الصورة أوفلاين فقط (بدون رفع) — للاستخدام عند حفظ المنتج محلياً
 * يضمن أن الصورة ≤30KB وجاهزة للتخزين في قاعدة البيانات
 */
export async function compressImageOffline(base64Image: string): Promise<string> {
  return compressImage(base64Image, 30, 400, 400);
}

/**
 * تحويل base64 إلى Blob بطريقة آمنة تعمل على Android Capacitor WebView
 * 
 * ⚠️ CRITICAL: fetch(dataUrl) يفشل في Capacitor Android WebView!
 * يجب استخدام atob() + ArrayBuffer بدلاً من fetch()
 */
function base64ToBlob(base64: string, mimeType: string = 'image/jpeg'): Blob {
  const base64Data = base64.includes(',') ? base64.split(',')[1] : base64;
  const byteString = atob(base64Data);
  const arrayBuffer = new ArrayBuffer(byteString.length);
  const uint8Array = new Uint8Array(arrayBuffer);
  for (let i = 0; i < byteString.length; i++) {
    uint8Array[i] = byteString.charCodeAt(i);
  }
  return new Blob([arrayBuffer], { type: mimeType });
}

/**
 * رفع صورة منتج إلى Cloud Storage
 * 
 * الاستراتيجية الثلاثية:
 * 1. ضغط الصورة أولاً (≤30KB)
 * 2. رفع للسحابة باستخدام base64ToBlob الآمن (بدلاً من fetch)
 * 3. إذا فشل الرفع: إرجاع data URL المضغوطة (≤30KB) لحفظها محلياً
 * 
 * @returns مسار الملف في السحابة، أو data URL مضغوطة إذا فشل الرفع، أو null
 */
export async function uploadProductImage(base64Image: string): Promise<string | null> {
  try {
    // الخطوة 1: ضغط الصورة
    console.log('[Image Upload] Compressing image...');
    const compressedImage = await compressImage(base64Image, 30, 400, 400);

    // تحديد الصيغة الفعلية بعد الضغط (WebP عند الدعم وإلا JPEG)
    const isWebP = compressedImage.startsWith('data:image/webp');
    const mimeType = isWebP ? 'image/webp' : 'image/jpeg';
    const fileExt = isWebP ? 'webp' : 'jpg';

    // الخطوة 2: تحويل base64 → Blob بطريقة آمنة تعمل على Android APK
    let blob: Blob;
    try {
      // نحاول fetch أولاً (أسرع على الويب)
      const response = await fetch(compressedImage);
      if (!response.ok) throw new Error('fetch failed');
      blob = await response.blob();
      console.log('[Image Upload] Blob via fetch()');
    } catch {
      // Fallback آمن يعمل دائماً في Capacitor Android
      console.warn('[Image Upload] fetch() failed on data URL — using atob() fallback (Android safe)');
      blob = base64ToBlob(compressedImage, mimeType);
    }

    console.log(`[Image Upload] Blob size: ${(blob.size / 1024).toFixed(1)}KB (${mimeType})`);

    // الخطوة 3: رفع للسحابة — الحفظ داخل مجلد المستخدم لتتوافق مع سياسة الوصول
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${fileExt}`;
    let userFolder = 'products';
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.id) userFolder = user.id;
    } catch {
      // fallback يبقى 'products'
    }
    const filePath = `${userFolder}/products/${fileName}`;

    const { error } = await supabase.storage
      .from('product-images')
      .upload(filePath, blob, {
        contentType: mimeType,
        cacheControl: '3600',
        upsert: false,
      });

    if (error) {
      console.error('[Image Upload] Storage upload failed:', error);
      // الخطوة 4 (fallback): إرجاع data URL مضغوطة بدلاً من فشل كامل
      // هذا يضمن حفظ الصورة محلياً مع المنتج حتى لو فشل الرفع
      console.warn('[Image Upload] Falling back to compressed data URL for local save');
      return compressedImage;
    }

    console.log('[Image Upload] ✅ Uploaded to cloud:', filePath);
    // ✅ حفظ فوري للصورة في الكاش الدائم (IndexedDB) حتى لا تحتاج لإعادة تحميلها إطلاقاً
    try {
      const { saveProductImageToCache } = await import('./offline-image-store');
      await saveProductImageToCache(filePath, compressedImage);
    } catch (cacheErr) {
      console.warn('[Image Upload] Could not cache to IndexedDB:', cacheErr);
    }
    return filePath;
  } catch (error) {
    console.error('[Image Upload] Fatal error:', error);
    return null;
  }
}

/**
 * توليد signed URL من مسار ملف في Storage
 */
export async function getSignedImageUrl(storagePath: string): Promise<string | null> {
  try {
    if (!storagePath) return null;

    // إذا كانت data URL أو رابط خارجي — إرجاعه مباشرة
    if (storagePath.startsWith('http') || storagePath.startsWith('data:')) {
      return storagePath;
    }

    const cleanPath = storagePath.replace(/^\/+/, '');

    const { data, error } = await supabase.storage
      .from('product-images')
      .createSignedUrl(cleanPath, 60 * 60); // صالح لساعة

    if (error || !data?.signedUrl) {
      console.warn('[Image] Failed to get signed URL for:', cleanPath, error);
      return null;
    }

    return data.signedUrl;
  } catch (error) {
    console.error('[Image] getSignedImageUrl error:', error);
    return null;
  }
}

/**
 * حذف صورة منتج من Cloud Storage
 */
export async function deleteProductImage(imageUrl: string): Promise<boolean> {
  try {
    if (!imageUrl || imageUrl.startsWith('data:')) {
      return true; // data URLs لا تحتاج حذفاً من السحابة
    }

    if (imageUrl.startsWith('http')) {
      // استخراج المسار من URL
      const urlParts = imageUrl.split('/product-images/');
      if (urlParts.length < 2) return false;
      const filePath = urlParts[1].split('?')[0]; // إزالة query params
      const { error } = await supabase.storage.from('product-images').remove([filePath]);
      return !error;
    }

    // مسار مباشر
    const { error } = await supabase.storage.from('product-images').remove([imageUrl]);
    return !error;
  } catch (error) {
    console.error('[Image] deleteProductImage error:', error);
    return false;
  }
}

/**
 * التحقق مما إذا كانت الصورة مخزنة في السحابة
 */
export function isCloudImage(imageUrl: string | undefined): boolean {
  if (!imageUrl) return false;
  if (imageUrl.startsWith('data:')) return false;
  return imageUrl.includes('supabase') || imageUrl.startsWith('products/');
}
