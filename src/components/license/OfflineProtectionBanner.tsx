import { AlertTriangle, Wifi } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { useLicense } from '@/hooks/use-license';

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
    if (offlineDays >= 25) return 'bg-red-500/90 text-white';
    if (offlineDays >= 20) return 'bg-orange-500/90 text-white';
    return 'bg-yellow-500/90 text-black';
  };

  return (
    <div
      className={`fixed top-0 left-0 right-0 z-[9999] px-4 py-2 flex items-center justify-center gap-2 text-sm font-medium ${getBannerStyle()}`}
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
