import React, { createContext, useContext, useRef, useEffect, useCallback } from 'react';

export interface PageActivityContextValue {
  isActive: boolean;
  activePath: string;
}

const PageActivityContext = createContext<PageActivityContextValue>({
  isActive: true,
  activePath: '',
});

export function PageActivityProvider({
  isActive,
  activePath,
  children,
}: {
  isActive: boolean;
  activePath: string;
  children: React.ReactNode;
}) {
  return (
    <PageActivityContext.Provider value={{ isActive, activePath }}>
      {children}
    </PageActivityContext.Provider>
  );
}

/**
 * usePageActivity
 * يُرجع حالة الصفحة الحالية: هل هي نشطة معروضة للمستخدم ({ isActive: true })
 * أم مخفية في الذاكرة بالخلفية ({ isActive: false }).
 */
export function usePageActivity(): PageActivityContextValue {
  return useContext(PageActivityContext);
}

export function usePageActivityDetails(): PageActivityContextValue {
  return useContext(PageActivityContext);
}

/**
 * useDeferWhileHidden
 * للصفحات المحفوظة في الذاكرة (Keep-Alive): تحديث البيانات القادم من أحداث المزامنة
 * يُنفَّذ فوراً إذا كانت الصفحة ظاهرة، ويؤجَّل إلى لحظة فتحها إذا كانت مخفية
 * (يُدمج التحديث المتكرر بنفس المفتاح في تحديث واحد). خارج Keep-Alive يعمل فوراً دائماً.
 */
export function useDeferWhileHidden(): (key: string, fn: () => void) => void {
  const { isActive } = useContext(PageActivityContext);
  const activeRef = useRef(isActive);
  activeRef.current = isActive;
  const pendingRef = useRef<Map<string, () => void>>(new Map());

  useEffect(() => {
    if (!isActive || pendingRef.current.size === 0) return;
    const fns = Array.from(pendingRef.current.values());
    pendingRef.current.clear();
    fns.forEach(fn => {
      try { fn(); } catch (err) { console.warn('[PageActivity] deferred refresh failed:', err); }
    });
  }, [isActive]);

  return useCallback((key: string, fn: () => void) => {
    if (activeRef.current) {
      fn();
    } else {
      pendingRef.current.set(key, fn);
    }
  }, []);
}
