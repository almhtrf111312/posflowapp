// Shown in place of a section that requires an active subscription (trial users).
import { useNavigate } from 'react-router-dom';
import { Lock, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/hooks/use-language';

interface SubscriptionLockNoticeProps {
  sectionName?: string;
}

export function SubscriptionLockNotice({ sectionName }: SubscriptionLockNoticeProps) {
  const navigate = useNavigate();
  const { t, direction } = useLanguage();

  return (
    <div dir={direction} className="flex min-h-[60vh] items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <Lock className="h-6 w-6 text-primary" />
        </div>
        <h2 className="text-base sm:text-lg font-bold text-foreground tracking-tight">
          {sectionName ? `${sectionName}: ` : ''}{t('license.sectionRequiresSubscription' as Parameters<typeof t>[0])}
        </h2>
        <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 p-3 text-start text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{t('license.noCloudBackupWarning' as Parameters<typeof t>[0])}</p>
        </div>
        <Button className="w-full" onClick={() => navigate('/renew')}>
          {t('license.viewPlans' as Parameters<typeof t>[0])}
        </Button>
      </div>
    </div>
  );
}

export default SubscriptionLockNotice;
