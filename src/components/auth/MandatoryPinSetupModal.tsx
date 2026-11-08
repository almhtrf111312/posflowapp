import React, { useState } from 'react';
import { useAppLock } from '@/hooks/use-app-lock';
import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { ShieldAlert, KeyRound, Eye, EyeOff, Loader2, LogOut, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

export function MandatoryPinSetupModal() {
  const { requiresPinSetup, completePinSetup } = useAppLock();
  const { user, signOut } = useAuth();
  const { isRTL } = useLanguage();

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
      setErrorMsg(isRTL ? 'رمز PIN يجب أن يتكون من 4 إلى 8 أرقام' : 'PIN must be between 4 and 8 digits');
      return;
    }

    if (cleanPin !== cleanConfirm) {
      setErrorMsg(isRTL ? 'تأكيد الرمز غير متطابق' : 'PIN confirmation does not match');
      return;
    }

    setIsSaving(true);
    try {
      const success = await completePinSetup(cleanPin);
      if (success) {
        toast.success(isRTL ? 'تم حفظ وتفعيل رمز الأمان الجديد بنجاح' : 'New security PIN set successfully');
      } else {
        setErrorMsg(isRTL ? 'فشل حفظ الرمز، يرجى المحاولة مجدداً' : 'Failed to save PIN, please try again');
      }
    } catch (err: any) {
      console.error('[MandatoryPinSetupModal] Error:', err);
      setErrorMsg(isRTL ? 'حدث خطأ غير متوقع' : 'An unexpected error occurred');
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
          <div className="relative flex items-center justify-center w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-500 shadow-inner">
            <ShieldAlert className="w-8 h-8 animate-pulse" />
            <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-primary border-2 border-background flex items-center justify-center">
              <KeyRound className="w-3 h-3 text-white" />
            </div>
          </div>

          <h2 className="text-lg font-bold text-foreground">
            {isRTL ? 'تعيين رمز حماية جديد لنقطة البيع' : 'Set New POS Security PIN'}
          </h2>

          <p className="text-xs text-muted-foreground leading-relaxed max-w-sm">
            {isRTL
              ? 'أهلاً بك مجدداً. نظراً لأنك سجلت الدخول بكلمة المرور الرئيسية بعد نسيان رمز الأمان، يرجى تعيين رمز PIN جديد (من 4 إلى 8 أرقام) لإعادة تفعيل حماية التطبيق وتأمين نقطة البيع فوراً.'
              : 'Welcome back! Since you logged in with your master credentials after forgetting your PIN, please set a new PIN (4 to 8 digits) to secure your POS terminal immediately.'}
          </p>
        </div>

        {/* نموذج إدخال الرمز الجديد والتأكيد */}
        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-foreground">
              {isRTL ? 'رمز PIN الجديد (4 - 8 أرقام)' : 'New PIN (4 - 8 digits)'}
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
                className="pe-10 font-mono tracking-widest text-center text-lg h-12 rounded-xl"
                dir="ltr"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPin(!showPin)}
                className="absolute top-1/2 -translate-y-1/2 end-3 text-muted-foreground hover:text-foreground"
              >
                {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-foreground">
              {isRTL ? 'تأكيد رمز PIN الجديد' : 'Confirm New PIN'}
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
                  <span>{isRTL ? 'جاري حفظ الرمز وتأمين التطبيق...' : 'Securing Terminal...'}</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  <span>{isRTL ? 'حفظ وتفعيل رمز الحماية الجديد' : 'Save & Secure Terminal'}</span>
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
              <span>{isRTL ? 'تسجيل الخروج والتبديل' : 'Sign Out & Switch Account'}</span>
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
