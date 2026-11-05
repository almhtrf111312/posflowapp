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
export function executeCircularTransition(
  event: ThemeTransitionEvent,
  updateCallback: () => void
): void {
  // التحقق من دعم المتصفح / الـ WebView وتفضيل تقليل الحركة
  const prefersReducedMotion = typeof window !== 'undefined' && 
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const supportsViewTransition = typeof document !== 'undefined' && 
    'startViewTransition' in document;

  if (!supportsViewTransition || prefersReducedMotion) {
    // Fallback آمن: تطبيق التغيير فوراً
    updateCallback();
    return;
  }

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
        duration: 400,
        easing: 'cubic-bezier(0.4, 0, 0.2, 1)', // حركة طبيعية وانسيابية
        pseudoElement: '::view-transition-new(root)'
      } as any
    );
  }).catch(() => {
    // في حال حدوث أي مقاطعة للحركة
    updateCallback();
  });
}
