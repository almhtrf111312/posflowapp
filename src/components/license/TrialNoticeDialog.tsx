import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useLanguage } from '@/hooks/use-language';

interface TrialNoticeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

const TRIAL_NOTICE_POINT_KEYS = [
  'license.trialPoint1',
  'license.trialPoint2',
  'license.trialPoint3',
  'license.trialPoint4',
  'license.trialPoint5',
] as const;

export function TrialNoticeDialog({ open, onOpenChange, onConfirm }: TrialNoticeDialogProps) {
  const { t, direction } = useLanguage();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent dir={direction}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('license.trialNoticeTitle' as Parameters<typeof t>[0])}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('license.trialNoticeDesc' as Parameters<typeof t>[0])}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="list-disc space-y-2 ps-5 text-sm text-muted-foreground">
          {TRIAL_NOTICE_POINT_KEYS.map((key) => (
            <li key={key}>{t(key as Parameters<typeof t>[0])}</li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t('license.trialUnderstandStart' as Parameters<typeof t>[0])}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
