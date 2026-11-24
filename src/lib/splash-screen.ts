import { Capacitor } from '@capacitor/core';

/**
 * Safely hide the native Android/iOS splash screen as early as possible
 * once the initial UI layout has rendered, without waiting for network or cloud responses.
 */
export function hideSplashScreen(): void {
  try {
    if (Capacitor.isNativePlatform()) {
      const plugins = (Capacitor as unknown as { Plugins?: { SplashScreen?: { hide?: () => void } } }).Plugins || (typeof window !== 'undefined' ? (window as unknown as { Capacitor?: { Plugins?: { SplashScreen?: { hide?: () => void } } } }).Capacitor?.Plugins : undefined);
      if (plugins?.SplashScreen && typeof plugins.SplashScreen.hide === 'function') {
        plugins.SplashScreen.hide();
      }
    }
  } catch (err) {
    console.warn('[SplashScreen] Hide error:', err);
  }
}
