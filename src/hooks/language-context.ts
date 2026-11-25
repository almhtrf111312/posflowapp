import { createContext, useContext } from 'react';
import { Language, getCurrentLanguage, TranslationKey, languages, LanguageInfo } from '@/lib/i18n';
import { getCurrentStoreType, TerminologyKey } from '@/lib/store-type-config';

export interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey, lang?: Language) => string;
  tDynamic: (key: TerminologyKey) => string;
  storeType: string;
  languages: LanguageInfo[];
  direction: 'ltr' | 'rtl';
  isRTL: boolean;
}
export const LanguageContext = createContext<LanguageContextType | undefined>(undefined);
// RTL languages from the supported list
export const RTL_LANGUAGES: Language[] = ['ar', 'fa', 'ku'];
// Synchronous DOM setup on module evaluation to guarantee immediate RTL layout on first launch
if (typeof document !== 'undefined') {
  const initLang = getCurrentLanguage();
  const isRtl = RTL_LANGUAGES.includes(initLang);
  document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
  document.documentElement.lang = initLang;
  document.documentElement.classList.remove('rtl', 'ltr');
  document.documentElement.classList.add(isRtl ? 'rtl' : 'ltr');
}
export function useLanguage() {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    // Fallback for components rendered outside LanguageProvider
    // (e.g. during hot-reload or provider hierarchy issues)
    const fallbackT = (key: string) => key;
    return {
      language: getCurrentLanguage() as Language,
      setLanguage: (_lang: Language) => {},
      t: fallbackT as (key: TranslationKey) => string,
      tDynamic: (key: TerminologyKey) => key,
      storeType: getCurrentStoreType(),
      languages,
      direction: 'rtl' as const,
      isRTL: true,
    };
  }
  return context;
}
