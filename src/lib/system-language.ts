import { Capacitor } from '@capacitor/core';

/**
 * Get the current system language code
 * @returns Language code (e.g., 'ar', 'en', 'en-US')
 */
export async function getSystemLanguage(): Promise<string> {
  try {
    if (!Capacitor.isNativePlatform()) return (typeof navigator !== 'undefined' && navigator.language) || 'ar';
    const { Device } = await import('@capacitor/device');
    const info = await Device.getLanguageCode();
    return info.value; // Returns language code like 'ar', 'en', etc.
  } catch (error) {
    console.error('Failed to get system language:', error);
    return 'ar'; // Default fallback to Arabic
  }
}

/**
 * Map system language codes to app-supported languages
 * @param systemLang - System language code
 * @returns Mapped language code ('ar' or 'en')
 */
export function mapSystemLanguage(systemLang: string): 'ar' | 'en' | 'tr' | 'fa' | 'ku' {
  if (!systemLang) return 'ar';
  // Handle language codes with region (e.g., 'en-US', 'ar-SA')
  const baseLang = systemLang.split('-')[0].toLowerCase();
  
  // Map to supported languages
  if (baseLang === 'ar') return 'ar';
  if (baseLang === 'en') return 'en';
  // التركية والفارسية والكردية معطّلة مؤقتاً: تعود إلى العربية
  return 'ar'; // Default to Arabic for PosFlow
}

/**
 * Setup listener for system language changes
 * Triggers when app becomes active (e.g., returning from Settings)
 * @param callback - Function to call with new language
 */
export function setupSystemLanguageListener(callback: (lang: string) => void) {
  let lastMapped: string | null = null;
  if (!Capacitor.isNativePlatform()) return;
  void import('@capacitor/app').then(({ App }) => App.addListener('appStateChange', async ({ isActive }) => {
    if (!isActive) return;
    const systemLang = await getSystemLanguage();
    const mappedLang = mapSystemLanguage(systemLang);
    if (mappedLang === lastMapped) return;
    lastMapped = mappedLang;
    callback(mappedLang);
  })).catch(() => {});
}

/**
 * Initialize and get the appropriate language based on user preference
 * @param userPreference - User's saved preference
 * @returns Language to use - Defaults strictly to 'ar' on first launch
 */
export async function initializeLanguage(userPreference: string | null): Promise<'ar' | 'en' | 'tr' | 'fa' | 'ku'> {
  // Use user's explicit preference if valid
  const validLangs = ['ar', 'en'] as const;
  if (userPreference && (validLangs as readonly string[]).includes(userPreference)) {
    return userPreference as (typeof validLangs)[number];
  }
  
  // Default is ALWAYS Arabic on first launch / no preference
  return 'ar';
}
