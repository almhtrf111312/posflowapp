// Internationalization (i18n) system for PosFlow
export type Language = 'ar' | 'en' | 'tr' | 'fa' | 'ku';

export interface LanguageInfo {
  code: Language;
  name: string;
  nativeName: string;
  direction: 'ltr' | 'rtl';
}

export const languages: LanguageInfo[] = [
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', direction: 'rtl' },
  { code: 'en', name: 'English', nativeName: 'English', direction: 'ltr' },
  // التركية والفارسية والكردية معطّلة مؤقتاً حتى تكتمل ترجمتها (ملفات الترجمة محفوظة، أعد السطور لتفعيلها):
  // { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', direction: 'ltr' },
  // { code: 'fa', name: 'Persian', nativeName: 'فارسی', direction: 'rtl' },
  // { code: 'ku', name: 'Kurdish', nativeName: 'کوردی', direction: 'rtl' },
];

/** اللغات المفعّلة حالياً: أي لغة محفوظة خارجها (من إصدار سابق) تعود إلى العربية */
export const ENABLED_LANGUAGE_CODES: Language[] = ['ar', 'en'];


import ar from './locales/ar';

export type TranslationKey = keyof typeof ar;
export type TranslationDict = Partial<Record<string, string>>;

// العربية مضمّنة دائماً (اللغة الافتراضية والاحتياطية)، وباقي اللغات تُحمَّل عند الحاجة فقط
const translations: Partial<Record<Language, TranslationDict>> = { ar };

const localeLoaders: Record<Exclude<Language, 'ar'>, () => Promise<{ default: TranslationDict }>> = {
  en: () => import('./locales/en'),
  tr: () => import('./locales/tr'),
  fa: () => import('./locales/fa'),
  ku: () => import('./locales/ku'),
};

const pendingLoads: Partial<Record<Language, Promise<void>>> = {};

/** تحميل ملف ترجمة لغة معيّنة مرة واحدة؛ يُطلق حدث translationsloaded عند الجاهزية لإعادة رسم الواجهة */
export function loadLanguage(lang: Language): Promise<void> {
  if (translations[lang]) return Promise.resolve();
  if (lang === 'ar') return Promise.resolve();
  if (!pendingLoads[lang]) {
    pendingLoads[lang] = localeLoaders[lang]()
      .then(mod => {
        translations[lang] = mod.default;
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('translationsloaded', { detail: lang }));
        }
      })
      .catch(err => {
        delete pendingLoads[lang];
        console.warn('[i18n] Failed to load language', lang, err);
      });
  }
  return pendingLoads[lang]!;
}


// Language helpers
export function getCurrentLanguage(): Language {
  if (typeof window === 'undefined') return 'ar';
  try {
    const stored = localStorage.getItem('posflow_language');
    if (stored && ENABLED_LANGUAGE_CODES.includes(stored as Language)) return stored as Language;
    // أول تشغيل أو لغة معطّلة محفوظة سابقاً: العربية وتُحفظ فوراً
    localStorage.setItem('posflow_language', 'ar');
  } catch {}
  return 'ar';
}

export function setLanguage(lang: Language): void {
  void loadLanguage(lang);
  try {
    localStorage.setItem('posflow_language', lang);
  } catch {}
  const dir = languages.find(l => l.code === lang)?.direction || (lang === 'en' || lang === 'tr' ? 'ltr' : 'rtl');
  if (typeof document !== 'undefined') {
    document.documentElement.dir = dir;
    document.documentElement.lang = lang;
    document.documentElement.classList.remove('rtl', 'ltr');
    document.documentElement.classList.add(dir);
  }

  // Dispatch event for components to react
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('languagechange', { detail: lang }));
  }
}

export function t(key: TranslationKey, lang?: Language): string {
  const currentLang = lang || getCurrentLanguage();
  const dict = translations[currentLang];
  if (!dict) void loadLanguage(currentLang);
  const translation = dict?.[key];

  // Fallback chain: current language -> Arabic -> English -> key
  if (translation) return translation;
  if (currentLang !== 'ar' && translations.ar?.[key]) return translations.ar[key] as string;
  if (currentLang !== 'en' && translations.en?.[key]) return translations.en[key] as string;

  return key;
}

export function initializeLanguage(): void {
  const lang = getCurrentLanguage();
  void loadLanguage(lang);
  const dir = languages.find(l => l.code === lang)?.direction || (lang === 'en' || lang === 'tr' ? 'ltr' : 'rtl');
  if (typeof document !== 'undefined') {
    document.documentElement.dir = dir;
    document.documentElement.lang = lang;
    document.documentElement.classList.remove('rtl', 'ltr');
    document.documentElement.classList.add(dir);
  }
}

// Automatically initialize language and direction on module load
if (typeof document !== 'undefined') {
  initializeLanguage();
}

