import { isLocalDataMode } from '@/hooks/use-network-status';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertTriangle, Trash2, Loader2, CheckCircle } from 'lucide-react';
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
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/auth-context';
import { clearAllDataCompletely } from '@/lib/clear-demo-data';
import { toast } from '@/lib/sonner-bridge';
import { t } from '@/lib/i18n';
import { useLanguage } from '@/hooks/language-context';

// KD-08: the owner waits this long after entering the password before the final button is enabled
const RESET_COUNTDOWN_SECONDS = 10;

export default function DataResetSection() {
  const { language } = useLanguage();
  const { user } = useAuth();
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [password, setPassword] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'password' | 'countdown'>('password');
  const [countdown, setCountdown] = useState(RESET_COUNTDOWN_SECONDS);

  useEffect(() => {
    if (step !== 'countdown' || countdown <= 0) return;
    const id = window.setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => window.clearTimeout(id);
  }, [step, countdown]);

  const dataToBeDeleted = [
    t('common.invoices', language),
    t('common.customers', language),
    t('common.debts', language),
    t('common.expenses', language),
    t('common.partners', language),
    t('common.services', language),
  ];

  const handleResetClick = () => {
    setShowConfirmDialog(true);
    setPassword('');
    setError('');
    setStep('password');
    setCountdown(RESET_COUNTDOWN_SECONDS);
  };

  const handleConfirmReset = async () => {
    if (!user?.email) {
      setError(t('settings.loginRequired', language));
      return;
    }

    setIsVerifying(true);
    setError('');

    try {
      // Verify password by attempting to sign in
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: password,
      });

      if (signInError) {
        setError(t('settings.wrongPassword', language));
        setIsVerifying(false);
        return;
      }

      // Password verified: start the countdown. The wipe runs only from the final button, after the backup.
      setStep('countdown');
      setCountdown(RESET_COUNTDOWN_SECONDS);
    } catch (err) {
      console.error('Reset error:', err);
      setError(t('settings.resetDataFailed', language));
    } finally {
      setIsVerifying(false);
    }
  };

  const handleExecuteReset = async () => {
    if (isLocalDataMode()) {
      setError(t('settings.resetNeedsOnline', language));
      return;
    }

    setIsVerifying(true);
    setError('');

    try {
      // 1. Save a backup on this device right before the wipe. If it cannot be saved, nothing is deleted.
      const { buildFullBackup, backupFileName } = await import('@/lib/full-backup');
      const { downloadFile } = await import('@/lib/file-download');
      const backup = await buildFullBackup();
      const saved = await downloadFile({
        filename: backupFileName(),
        content: JSON.stringify(backup),
        mimeType: 'application/json',
      });
      if (!saved.success) {
        setError(t('settings.resetBackupFailed', language));
        return;
      }

      // 2. Cloud first (server confirms), then this device
      const success = await clearAllDataCompletely();
      if (!success) {
        setError(t('settings.resetDataFailed', language));
        return;
      }

      setShowConfirmDialog(false);
      toast.success(t('settings.resetDataSuccess', language) || 'تمت إعادة ضبط وحذف كافة البيانات بنجاح', {
        icon: <CheckCircle className="h-5 w-5 text-green-500" />,
        description: t('settings.resetBackupSavedNote', language),
      });

      setTimeout(() => {
        window.location.href = '/';
      }, 1200);
    } catch (err) {
      console.error('Reset error:', err);
      setError(t('settings.resetDataFailed', language));
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Warning Card */}
      <Card className="border-destructive/50 bg-destructive/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            {t('settings.resetDataWarning', language)}
          </CardTitle>
          <CardDescription className="text-destructive/80">
            {t('settings.resetDataDescription', language)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <h4 className="font-medium mb-2">{t('settings.dataToBeDeleted', language)}:</h4>
              <ul className="grid grid-cols-2 gap-2 text-sm text-muted-foreground">
                {dataToBeDeleted.map((item, index) => (
                  <li key={index} className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            
            <div className="pt-4 border-t">
              <Button 
                variant="destructive" 
                onClick={handleResetClick}
                className="w-full sm:w-auto"
              >
                <Trash2 className="h-4 w-4" />
                {t('settings.resetAllData', language)}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Confirmation Dialog */}
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              {t('settings.resetDataConfirm', language)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.resetDataConfirmDescription', language)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          
          <div className="space-y-4 py-4">
            {step === 'password' ? (
              <div className="space-y-2">
                <Label htmlFor="password">
                  {t('settings.enterPasswordToConfirm', language)}
                </Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  disabled={isVerifying}
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {countdown > 0
                  ? t('settings.resetCountdownHint', language).replace('{n}', String(countdown))
                  : t('settings.resetReadyHint', language)}
              </p>
            )}
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isVerifying}>
              {t('common.cancel', language)}
            </AlertDialogCancel>
            {step === 'password' ? (
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleConfirmReset();
              }}
              disabled={!password || isVerifying}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isVerifying ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('settings.verifying', language)}
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4" />
                  {t('settings.confirmReset', language)}
                </>
              )}
            </AlertDialogAction>
            ) : (
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleExecuteReset();
              }}
              disabled={countdown > 0 || isVerifying}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isVerifying ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('settings.verifying', language)}
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4" />
                  {t('settings.resetFinalButton', language)}
                </>
              )}
            </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
