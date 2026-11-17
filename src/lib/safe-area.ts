import { Capacitor } from '@capacitor/core';

/**
 * يثبّت ارتفاع شريط حالة النظام (البطارية/الواي فاي) كمتغير CSS ثابت: --native-status-bar-height
 * بعض إصدارات WebView على أندرويد (edge-to-edge) تعيد env(safe-area-inset-top)=0 فتبدأ النوافذ خلف الشريط.
 * القيمة تُقاس مرة واحدة عند الإقلاع فلا تتغير لاحقاً (فلا يتحرك أي زر ثابت).
 */
const FALLBACK_ANDROID_STATUS_BAR_PX = 28;

export function initSafeArea(): void {
  if (typeof document === 'undefined') return;
  try {
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding-top:env(safe-area-inset-top,0px)';
    document.body.appendChild(probe);
    const envTop = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();

    let top = envTop;
    if (top < 1 && Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      top = FALLBACK_ANDROID_STATUS_BAR_PX;
    }
    document.documentElement.style.setProperty('--native-status-bar-height', `${Math.round(top)}px`);
  } catch {
    /* ignore */
  }
}
