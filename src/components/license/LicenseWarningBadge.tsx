import { useState, useEffect, useRef } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useLicense } from '@/hooks/license-context';
import { useLanguage } from '@/hooks/language-context';
import { useAuth } from '@/hooks/auth-context';
import { cn } from '@/lib/utils';

export function LicenseWarningBadge() {
  const { user } = useAuth();
  const { isTrial, remainingDays, isValid, expiringWarning, isLoading } = useLicense();
  const { t, isRTL } = useLanguage();
  const [visibleFor, setVisibleFor] = useState<string | null>(null);
  const lastShown = useRef<string | null>(null);
  const accountId = user?.id;
  const eligible = !isLoading && isValid && remainingDays !== null &&
    (isTrial || expiringWarning || remainingDays <= 30);

  useEffect(() => {
    if (!accountId || !eligible) {
      setVisibleFor(null);
      return;
    }

    const storageKey = `hp_license_warning_day:${accountId}`;
    const showForToday = () => {
      if (document.visibilityState !== 'visible') return;
      const day = new Date().toDateString();
      const dailyKey = `${accountId}:${day}`;
      if (lastShown.current === dailyKey) return;
      try {
        if (localStorage.getItem(storageKey) === day) {
          setVisibleFor(null);
          return;
        }
        localStorage.setItem(storageKey, day);
      } catch { /* Keep the once-per-day limit in memory if storage is unavailable. */ }
      lastShown.current = dailyKey;
      setVisibleFor(accountId);
    };

    showForToday();
    document.addEventListener('visibilitychange', showForToday);
    const timer = window.setInterval(showForToday, 30_000);
    return () => {
      document.removeEventListener('visibilitychange', showForToday);
      window.clearInterval(timer);
    };
  }, [accountId, eligible]);

  if (!accountId || !eligible || visibleFor !== accountId || remainingDays === null) return null;

  const isCritical = remainingDays <= 7;
  const isUrgent = remainingDays <= 14;

  return (
    <button
      type="button"
      className={cn(
        "fixed z-50 flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg cursor-pointer transition-all duration-300 hover:scale-105",
        "end-2 top-[calc(0.75rem+var(--app-safe-top,0px))] md:top-3 opacity-95 scale-90 origin-top-end",
        isCritical 
          ? "bg-destructive text-destructive-foreground" 
          : isUrgent 
            ? "bg-warning text-warning-foreground" 
            : "bg-warning/90 text-warning-foreground"
      )}
      onClick={() => setVisibleFor(null)}
      dir={isRTL ? 'rtl' : 'ltr'}
      title={t('license.clickToDismiss')}
    >
      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
      <span className="text-sm font-medium whitespace-nowrap">
        {`${isTrial ? t('license.trialPrefix') : ''}${remainingDays} ${remainingDays === 1 ? t('license.days') : t('license.daysPlural')} ${t('license.daysLeft')}`}
      </span>
      <X className="w-3 h-3 flex-shrink-0 opacity-70 hover:opacity-100" />
    </button>
  );
}
