import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface DashboardSkeletonProps {
  embedded?: boolean;
  className?: string;
}

/**
 * هيكل تحميل موحّد لصفحة لوحة التحكم (Dashboard)
 */
export function DashboardSkeleton({ embedded = false, className }: DashboardSkeletonProps) {
  return (
    <div
      className={cn('space-y-3 md:space-y-4', !embedded && 'p-4 md:p-6', className)}
      aria-busy="true"
      aria-live="polite"
    >
      {/* Header placeholder */}
      {!embedded && (
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-6 w-36 rounded-lg" />
            <Skeleton className="h-3.5 w-48 rounded-md" />
          </div>
          <Skeleton className="h-8 w-24 rounded-xl" />
        </div>
      )}

      {/* Quick Actions bar */}
      <div className="grid grid-cols-4 gap-2">
        {Array.from({ length: 4 }).map((_, idx) => (
          <Skeleton key={idx} className="h-12 rounded-xl" />
        ))}
      </div>

      {/* Primary KPI Row (3 columns) */}
      <div className="grid grid-cols-3 gap-2 md:gap-3">
        {Array.from({ length: 3 }).map((_, idx) => (
          <div
            key={idx}
            className="bg-card rounded-2xl border border-border p-3 md:p-4 space-y-2.5"
          >
            <div className="flex items-center justify-between">
              <Skeleton className="h-3.5 w-16 rounded" />
              <Skeleton className="h-7 w-7 rounded-xl" />
            </div>
            <Skeleton className="h-6 w-24 rounded-md" />
            <Skeleton className="h-3 w-14 rounded" />
          </div>
        ))}
      </div>

      {/* Secondary Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
        {Array.from({ length: 4 }).map((_, idx) => (
          <div
            key={idx}
            className="bg-card rounded-2xl border border-border p-3 space-y-2"
          >
            <Skeleton className="h-3 w-20 rounded" />
            <Skeleton className="h-5 w-24 rounded-md" />
          </div>
        ))}
      </div>

      {/* Main Chart / Analytics Card */}
      <div className="bg-card rounded-2xl border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-32 rounded" />
          <Skeleton className="h-7 w-20 rounded-lg" />
        </div>
        <Skeleton className="h-44 w-full rounded-xl" />
      </div>
    </div>
  );
}

interface ListPageSkeletonProps {
  rows?: number;
  showStats?: boolean;
  showSearch?: boolean;
  className?: string;
}

/**
 * هيكل تحميل موحّد للصفحات القائمة على القوائم (الديون، المصاريف، الورديات)
 */
export function ListPageSkeleton({
  rows = 5,
  showStats = false,
  showSearch = false,
  className,
}: ListPageSkeletonProps) {
  return (
    <div className={cn('space-y-2.5', className)} aria-busy="true" aria-live="polite">
      {showStats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {Array.from({ length: 4 }).map((_, idx) => (
            <div
              key={idx}
              className="bg-card rounded-xl border border-border p-3 space-y-2 text-center"
            >
              <Skeleton className="h-3 w-16 mx-auto rounded" />
              <Skeleton className="h-5 w-20 mx-auto rounded-md" />
            </div>
          ))}
        </div>
      )}

      {showSearch && <Skeleton className="h-9 w-full rounded-xl" />}

      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, idx) => (
          <div
            key={idx}
            className="bg-card rounded-2xl border border-border p-3 md:p-3.5 flex items-center justify-between gap-3"
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <Skeleton className="h-10 w-10 rounded-xl shrink-0" />
              <div className="space-y-2 flex-1 min-w-0">
                <Skeleton className="h-4 w-2/5 max-w-[180px] rounded" />
                <Skeleton className="h-3 w-3/5 max-w-[240px] rounded" />
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              <Skeleton className="h-4 w-16 rounded" />
              <Skeleton className="h-5 w-14 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface CardsGridSkeletonProps {
  count?: number;
  columns?: 2 | 3;
  showStats?: boolean;
  showSearch?: boolean;
  className?: string;
}

/**
 * هيكل تحميل موحّد للصفحات القائمة على شبكة البطاقات (العملاء، المنتجات)
 */
export function CardsGridSkeleton({
  count = 6,
  columns = 3,
  showStats = false,
  showSearch = false,
  className,
}: CardsGridSkeletonProps) {
  const gridCols =
    columns === 2
      ? 'grid-cols-1 md:grid-cols-2'
      : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3';

  return (
    <div className={cn('space-y-3', className)} aria-busy="true" aria-live="polite">
      {showStats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {Array.from({ length: 4 }).map((_, idx) => (
            <div
              key={idx}
              className="bg-card rounded-xl border border-border p-2.5 space-y-1.5"
            >
              <Skeleton className="h-3 w-14 mx-auto rounded" />
              <Skeleton className="h-5 w-16 mx-auto rounded-md" />
            </div>
          ))}
        </div>
      )}

      {showSearch && <Skeleton className="h-9 w-full rounded-xl" />}

      <div className={cn('grid gap-2.5', gridCols)}>
        {Array.from({ length: count }).map((_, idx) => (
          <div
            key={idx}
            className="bg-card rounded-2xl border border-border p-3.5 space-y-3"
          >
            <div className="flex items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-full shrink-0" />
              <div className="space-y-1.5 flex-1 min-w-0">
                <Skeleton className="h-4 w-3/4 rounded" />
                <Skeleton className="h-3 w-1/2 rounded" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border/50">
              <div className="space-y-1">
                <Skeleton className="h-2.5 w-12 rounded" />
                <Skeleton className="h-4 w-20 rounded" />
              </div>
              <div className="space-y-1">
                <Skeleton className="h-2.5 w-12 rounded" />
                <Skeleton className="h-4 w-20 rounded" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
