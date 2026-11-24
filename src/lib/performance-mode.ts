import { useState, useEffect } from 'react';

export type PerformanceModePref = 'auto' | 'full' | 'lite';
export type EffectivePerformanceMode = 'full' | 'lite';

const PERF_MODE_STORAGE_KEY = 'posflow_perf_mode_v1';

export function detectLowEndDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return true;
    }
    const nav = navigator as Navigator & { deviceMemory?: number };
    // أجهزة آبل (آيفون/آيباد) يحجب Safari عدد أنويتها الحقيقي ويُظهر رقماً صغيراً،
    // فكانت تُصنَّف ضعيفة خطأً ويُلغى التأثير الزجاجي بالكامل عليها
    const isAppleMobile = /iPad|iPhone|iPod/.test(nav.userAgent)
      || (nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1);
    if (isAppleMobile) {
      return false;
    }
    if (typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 4) {
      return true;
    }
    if (typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency <= 4) {
      return true;
    }
  } catch {
    // تجاهل أي قيود متصفح
  }
  return false;
}

export function getPerformanceModePref(): PerformanceModePref {
  if (typeof window === 'undefined') return 'auto';
  try {
    const saved = window.localStorage.getItem(PERF_MODE_STORAGE_KEY);
    if (saved === 'full' || saved === 'lite' || saved === 'auto') {
      return saved;
    }
  } catch {
    // تجاهل
  }
  return 'auto';
}

export function resolveEffectivePerformanceMode(pref?: PerformanceModePref): EffectivePerformanceMode {
  const mode = pref ?? getPerformanceModePref();
  if (mode === 'lite') return 'lite';
  if (mode === 'full') return 'full';
  return detectLowEndDevice() ? 'lite' : 'full';
}

export function applyPerformanceModeToDOM(pref?: PerformanceModePref): EffectivePerformanceMode {
  const effective = resolveEffectivePerformanceMode(pref);
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-perf', effective);
  }
  return effective;
}

export function setPerformanceModePref(pref: PerformanceModePref): EffectivePerformanceMode {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(PERF_MODE_STORAGE_KEY, pref);
    } catch {
      // تجاهل
    }
  }
  const effective = applyPerformanceModeToDOM(pref);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('posflow:perf-mode-changed', { detail: { pref, effective } }));
  }
  return effective;
}

export function initPerformanceMode(): EffectivePerformanceMode {
  return applyPerformanceModeToDOM();
}

export function usePerformanceMode() {
  const [pref, setPrefState] = useState<PerformanceModePref>(getPerformanceModePref);
  const [effective, setEffective] = useState<EffectivePerformanceMode>(() => resolveEffectivePerformanceMode(pref));

  useEffect(() => {
    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<{ pref: typeof pref; effective: EffectivePerformanceMode }>;
      if (customEvent.detail) {
        setPrefState(customEvent.detail.pref);
        setEffective(customEvent.detail.effective);
      } else {
        const p = getPerformanceModePref();
        setPrefState(p);
        setEffective(resolveEffectivePerformanceMode(p));
      }
    };
    window.addEventListener('posflow:perf-mode-changed', handler as EventListener);
    return () => window.removeEventListener('posflow:perf-mode-changed', handler as EventListener);
  }, []);

  return {
    pref,
    effective,
    setPref: setPerformanceModePref,
  };
}
