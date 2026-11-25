import React, { useMemo } from 'react';
import { PageActivityContext } from '@/contexts/page-activity-context';

export function PageActivityProvider({
  isActive,
  activePath,
  children,
}: {
  isActive: boolean;
  activePath: string;
  children: React.ReactNode;
}) {
  const value = useMemo(() => ({ isActive, activePath }), [isActive, activePath]);
  return (
    <PageActivityContext.Provider value={value}>
      {children}
    </PageActivityContext.Provider>
  );
}
