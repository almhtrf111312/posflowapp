import { useState, useEffect, useCallback, ReactNode } from 'react';
import { ThemeContext, getThemeStorageKey, THEME_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY, applyTheme, DEFAULT_MODE, DEFAULT_COLOR, DEFAULT_BLUR, DEFAULT_TRANSPARENCY, DEFAULT_STYLE, normalizeThemeStyle, applyThemeStyle, applyBlurTheme, readStoredTheme } from '@/hooks/theme-context';
import type { ThemeMode, ThemeColor, ThemeStyle } from '@/hooks/theme-context';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [initialTheme] = useState(readStoredTheme);
  const [mode, setModeState] = useState<ThemeMode>(initialTheme.mode);
  const [color, setColorState] = useState<ThemeColor>(initialTheme.color);
  const [blurEnabled, setBlurEnabledState] = useState<boolean>(initialTheme.blur);
  const [transparencyLevel, setTransparencyLevelState] = useState<number>(initialTheme.transparency);
  const [themeStyle, setThemeStyleState] = useState<ThemeStyle>(initialTheme.style);
  const [isInitialized, setIsInitialized] = useState(false);

  // ✅ Step 1: Load from platform-isolated localStorage IMMEDIATELY (synchronous, no blocking)
  useEffect(() => {
    try {
      const platformKey = getThemeStorageKey();
      let saved = localStorage.getItem(platformKey);
      if (!saved) {
        saved = localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
      }
      if (saved) {
        const { mode: savedMode, color: savedColor, blur: savedBlur, transparency: savedTransparency, style: savedStyle } = JSON.parse(saved);
        const finalMode = savedMode || DEFAULT_MODE;
        const finalColor = savedColor || DEFAULT_COLOR;
        const finalBlur = savedBlur ?? DEFAULT_BLUR;
        const finalTransparency = savedTransparency ?? DEFAULT_TRANSPARENCY;
        const finalStyle: ThemeStyle = normalizeThemeStyle(savedStyle);
        setModeState(finalMode);
        setColorState(finalColor);
        setBlurEnabledState(finalBlur);
        setTransparencyLevelState(finalTransparency);
        setThemeStyleState(finalStyle);
        applyTheme(finalMode, finalColor);
        applyThemeStyle(finalStyle);
        applyBlurTheme(finalBlur, finalMode, finalTransparency);
      } else {
        applyTheme(DEFAULT_MODE, DEFAULT_COLOR);
        applyThemeStyle(DEFAULT_STYLE);
        applyBlurTheme(DEFAULT_BLUR, DEFAULT_MODE, DEFAULT_TRANSPARENCY);
      }
    } catch {
      applyTheme(DEFAULT_MODE, DEFAULT_COLOR);
      applyThemeStyle(DEFAULT_STYLE);
      applyBlurTheme(DEFAULT_BLUR, DEFAULT_MODE, DEFAULT_TRANSPARENCY);
    }
    setIsInitialized(true);
  }, []);

  // ✅ Step 2: Storage listener for same-platform multi-tab synchronization
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      const platformKey = getThemeStorageKey();
      if ((e.key === platformKey || e.key === THEME_STORAGE_KEY || e.key === LEGACY_THEME_STORAGE_KEY) && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          const finalMode = parsed.mode || DEFAULT_MODE;
          const finalColor = parsed.color || DEFAULT_COLOR;
          const finalBlur = parsed.blur ?? DEFAULT_BLUR;
          const finalTransparency = typeof parsed.transparency === 'number' ? parsed.transparency : DEFAULT_TRANSPARENCY;
          const finalStyle: ThemeStyle = normalizeThemeStyle(parsed.style);
          setModeState(finalMode);
          setColorState(finalColor);
          setBlurEnabledState(finalBlur);
          setTransparencyLevelState(finalTransparency);
          setThemeStyleState(finalStyle);
          applyTheme(finalMode, finalColor);
          applyThemeStyle(finalStyle);
          applyBlurTheme(finalBlur, finalMode, finalTransparency);
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const saveTheme = (m: ThemeMode, c: ThemeColor, b: boolean, t: number, s: ThemeStyle = themeStyle) => {
    try {
      const platformKey = getThemeStorageKey();
      const themeData = JSON.stringify({ mode: m, color: c, blur: b, transparency: t, style: s });
      localStorage.setItem(platformKey, themeData);
      localStorage.setItem(LEGACY_THEME_STORAGE_KEY, themeData);
    } catch {
      // ignore
    }
  };

  const setMode = (newMode: ThemeMode) => {
    setModeState(newMode);
    applyTheme(newMode, color);
    applyBlurTheme(blurEnabled, newMode, transparencyLevel);
    saveTheme(newMode, color, blurEnabled, transparencyLevel, themeStyle);
  };

  const setColor = (newColor: ThemeColor) => {
    setColorState(newColor);
    applyTheme(mode, newColor);
    saveTheme(mode, newColor, blurEnabled, transparencyLevel, themeStyle);
  };

  const setBlurEnabled = (enabled: boolean) => {
    setBlurEnabledState(enabled);
    applyBlurTheme(enabled, mode, transparencyLevel);
    saveTheme(mode, color, enabled, transparencyLevel, themeStyle);
  };

  const setTransparencyLevel = (level: number) => {
    setTransparencyLevelState(level);
    applyBlurTheme(blurEnabled, mode, level);
    saveTheme(mode, color, blurEnabled, level, themeStyle);
  };

  const setThemeStyle = (newStyle: ThemeStyle) => {
    setThemeStyleState(newStyle);
    applyThemeStyle(newStyle);
    applyBlurTheme(blurEnabled, mode, transparencyLevel);
    saveTheme(mode, color, blurEnabled, transparencyLevel, newStyle);
  };

  const setTheme = (newMode: ThemeMode, newColor: ThemeColor) => {
    setModeState(newMode);
    setColorState(newColor);
    applyTheme(newMode, newColor);
    applyBlurTheme(blurEnabled, newMode, transparencyLevel);
    saveTheme(newMode, newColor, blurEnabled, transparencyLevel, themeStyle);
  };

  const setFullTheme = (newMode: ThemeMode, newColor: ThemeColor, blur: boolean, transparency?: number, style?: ThemeStyle) => {
    const s = normalizeThemeStyle(style ?? themeStyle);
    const t = transparency ?? transparencyLevel;
    setModeState(newMode);
    setColorState(newColor);
    setBlurEnabledState(blur);
    setTransparencyLevelState(t);
    setThemeStyleState(s);
    applyTheme(newMode, newColor);
    applyThemeStyle(s);
    applyBlurTheme(blur, newMode, t);
    saveTheme(newMode, newColor, blur, t, s);
  };

  const previewTheme = useCallback((m: ThemeMode, c: ThemeColor, b: boolean, t: number, s?: ThemeStyle) => {
    applyTheme(m, c);
    if (s) applyThemeStyle(s);
    applyBlurTheme(b, m, t);
  }, []);

  const revertTheme = useCallback(() => {
    applyTheme(mode, color);
    applyThemeStyle(themeStyle);
    applyBlurTheme(blurEnabled, mode, transparencyLevel);
  }, [mode, color, blurEnabled, transparencyLevel, themeStyle]);

  return (
    <ThemeContext.Provider value={{ 
      mode, 
      color, 
      blurEnabled, 
      transparencyLevel, 
      themeStyle,
      setMode, 
      setColor, 
      setBlurEnabled, 
      setTransparencyLevel, 
      setThemeStyle,
      setTheme, 
      setFullTheme,
      previewTheme,
      revertTheme
    }}>
      {children}
    </ThemeContext.Provider>
  );
}
