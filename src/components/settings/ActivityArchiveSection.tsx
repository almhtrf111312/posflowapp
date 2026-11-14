import { useState, lazy, Suspense } from 'react';
import { Activity, Archive, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUserRole } from '@/hooks/use-user-role';
import { isGuestDemoMode } from '@/lib/demo-data';

const ActivityLogSection = lazy(() => import('./ActivityLogSection').then(m => ({ default: m.ActivityLogSection })));
const ArchiveSection = lazy(() => import('./ArchiveSection').then(m => ({ default: m.ArchiveSection })));

type View = 'activity' | 'archive';

/** قسم موحّد: سجل النشاط (للمدير العام) + الأرشيف والمحذوفات في صفحة واحدة بتبويبين */
export function ActivityArchiveSection({ initialView }: { initialView?: View }) {
  const { isBoss } = useUserRole();
  const canSeeActivity = isBoss && !isGuestDemoMode();
  const [view, setView] = useState<View>(initialView === 'archive' || !canSeeActivity ? 'archive' : 'activity');
  const active: View = !canSeeActivity ? 'archive' : view;

  const tabs: { id: View; label: string; Icon: typeof Activity }[] = [
    ...(canSeeActivity ? [{ id: 'activity' as View, label: 'سجل النشاط', Icon: Activity }] : []),
    { id: 'archive', label: 'الأرشيف والمحذوفات', Icon: Archive },
  ];

  return (
    <div className="space-y-3">
      {tabs.length > 1 && (
        <div className="bg-muted/60 p-1 rounded-2xl grid grid-cols-2 gap-1 border border-border/40 shadow-xs select-none">
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={cn(
                'rounded-xl py-2 px-3 text-sm font-bold flex items-center justify-center gap-1.5 transition-colors',
                active === id
                  ? 'bg-gradient-primary text-primary-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground hover:bg-card/60'
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
      <Suspense fallback={<div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>}>
        {active === 'activity' ? <ActivityLogSection /> : <ArchiveSection />}
      </Suspense>
    </div>
  );
}
