import { AlertTriangle, Wifi } from 'lucide-react';
import { useLanguage } from '@/hooks/language-context';
import { useLicense } from '@/hooks/license-context';

const SHOW_OFFLINE_WARNING_BANNER: boolean = false;

export function OfflineProtectionBanner() {
  const { t, direction } = useLanguage();
  const { offlineDays, offlineWarning } = useLicense();

  // قرار المالك: لا يُعرض أي تنبيه مسبق قبل التشفير (حماية ضد النسخ المخترقة).
  // منطق العدّ والتشفير بعد 30 يوماً يبقى كما هو في use-license. لإعادة التنبيه احذف السطر التالي.
  if (SHOW_OFFLINE_WARNING_BANNER !== true) return null;
  if (!offlineWarning) return null;

  const remainingDays = 30 - offlineDays;

  // Color based on urgency
  const getBannerStyle = () => {
    if (offlineDays >= 25) return 'bg-destructive/90 text-destructive-foreground';
    if (offlineDays >= 20) return 'bg-warning/90 text-warning-foreground';
    return 'bg-warning/80 text-warning-foreground';
  };

  return (
    <div
      className={`fixed top-0 inset-x-0 z-[9999] px-4 pb-2 pt-[calc(0.5rem+var(--app-safe-top,0px))] flex items-center justify-center gap-2 text-sm font-medium ${getBannerStyle()}`}
      dir={direction}
    >
      <AlertTriangle className="w-4 h-4 shrink-0" />
      <span>
        {t('offlineProtection.warning')
          .replace('{days}', String(offlineDays))
          .replace('{remaining}', String(remainingDays))}
      </span>
      <Wifi className="w-4 h-4 shrink-0" />
    </div>
  );
}
