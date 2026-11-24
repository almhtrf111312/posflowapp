import React, { useState } from 'react';
import { useAppLock } from '@/hooks/use-app-lock';
import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { ShieldAlert, KeyRound, Eye, EyeOff, Loader2, LogOut, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/lib/sonner-bridge';

export function MandatoryPinSetupModal() {
  const { requiresPinSetup, completePinSetup } = useAppLock();
  const { user, signOut } = useAuth();
  const { t, isRTL } = useLanguage();

  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!requiresPinSetup || !user) {
    return null;
  }

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setErrorMsg(null);

    const cleanPin = newPin.trim();
    const cleanConfirm = confirmPin.trim();

    if (cleanPin.length < 4 || cleanPin.length > 8) {
      setErrorMsg(t('pinSetup.lengthError'));
      return;
    }

    if (cleanPin !== cleanConfirm) {
      setErrorMsg(t('pinSetup.mismatch'));
      return;
    }

    setIsSaving(true);
    try {
      const success = await completePinSetup(cleanPin);
      if (success) {
        toast.success(t('pinSetup.success'));
      } else {
        setErrorMsg(t('pinSetup.saveFailed'));
      }
    } catch (err: unknown) {
      console.error('[MandatoryPinSetupModal] Error:', err);
      setErrorMsg(t('pinSetup.unexpectedError'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[10000] bg-black/85 backdrop-blur-md flex items-center justify-center p-4 select-none touch-manipulation animate-in fade-in duration-200"
      style={{ direction: isRTL ? 'rtl' : 'ltr' }}
    >
      <div className="bg-card border border-border/80 rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-5 animate-in zoom-in-95 duration-150">
        {/* رأس البطاقة الترحيبي والأمني */}
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="relative flex items-center justify-center w-16 h-16 rounded-2xl bg-warning/10 border border-warning/30 text-warning shadow-inner">
            <ShieldAlert className="w-8 h-8 animate-pulse" />
            <div className="absolute -bottom-1 -end-1 w-5 h-5 rounded-full bg-primary border-2 border-background flex items-center justify-center">
              <KeyRound className="w-3 h-3 text-primary-foreground" />
            </div>
          </div>

          <h2 className="text-lg font-bold text-foreground">
            {t('pinSetup.title')}
          </h2>

          <p className="text-xs text-muted-foreground leading-relaxed max-w-sm">
            {t('pinSetup.description')}
          </p>
        </div>

        {/* نموذج إدخال الرمز الجديد والتأكيد */}
        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-foreground">
              {t('pinSetup.newPinLabel')}
            </Label>
            <div className="relative">
              <Input
                type={showPin ? 'text' : 'password'}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={8}
                value={newPin}
                onChange={(e) => {
                  setErrorMsg(null);
                  setNewPin(e.target.value.replace(/[^0-9]/g, ''));
                }}
                placeholder="••••"
                className="pe-12 font-mono tracking-widest text-center text-lg h-12 rounded-xl"
                dir="ltr"
                autoFocus
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('pinSetup.newPinLabel')}
                onClick={() => setShowPin(!showPin)}
                className="absolute top-1/2 -translate-y-1/2 end-1 text-muted-foreground hover:text-foreground"
              >
                {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-foreground">
              {t('pinSetup.confirmPinLabel')}
            </Label>
            <Input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={8}
              value={confirmPin}
              onChange={(e) => {
                setErrorMsg(null);
                setConfirmPin(e.target.value.replace(/[^0-9]/g, ''));
              }}
              placeholder="••••"
              className="font-mono tracking-widest text-center text-lg h-12 rounded-xl"
              dir="ltr"
            />
          </div>

          {errorMsg && (
            <p className="text-xs text-destructive font-medium text-center animate-in fade-in duration-150">
              {errorMsg}
            </p>
          )}

          {/* أزرار الإجراء */}
          <div className="space-y-2 pt-2">
            <Button
              type="submit"
              disabled={isSaving || newPin.length < 4 || confirmPin.length < 4}
              className="w-full h-12 rounded-xl text-xs font-bold bg-primary text-primary-foreground shadow-md flex items-center justify-center gap-2"
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{t('pinSetup.saving')}</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  <span>{t('pinSetup.saveBtn')}</span>
                </>
              )}
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void signOut()}
              className="w-full text-xs text-muted-foreground hover:text-destructive rounded-xl flex items-center justify-center gap-1.5"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>{t('pinSetup.signOutSwitch')}</span>
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
