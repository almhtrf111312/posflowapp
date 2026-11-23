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
        <h2 className="text-lg font-bold">
          {sectionName ? `${sectionName}: ` : ''}{t('license.sectionRequiresSubscription' as any)}
        </h2>
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-start text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{t('license.noCloudBackupWarning' as any)}</p>
        </div>
        <Button className="w-full" onClick={() => navigate('/renew')}>
          {t('license.viewPlans' as any)}
        </Button>
      </div>
    </div>
  );
}

export default SubscriptionLockNotice;
