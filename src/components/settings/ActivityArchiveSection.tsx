import { useState, lazy, Suspense } from 'react';
import { Activity, Archive, ShieldCheck, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUserRole } from '@/hooks/use-user-role';
import { isGuestDemoMode } from '@/lib/demo-data';
import { useLanguage } from '@/hooks/use-language';

const ActivityLogSection = lazy(() => import('./ActivityLogSection').then(m => ({ default: m.ActivityLogSection })));
const IntegrityCheckSection = lazy(() => import('./IntegrityCheckSection').then(m => ({ default: m.IntegrityCheckSection })));
const ArchiveSection = lazy(() => import('./ArchiveSection').then(m => ({ default: m.ArchiveSection })));

type View = 'activity' | 'archive' | 'integrity';

/** Unified section: Activity Log (Boss) + Archive & Deleted + Data Integrity */
export function ActivityArchiveSection({ initialView }: { initialView?: View }) {
  const { isBoss } = useUserRole();
  const { t } = useLanguage();
  const canSeeActivity = isBoss && !isGuestDemoMode();
  const [view, setView] = useState<View>(initialView === 'archive' || !canSeeActivity ? 'archive' : 'activity');
  const active: View = !canSeeActivity ? 'archive' : view;

  const tabs: { id: View; label: string; Icon: typeof Activity }[] = [
    ...(canSeeActivity ? [{ id: 'activity' as View, label: t('archive.tabActivity' as any), Icon: Activity }] : []),
    { id: 'archive', label: t('archive.tabArchive' as any), Icon: Archive },
    ...(canSeeActivity ? [{ id: 'integrity' as View, label: t('archive.tabIntegrity' as any), Icon: ShieldCheck }] : []),
  ];

  return (
    <div className="space-y-3">
      {tabs.length > 1 && (
        <div className="bg-muted/60 p-1 rounded-2xl grid grid-cols-3 gap-1 border border-border/40 shadow-xs select-none">
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
        {active === 'activity' ? <ActivityLogSection /> : active === 'integrity' ? <IntegrityCheckSection /> : <ArchiveSection />}
      </Suspense>
    </div>
  );
}
