import { useState, useEffect, ReactNode, useCallback } from 'react';
import { Language, getCurrentLanguage, setLanguage as setLangStorage, t as translate, TranslationKey, initializeLanguage, languages } from '@/lib/i18n';
import { getSystemLanguage, mapSystemLanguage, setupSystemLanguageListener } from '@/lib/system-language';
import { getTerminology, getCurrentStoreType, TerminologyKey } from '@/lib/store-type-config';
import { subscribeToEvent, EVENTS } from '@/lib/events';
import { LanguageContext, RTL_LANGUAGES } from '@/hooks/language-context';

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => getCurrentLanguage());

  // ✅ Auto-detect system language on mount only if 'auto'
  useEffect(() => {
    const initLanguage = async () => {
      const savedLang = getCurrentLanguage();

      if ((savedLang as string) === 'auto') {
        const systemLang = await getSystemLanguage();
        const mappedLang = mapSystemLanguage(systemLang);
        setLanguageState(mappedLang);
        const langInfo = languages.find(l => l.code === mappedLang);
        const dir = langInfo?.direction || 'rtl';
        document.documentElement.dir = dir;
        document.documentElement.lang = mappedLang;
        document.documentElement.classList.remove('rtl', 'ltr');
        document.documentElement.classList.add(dir);
      } else {
        const langInfo = languages.find(l => l.code === savedLang);
        const dir = langInfo?.direction || 'rtl';
        document.documentElement.dir = dir;
        document.documentElement.lang = savedLang;
        document.documentElement.classList.remove('rtl', 'ltr');
        document.documentElement.classList.add(dir);
      }
    };

    initLanguage();

    // ✅ Listen for system language changes (when user returns from Settings)
    setupSystemLanguageListener(async (newLang) => {
      const savedLang = getCurrentLanguage();
      if ((savedLang as string) === 'auto') {
        setLanguageState(newLang as Language);
        const langInfo = languages.find(l => l.code === newLang);
        const dir = langInfo?.direction || 'rtl';
        document.documentElement.dir = dir;
        document.documentElement.lang = newLang;
        document.documentElement.classList.remove('rtl', 'ltr');
        document.documentElement.classList.add(dir);
      }
    });
  }, []);

  useEffect(() => {
    initializeLanguage();
  }, []);

  // Apply RTL/LTR styles to document
  useEffect(() => {
    const isRTL = RTL_LANGUAGES.includes(language);

    // Set document direction
    document.documentElement.dir = isRTL ? 'rtl' : 'ltr';
    document.documentElement.lang = language;

    // Add/remove RTL class for CSS targeting
    if (isRTL) {
      document.documentElement.classList.add('rtl');
      document.documentElement.classList.remove('ltr');
    } else {
      document.documentElement.classList.add('ltr');
      document.documentElement.classList.remove('rtl');
    }

    // Update meta for proper rendering
    const metaViewport = document.querySelector('meta[name="viewport"]');
    if (metaViewport) {
      metaViewport.setAttribute('content', 'width=device-width, initial-scale=1.0');
    }
  }, [language]);

  useEffect(() => {
    const handleLanguageChange = (e: CustomEvent<Language>) => {
      setLanguageState(e.detail);
    };

    window.addEventListener('languagechange', handleLanguageChange as EventListener);
    return () => {
      window.removeEventListener('languagechange', handleLanguageChange as EventListener);
    };
  }, []);

  const setLanguage = useCallback((lang: Language) => {
    setLangStorage(lang);
    setLanguageState(lang);
  }, []);

  // يتغير عند اكتمال تحميل ملف ترجمة لغة (التحميل عند الحاجة) لإعادة رسم النصوص
  const [translationsVersion, setTranslationsVersion] = useState(0);
  useEffect(() => {
    const onLoaded = () => setTranslationsVersion(v => v + 1);
    window.addEventListener('translationsloaded', onLoaded);
    return () => window.removeEventListener('translationsloaded', onLoaded);
  }, []);

  const t = useCallback((key: TranslationKey, lang?: Language) => {
    return translate(key, lang || language);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, translationsVersion]);

  const [storeType, setStoreType] = useState(getCurrentStoreType);

  // Listen for store type changes (emitted from Settings page or cloud sync)
  useEffect(() => {
    const refreshStoreType = () => setStoreType(getCurrentStoreType());

    // STORE_TYPE_CHANGED: emitted when user changes store type in Settings
    const unsubStoreType = subscribeToEvent(EVENTS.STORE_TYPE_CHANGED, refreshStoreType);
    // SETTINGS_UPDATED: emitted after cloud sync pulls fresh settings — must also refresh
    const unsubSettings = subscribeToEvent(EVENTS.SETTINGS_UPDATED, refreshStoreType);

    return () => {
      unsubStoreType();
      unsubSettings();
    };
  }, []);

  const tDynamic = useCallback((key: TerminologyKey) => {
    return getTerminology(storeType, key, language);
  }, [language, storeType]);

  const direction = languages.find(l => l.code === language)?.direction || 'rtl';
  const isRTL = RTL_LANGUAGES.includes(language);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t, tDynamic, storeType, languages, direction, isRTL }}>
      {children}
    </LanguageContext.Provider>
  );
}
