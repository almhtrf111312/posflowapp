import type React from 'react';

export type ThemeTransitionEvent = 
  | React.MouseEvent<HTMLElement>
  | React.TouchEvent<HTMLElement>
  | MouseEvent
  | TouchEvent
  | null
  | undefined;

/**
 * تنفيذ انتقال دائري سلس للثيم أو اللون أو النمط
 * @param event حدث النقر (ماوس أو لمس) لتحديد مركز الدائرة
 * @param updateCallback دالة تطبيق التغييرات على الـ DOM وحالة الثيم
 */
const isNativeWebView = (): boolean => {
  try {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    return !!cap?.isNativePlatform?.() || /android/i.test(navigator.userAgent);
  } catch { return false; }
};

/**
 * مسار خفيف لأجهزة الأندرويد: دائرة تتوسّع بتحويل GPU فقط (transform) فوق الشاشة،
 * ثم يُطبَّق الثيم مرة واحدة تحت الدائرة ويتلاشى الغطاء. لا لقطات (View Transition) ولا إعادة رسم أثناء الحركة،
 * فلا يتقطع الإطار ولا يتأثر التمرير.
 */
function runOverlayReveal(x: number, y: number, endRadius: number, color: string, updateCallback: () => void): void {
  const size = endRadius * 2;
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = [
    'position:fixed', `left:${x - endRadius}px`, `top:${y - endRadius}px`,
    `width:${size}px`, `height:${size}px`, 'border-radius:50%',
    `background:${color}`, 'pointer-events:none', 'z-index:2147483000',
    'transform:scale(0)', 'will-change:transform,opacity', 'backface-visibility:hidden',
  ].join(';');
  document.body.appendChild(el);

  const grow = el.animate(
    [{ transform: 'scale(0)' }, { transform: 'scale(1)' }],
    { duration: 1500, easing: 'cubic-bezier(0.45, 0.05, 0.25, 1)', fill: 'forwards' }
  );
  grow.onfinish = () => {
    // الشاشة مغطاة بالكامل: نطبّق الثيم الآن مرة واحدة ثم نُذيب الغطاء
    updateCallback();
    requestAnimationFrame(() => {
      const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 380, easing: 'ease-out', fill: 'forwards' });
      fade.onfinish = () => el.remove();
    });
  };
  grow.oncancel = () => { el.remove(); };
}

export function executeCircularTransition(
  event: ThemeTransitionEvent,
  updateCallback: () => void,
  overlayColor?: string,
  immediate = false
): void {
  if (immediate || (typeof document !== 'undefined' && document.documentElement.classList.contains('theme-soft'))) {
    updateCallback();
    return;
  }

  // التحقق من دعم المتصفح / الـ WebView وتفضيل تقليل الحركة
  const prefersReducedMotion = typeof window !== 'undefined' && 
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const supportsViewTransition = typeof document !== 'undefined' && 
    'startViewTransition' in document;

  // استخراج إحداثيات المركز من الحدث (يدعم أجهزة اللمس والماوس)
  let x = window.innerWidth / 2;
  let y = window.innerHeight / 2;

  if (event) {
    if ('clientX' in event && typeof event.clientX === 'number' && typeof event.clientY === 'number') {
      x = event.clientX;
      y = event.clientY;
    } else if ('touches' in event && event.touches && event.touches[0]) {
      x = event.touches[0].clientX;
      y = event.touches[0].clientY;
    }
  }

  // حساب أقصى نصف قطر لتغطية أبعد زاوية من الشاشة:
  // r = √(max(x, w-x)² + max(y, h-y)²)
  const endRadius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y)
  );

  if (overlayColor && isNativeWebView() && !prefersReducedMotion) {
    runOverlayReveal(x, y, endRadius, overlayColor, updateCallback);
    return;
  }

  if (!supportsViewTransition || prefersReducedMotion) {
    // Fallback آمن: تطبيق التغيير مع تلاشٍ خفيف للألوان
    const root = document.documentElement;
    root.classList.add('theme-transitioning');
    updateCallback();
    setTimeout(() => root.classList.remove('theme-transitioning'), 500);
    return;
  }

  // بدء لقطة الانتقال
  const transition = (document as any).startViewTransition(() => {
    updateCallback();
  });

  transition.ready.then(() => {
    const clipPath = [
      `circle(0px at ${x}px ${y}px)`,
      `circle(${endRadius}px at ${x}px ${y}px)`
    ];

    document.documentElement.animate(
      {
        clipPath: clipPath
      },
      {
        duration: 1600,
        easing: 'cubic-bezier(0.45, 0.05, 0.25, 1)', // بداية هادئة وانسياب طويل ليظهر توسّع الدائرة
        pseudoElement: '::view-transition-new(root)'
      } as any
    );
  }).catch(() => {
    // في حال حدوث أي مقاطعة للحركة
    updateCallback();
  });
}
